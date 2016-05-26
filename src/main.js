#!/usr/bin/env node

let debugModule = require('debug');
let debug = debugModule('aws-provisioner:main');
let aws = require('aws-sdk-promise');
let _ = require('lodash');
let path = require('path');

let taskcluster = require('taskcluster-client');
let base = require('taskcluster-base');

let workerType = require('./worker-type');
let secret = require('./secret');
let workerState = require('./worker-state');
let AwsManager = require('./aws-manager');
let provision = require('./provision');
let exchanges = require('./exchanges');
let v1 = require('./api-v1');
let series = require('./influx-series');

process.on('unhandledRejection', err => {
  debug('[alert-operator] UNHANDLED REJECTION!\n' + err.stack || err);
});

let load = base.loader({
  cfg: {
    requires: ['profile'],
    setup: ({profile}) => base.config(profile),
  },

  WorkerType: {
    requires: ['cfg'],
    setup: async ({cfg}) => {
      let WorkerType = workerType.setup({
        account: cfg.azure.account,
        table: cfg.app.workerTypeTableName,
        credentials: cfg.taskcluster.credentials,
        context: {
          keyPrefix: cfg.app.awsKeyPrefix,
          provisionerId: cfg.app.id,
          provisionerBaseUrl: cfg.server.publicUrl + '/v1',
          pubKey: cfg.app.awsInstancePubkey,
        },
      });
      return WorkerType;
    },
  },

  WorkerState: {
    requires: ['cfg'],
    setup: async ({cfg}) => {
      let WorkerState = workerState.setup({
        account: cfg.azure.account,
        table: cfg.app.workerStateTableName,
        credentials: cfg.taskcluster.credentials,
      });
      return WorkerState;
    },
  },

  Secret: {
    requires: ['cfg'],
    setup: async ({cfg}) => {
      let Secret = secret.setup({
        account: cfg.azure.account,
        table: cfg.app.secretTableName,
        credentials: cfg.taskcluster.credentials,
      });
      return Secret;
    },
  },

  validator: {
    requires: ['cfg'],
    setup: async ({cfg}) => {
      return await base.validator({
        prefix: 'aws-provisioner/v1/',
        aws: cfg.aws,
      });
    },
  },

  publisher: {
    requires: ['cfg', 'validator', 'influx'],
    setup: async ({cfg, validator, influx}) => {
      let publisher = await exchanges.setup({
        credentials: cfg.pulse,
        exchangePrefix: cfg.app.exchangePrefix,
        validator: validator,
        referencePrefix: 'aws-provisioner/v1/exchanges.json',
        publish: cfg.app.publishMetaData === 'true',
        aws: cfg.aws,
        drain: influx,
        component: cfg.app.statsComponent,
        process: 'server',
      });

      return publisher;
    },
  },

  ec2: {
    requires: ['cfg', 'process'],
    setup: async ({cfg, process}) => {
      let ec2 = {};
      for (let region of cfg.app.allowedRegions.split(',')) {
        let ec2conf = cfg.aws;
        ec2conf.region = region;
        let s3Debugger = debugModule('aws-sdk:' + process);
        let awsDebugLoggerBridge = {
          write: x => {
            for (let y of x.split('\n')) {
              s3Debugger(y);
            }
          },
        };
        ec2conf.logger = awsDebugLoggerBridge;
        ec2[region] = new aws.EC2(ec2conf);
      }

      return ec2;
    },
  },

  api: {
    requires: ['cfg', 'WorkerType', 'WorkerState', 'Secret', 'ec2', 'validator', 'publisher', 'influx'],
    setup: async ({cfg, WorkerType, WorkerState, Secret, ec2, validator, publisher, influx}) => {
      let reportInstanceStarted = series.instanceStarted.reporter(influx);

      let router = await v1.setup({
        context: {
          WorkerType: WorkerType,
          WorkerState: WorkerState,
          Secret: Secret,
          publisher: publisher,
          keyPrefix: cfg.app.awsKeyPrefix,
          pubKey: cfg.app.awsInstancePubkey,
          provisionerId: cfg.app.id,
          provisionerBaseUrl: cfg.server.publicUrl + '/v1',
          reportInstanceStarted: reportInstanceStarted,
          credentials: cfg.taskcluster.credentials,
          dmsApiKey: cfg.deadmanssnitch.api.key,
          iterationSnitch: cfg.deadmanssnitch.iterationSnitch,
          ec2: ec2,
        },
        validator: validator,
        authBaseUrl: cfg.taskcluster.authBaseUrl,
        publish: cfg.app.publishMetaData === 'true',
        baseUrl: cfg.server.publicUrl + '/v1',
        referencePrefix: 'aws-provisioner/v1/api.json',
        aws: cfg.aws,
        component: cfg.app.statsComponent,
        drain: influx,
      });

      return router; 
    },
  },

  // API Client for *this* working copy of the repo
  apiClient: {
    requires: ['cfg'],
    setup: ({cfg}) => {
      let baseUrl = cfg.server.publicUrl + '/v1';
      let reference = v1.reference({baseUrl});
      let clientClass = taskcluster.createClient(reference);
      return new clientClass({
        agent: require('http').globalAgent,
        baseUrl: baseUrl,
        credentials: cfg.taskcluster.credentials,
      });
    },
  },

  // Table Cleaner for testing
  tableCleaner: {
    requires: ['WorkerType', 'WorkerState', 'Secret'],
    setup: async ({WorkerType, WorkerState, Secret}) => {
      await Promise.all([
        WorkerType.scan({}, {
          handler: async (x) => { await x.remove(); },
        }),
        WorkerState.scan({}, {
          handler: async (x) => { await x.remove(); },
        }),
        Secret.scan({}, {
          handler: async (x) => { await x.remove(); },
        }),
      ]);
      return true;
    },
  },

  server: {
    requires: ['cfg', 'api'],
    setup: ({cfg, api}) => {
      let app = base.app(cfg.server);
      app.use('/v1', api);
      return app.createServer();
    },
  },

  influx: {
    requires: ['cfg'],
    setup: ({cfg}) => {
      return new base.stats.Influx({
        connectionString: cfg.influx.connectionString,
        maxDelay: cfg.influx.maxDelay,
        maxPendingPoints: cfg.influx.maxPendingPoints,
      });
    },
  },

  awsManager: {
    requires: ['cfg', 'ec2', 'influx'],
    setup: ({cfg, ec2, influx}) => {
      return new AwsManager(
        ec2,
        cfg.app.id,
        cfg.app.awsKeyPrefix,
        cfg.app.awsInstancePubkey,
        cfg.app.maxInstanceLife,
        influx
      );
    },
  },

  provisioner: {
    requires: ['cfg', 'awsManager', 'WorkerType', 'WorkerState', 'Secret', 'ec2', 'influx'],
    setup: async ({cfg, awsManager, WorkerType, WorkerState, Secret, ec2, influx}) => {
      let queue = new taskcluster.Queue({credentials: cfg.taskcluster.credentials});

      let provisioner = new provision.Provisioner({
        WorkerType: WorkerType,
        Secret: Secret,
        WorkerState: WorkerState,
        queue: queue,
        provisionerId: cfg.app.id,
        taskcluster: cfg.taskcluster,
        influx: influx,
        awsManager: awsManager,
        provisionIterationInterval: cfg.app.iterationInterval,
        dmsApiKey: cfg.deadmanssnitch.api.key,
        iterationSnitch: cfg.deadmanssnitch.iterationSnitch,
      });

      try {
        provisioner.run();
      } catch (err) {
        debug('[alert-operator] Error: ' + err.stack || err);
      }
      
      return provisioner;
    },
  },

}, ['profile', 'process']);

// If this file is executed launch component from first argument
if (!module.parent) {
  require('source-map-support').install();
  load(process.argv[2], {
    process: process.argv[2],
    profile: process.env.NODE_ENV,
  }).catch(err => {
    console.log(err.stack);
    process.exit(1);
  });
}

// Export load for tests
module.exports = load;
