#!/usr/bin/env node

let log = require('./log');
let aws = require('aws-sdk');
let _ = require('lodash');
let path = require('path');
let fs = require('mz/fs');
let request = require('request-promise');

let loader = require('taskcluster-lib-loader');
let taskcluster = require('taskcluster-client');
let config = require('typed-env-config');
let libMonitor = require('taskcluster-lib-monitor');
let libValidator = require('taskcluster-lib-validate');
let libApp = require('taskcluster-lib-app');
let stats = require('taskcluster-lib-stats');
let docs = require('taskcluster-lib-docs');
let Iterate = require('taskcluster-lib-iterate');
let azure = require('azure-storage');
let DataContainer = require('azure-blob-storage-temp-fork').default;

let workerType = require('./worker-type');
let secret = require('./secret');
let AwsManager = require('./aws-manager');
let provision = require('./provision');
let exchanges = require('./exchanges');
let v1 = require('./api-v1');
let Container = require('./container');

process.on('unhandledRejection', err => {
  log.fatal({err}, '[alert-operator] UNHANDLED REJECTION!');
  /* XXX SOOON!
  process.nextTick(() => {
    throw err;
  });
  */
});

let load = loader({
  cfg: {
    requires: ['profile'],
    setup: ({profile}) => config({profile}),
  },

  stateContainer: {
    requires: ['cfg', 'profile'],
    setup: async ({cfg, profile}) => {
      // Azure Storage doesn't have promises, but we're using it in so few
      // places it doesn't make sense to write a full promise wrapper.
      // Instead, we'll just wrap as needed.
      // TODO: Use ExponentialRetryPolicyFilter
      let container = `worker-state-${profile}`;
      return Container(cfg.azureBlob.accountName, cfg.azureBlob.accountKey, container);
    },
  },

  stateNewContainer: {
    requires: ['cfg', 'profile'],
    setup: async ({cfg, profile}) => {
      let container = `worker-state-${profile}`;
      let schema = await fs.readFile(`${__dirname}/../schemas/state-definition.json`, 'utf8');
      let schemaObj = JSON.parse(schema);
      let options = {
        account: cfg.azureBlob.accountName,
        credentials: cfg.taskcluster.credentials,
        container: container,
        schema: schemaObj,
      };
      let dataContainer = await DataContainer(options);
      return dataContainer;
    },
  },

  monitor: {
    requires: ['process', 'profile', 'cfg'],
    setup: ({process, profile, cfg}) => libMonitor({
      project: cfg.monitor.project,
      credentials: cfg.taskcluster.credentials,
      mock: cfg.monitor.mock,
      process,
    }),
  },

  WorkerType: {
    requires: ['cfg'],
    setup: async ({cfg}) => {
      let WorkerType = workerType.setup({
        account: cfg.azure.account,
        table: cfg.app.workerTypeTableName,
        signingKey: cfg.app.tableSigningKey,
        cryptoKey: cfg.app.tableCryptoKey,
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

  Secret: {
    requires: ['cfg'],
    setup: async ({cfg}) => {
      let Secret = secret.setup({
        account: cfg.azure.account,
        table: cfg.app.secretTableName,
        signingKey: cfg.app.tableSigningKey,
        cryptoKey: cfg.app.tableCryptoKey,
        credentials: cfg.taskcluster.credentials,
      });
      return Secret;
    },
  },

  validator: {
    requires: ['cfg'],
    setup: async ({cfg}) => {
      return await libValidator({
        prefix: 'aws-provisioner/v1/',
        aws: cfg.aws,
      });
    },
  },

  docs: {
    requires: ['cfg', 'validator'],
    setup: ({cfg, validator}) => {
      let reference = exchanges.reference({
        exchangePrefix:   cfg.app.exchangePrefix,
        credentials:      cfg.pulse,
      });
      return docs.documenter({
        credentials: cfg.taskcluster.credentials,
        tier: 'integrations',
        schemas: validator.schemas,
        project: 'aws-provisioner',
        references: [
          {
            name: 'api',
            reference: v1.reference({baseUrl: cfg.server.publicUrl + '/v1'}),
          }, {
            name: 'events',
            reference: reference,
          },
        ],
      });
    },
  },

  publisher: {
    requires: ['cfg', 'validator', 'monitor'],
    setup: async ({cfg, validator, monitor}) => {
      let publisher = await exchanges.setup({
        credentials: cfg.pulse,
        exchangePrefix: cfg.app.exchangePrefix,
        validator: validator,
        referencePrefix: 'aws-provisioner/v1/exchanges.json',
        publish: cfg.app.publishMetaData,
        aws: cfg.aws,
        monitor: monitor.prefix('publisher'),
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
        let ec2log = log.child({
          region,
          ec2log: true, // for doing things like bunyan -c "!this.ec2log"
        });
        let awsDebugLoggerBridge = {
          write: x => {
            for (let y of x.split('\n')) {
              ec2log.info(y);
            }
          },
        };
        //ec2conf.logger = awsDebugLoggerBridge;
        ec2[region] = new aws.EC2(ec2conf);
      }

      return ec2;
    },
  },

  api: {
    requires: ['cfg', 'awsManager', 'WorkerType', 'Secret', 'ec2', 'stateContainer', 'stateNewContainer', 'validator',
      'publisher', 'monitor'],
    setup: async ({cfg, awsManager, WorkerType, Secret, ec2, stateContainer, stateNewContainer, validator,
                   publisher, monitor}) => {

      let router = await v1.setup({
        context: {
          WorkerType: WorkerType,
          Secret: Secret,
          publisher: publisher,
          keyPrefix: cfg.app.awsKeyPrefix,
          pubKey: cfg.app.awsInstancePubkey,
          provisionerId: cfg.app.id,
          provisionerBaseUrl: cfg.server.publicUrl + '/v1',
          credentials: cfg.taskcluster.credentials,
          dmsApiKey: cfg.deadmanssnitch.api.key,
          iterationSnitch: cfg.deadmanssnitch.iterationSnitch,
          ec2: ec2,
          stateContainer: stateContainer,
          stateNewContainer: stateNewContainer,
          awsManager: awsManager,
        },
        validator: validator,
        authBaseUrl: cfg.taskcluster.authBaseUrl,
        publish: cfg.app.publishMetaData,
        baseUrl: cfg.server.publicUrl + '/v1',
        referencePrefix: 'aws-provisioner/v1/api.json',
        aws: cfg.aws,
        monitor: monitor.prefix('api'),
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
    requires: ['WorkerType', 'Secret'],
    setup: async ({WorkerType, Secret}) => {
      await Promise.all([
        WorkerType.scan({}, {
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
    requires: ['cfg', 'api', 'docs'],
    setup: ({cfg, api, docs}) => {
      let app = libApp(cfg.server);
      app.use('/v1', api);
      return app.createServer();
    },
  },

  awsManager: {
    requires: ['cfg', 'ec2', 'monitor', 'ec2manager'],
    setup: ({cfg, ec2, monitor, ec2manager}) => {
      return new AwsManager(
        ec2,
        cfg.app.id,
        monitor.prefix('awsManager'),
        ec2manager,
        cfg.app.awsKeyPrefix,
        cfg.app.awsInstancePubkey,
      );
    },
  },

  provisioner: {
    requires: [
      'cfg',
      'awsManager',
      'ec2manager',
      'WorkerType',
      'Secret',
      'ec2',
      'stateContainer',
      'stateNewContainer',
      'monitor',
    ],
    setup: async ({cfg, awsManager, ec2manager, WorkerType, Secret, ec2, stateContainer, stateNewContainer, monitor}) => {
      let queue = new taskcluster.Queue({credentials: cfg.taskcluster.credentials});

      let provisioner = new provision.Provisioner({
        WorkerType: WorkerType,
        Secret: Secret,
        queue: queue,
        provisionerId: cfg.app.id,
        taskcluster: cfg.taskcluster,
        awsManager: awsManager,
        ec2manager: ec2manager,
        stateContainer: stateContainer,
        stateNewContainer: stateNewContainer,
        monitor: monitor,
      });

      let i = new Iterate({
        maxIterationTime: 1000 * 60 * 15, // 15 minutes
        watchDog: 1000 * 60 * 15, // 15 minutes
        maxFailures: 10,
        waitTime: cfg.app.iterationInterval,
        dmsConfig: {
          apiKey: cfg.deadmanssnitch.api.key,
          snitchUrl: cfg.deadmanssnitch.iterationSnitch,
        },
        handler: async (watchdog, state) => {
          // Store the stats somewhere
          if (!state.stats) {
            state.stats = {
              runs: 0,
              consecFail: 0,
              overallFail: 0,
            };
          }

          state.stats.runs++;
          log.info('provisioning iteration starting');
          try {
            await provisioner.provision();
            state.stats.consecFail = 0;
          } catch (err) {
            state.stats.consecFail++;
            state.stats.overallFail++;
            log.warn(err, 'provisioning iteration failed');
            monitor.reportError(err, 'warning', {iterationFailure: true});
            throw err;
          }
        },
      });

      return new Promise((res, rej) => {
        i.on('started', () => {
          res({
            provisioner,
            iterate: i,
          });
        });

        i.on('error', err => {
          // We're pretty certain that a lib-iterate error is going to be an
          // array of errors, but let's handle the case that the api changes to
          // a more general one
          if (Array.isArray(err)) {
            for (let x of err) {
              log.error(x, 'contributing error');
              if (err.requestId) {
                log.error({requestId: err.requestId}, 'contributing error request id');
              }
              if (err.code) {
                monitor.count(`errors.${err.code}`);
              } else {
                monitor.count('errors.unknown-error');
              }
              monitor.count('errors-all');
            }
            log.fatal('fatal error, exiting');
          } else {
            log.fatal(err, 'fatal error, exiting');
          }
          process.exit(1);
          // Call the rejection method to be complete and in case someone's
          // overwriting the process.exit method
          rej();
        });

        i.start();
      });
    },
  },

  ec2manager: {
    requires: ['cfg'],
    setup: async ({cfg}) => {
      let ec2ManagerBaseUrl = cfg.ec2manager.baseUrl;

      let reference = await request.get(ec2ManagerBaseUrl + '/internal/api-reference');
      reference = JSON.parse(reference);

      let clientClass = taskcluster.createClient(reference);

      let client = new clientClass({
        agent: require('http').globalAgent,
        baseUrl: ec2ManagerBaseUrl,
        credentials: cfg.taskcluster.credentials,
        timeout: 2 * 1000,
      });

      return client;
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
