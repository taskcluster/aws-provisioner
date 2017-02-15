#!/usr/bin/env node

let log = require('./log');
let aws = require('aws-sdk');
let _ = require('lodash');
let path = require('path');

let taskcluster = require('taskcluster-client');
let base = require('taskcluster-base');
let docs = require('taskcluster-lib-docs');
let Iterate = require('taskcluster-lib-iterate');
let azure = require('azure-storage');

let workerType = require('./worker-type');
let secret = require('./secret');
let amiSet = require('./ami-set');
let AwsManager = require('./aws-manager');
let provision = require('./provision');
let exchanges = require('./exchanges');
let v1 = require('./api-v1');
let series = require('./influx-series');
let Container = require('./container');

process.on('unhandledRejection', err => {
  log.fatal({err}, '[alert-operator] UNHANDLED REJECTION!');
  /* XXX SOOON!
  process.nextTick(() => {
    throw err;
  });
  */
});

let load = base.loader({
  cfg: {
    requires: ['profile'],
    setup: ({profile}) => base.config({profile}),
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

  monitor: {
    requires: ['process', 'profile', 'cfg'],
    setup: ({process, profile, cfg}) => base.monitor({
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
      return await base.validator({
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
        tier: 'core',
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
    requires: ['cfg', 'awsManager', 'WorkerType', 'AmiSet', 'Secret', 'ec2', 'stateContainer', 'validator',
               'publisher', 'influx', 'monitor'],
    setup: async ({cfg, awsManager, WorkerType, AmiSet, Secret, ec2, stateContainer, validator,
                   publisher, influx, monitor}) => {

      let reportInstanceStarted = series.instanceStarted.reporter(influx);

      let router = await v1.setup({
        context: {
          WorkerType: WorkerType,
          AmiSet: AmiSet,
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
          stateContainer: stateContainer,
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
    requires: ['cfg', 'api', 'docs'],
    setup: ({cfg, api, docs}) => {
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
    requires: ['cfg', 'ec2', 'influx', 'monitor'],
    setup: ({cfg, ec2, influx, monitor}) => {
      return new AwsManager(
        ec2,
        cfg.app.id,
        cfg.app.awsKeyPrefix,
        cfg.app.awsInstancePubkey,
        cfg.app.maxInstanceLife,
        influx,
        monitor.prefix('awsManager')
      );
    },
  },

  provisioner: {
    requires: ['cfg', 'awsManager', 'WorkerType', 'Secret', 'ec2', 'stateContainer', 'influx', 'monitor'],
    setup: async ({cfg, awsManager, WorkerType, Secret, ec2, stateContainer, influx, monitor}) => {
      let queue = new taskcluster.Queue({credentials: cfg.taskcluster.credentials});

      let provisioner = new provision.Provisioner({
        WorkerType: WorkerType,
        Secret: Secret,
        queue: queue,
        provisionerId: cfg.app.id,
        taskcluster: cfg.taskcluster,
        influx: influx,
        awsManager: awsManager,
        stateContainer: stateContainer,
      });

      let i = new Iterate({
        maxIterationTime: 1000 * 60 * 15, // 15 minutes
        watchDog: 1000 * 60 * 15, // 15 minutes
        maxFailures: 1,
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
            }
            log.fatal('fatal error, exiting');
          } else {
            log.fatal(err, 'fatal error, exiting');
          }
          // Leave this here as it's a likely place that we'll all want to drop
          // into the debugger
          debugger;
          process.exit(1);
          // Call the rejection method to be complete and in case someone's
          // overwriting the process.exit method
          rej();
        });

        i.start();
      });
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
