#!/usr/bin/env node

let log = require('./log');
let debugModule = log.debugCompat;
let debug = log.debugCompat('aws-provisioner:main');
let aws = require('aws-sdk-promise');
let _ = require('lodash');
let path = require('path');

let taskcluster = require('taskcluster-client');
let base = require('taskcluster-base');

let workerType = require('./worker-type');
let secret = require('./secret');
let amiSet = require('./ami-set');
let AwsManager = require('./aws-manager');
let provision = require('./provision');
let exchanges = require('./exchanges');
let v1 = require('./api-v1');
let series = require('./influx-series');
let azure = require('azure-storage');
let Container = require('./container');

process.on('unhandledRejection', err => {
  debug('[alert-operator] UNHANDLED REJECTION!\n' + err.stack || err);
});

let load = base.loader({
  cfg: {
    requires: ['profile'],
    setup: ({profile}) => base.config(profile),
  },

  spotRequestContainer: {
    requires: ['cfg', 'profile'],
    setup: async ({cfg, profile}) => {
      // Azure Storage doesn't have promises, but we're using it in so few
      // places it doesn't make sense to write a full promise wrapper.
      // Instead, we'll just wrap as needed.
      // TODO: Use ExponentialRetryPolicyFilter
      let containerName = `spot-requests-${profile}`;
      let container = await Container(cfg.azureBlob.accountName, cfg.azureBlob.accountKey, containerName);
      return container;
    },
  },

  srcontclean: {
    requires: ['spotRequestContainer'],
    setup: async ({spotRequestContainer}) => {
      await spotRequestContainer.remove('spot-requests');
    },
  },

  stateContainer: {
    requires: ['cfg', 'profile'],
    setup: async ({cfg, profile}) => {
      // Azure Storage doesn't have promises, but we're using it in so few
      // places it doesn't make sense to write a full promise wrapper.
      // Instead, we'll just wrap as needed.
      // TODO: Use ExponentialRetryPolicyFilter
      let containerName = `worker-state-${profile}`;
      let container = await Container(cfg.azureBlob.accountName, cfg.azureBlob.accountKey, containerName);
      return container;
    },
  },

  WorkerType: {
    requires: ['cfg'],
    setup: async ({cfg}) => {
      let WorkerType = workerType.setup({
        account: cfg.azure.account,
        table: cfg.app.workerTypeTableName,
        credentials: cfg.taskcluster.credentials,
        context: {
          provisionerId: cfg.app.id,
          provisionerBaseUrl: cfg.server.publicUrl + '/v1',
        },
      });
      return WorkerType;
    },
  },

  AmiSet: {
    requires: ['cfg'],
    setup: async ({cfg}) => {
      let AmiSet = amiSet.setup({
        account: cfg.azure.account,
        table: cfg.app.amiSetTableName,
        credentials: cfg.taskcluster.credentials,
      });
      return AmiSet;
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
        publish: cfg.app.publishMetaData,
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
      for (let region of cfg.app.allowedRegions) {
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
    requires: ['cfg', 'awsManager', 'WorkerType', 'AmiSet', 'Secret', 'ec2', 'stateContainer', 'validator',
               'publisher', 'influx'],
    setup: async ({cfg, awsManager, WorkerType, AmiSet, Secret, ec2, stateContainer, validator,
                   publisher, influx}) => {

      let reportInstanceStarted = series.instanceStarted.reporter(influx);

      let router = await v1.setup({
        context: {
          WorkerType: WorkerType,
          AmiSet: AmiSet,
          Secret: Secret,
          publisher: publisher,
          provisionerId: cfg.app.id,
          provisionerBaseUrl: cfg.server.publicUrl + '/v1',
          reportInstanceStarted: reportInstanceStarted,
          credentials: cfg.taskcluster.credentials,
          dmsApiKey: cfg.deadmanssnitch.api.key,
          iterationSnitch: cfg.deadmanssnitch.iterationSnitch,
          ec2: ec2,
          stateContainer: stateContainer,
          awsManager: awsManager,
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
    requires: ['WorkerType', 'Secret', 'AmiSet'],
    setup: async ({WorkerType, Secret, AmiSet}) => {
      await Promise.all([
        WorkerType.scan({}, {
          handler: async (x) => { await x.remove(); },
        }),
        Secret.scan({}, {
          handler: async (x) => { await x.remove(); },
        }),
        AmiSet.scan({}, {
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
      if (cfg.influx.connectionString) {
        return new base.stats.Influx({
          connectionString: cfg.influx.connectionString,
          maxDelay: cfg.influx.maxDelay,
          maxPendingPoints: cfg.influx.maxPendingPoints,
        });
      } else {
        console.log('No influx.connectionString configured; not using influx');
        return new base.stats.NullDrain();
      }
    },
  },

  awsManager: {
    requires: ['cfg', 'ec2', 'influx', 'spotRequestContainer'],
    setup: async ({cfg, ec2, influx, spotRequestContainer}) => {
      let awsManager = new AwsManager(
        ec2,
        cfg.app.id,
        cfg.app.maxInstanceLife,
        spotRequestContainer,
        influx
      );
      await awsManager.init();
      return awsManager;
    },
  },

  provisioner: {
    requires: ['cfg', 'awsManager', 'WorkerType', 'Secret', 'ec2', 'stateContainer', 'influx'],
    setup: async ({cfg, awsManager, WorkerType, Secret, ec2, stateContainer, influx}) => {
      let queue = new taskcluster.Queue({credentials: cfg.taskcluster.credentials});

      let provisioner = new provision.Provisioner({
        WorkerType: WorkerType,
        Secret: Secret,
        queue: queue,
        provisionerId: cfg.app.id,
        taskcluster: cfg.taskcluster,
        influx: influx,
        awsManager: awsManager,
        provisionIterationInterval: cfg.app.iterationInterval,
        dmsApiKey: cfg.deadmanssnitch.api.key,
        iterationSnitch: cfg.deadmanssnitch.iterationSnitch,
        stateContainer: stateContainer,
      });

      try {
        provisioner.run();
      } catch (err) {
        debug('[alert-operator] Error: ' + err.stack || err);
      }

      return provisioner;
    },
  },

  all: {
    requires: ['provisioner', 'server'],
    setup: async ({provisioner, server}) => {
      await Promise.race([provisioner, server]);
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
