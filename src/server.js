#!/usr/bin/env node
let path = require('path');
let debugModule = require('debug');
let debug = debugModule('aws-provisioner:bin:server');
let base = require('taskcluster-base');
let Config = require('typed-env-config');
let workerType = require('../lib/worker-type');
let secret = require('../lib/secret');
let workerState = require('../lib/worker-state');
let exchanges = require('../lib/exchanges');
let v1 = require('../lib/api-v1');
let _ = require('lodash');
let series = require('../lib/influx-series');
let aws = require('aws-sdk-promise');
require('source-map-support').install();

process.on('unhandledRejection', err => {
  debug('[alert-operator] UNHANDLED REJECTION!\n' + err.stack || err);
});

/** Launch server */
let launch = async function (profile) {
  let config = Config(profile);

  let allowedRegions = config.app.allowedRegions.split(',');
  let keyPrefix = config.app.awsKeyPrefix;
  let pubKey = config.app.awsInstancePubkey;
  let provisionerId = config.app.id;
  let provisionerBaseUrl = config.server.publicUrl + '/v1';

  let influx = new base.stats.Influx({
    connectionString: config.influx.connectionString,
    maxDelay: config.influx.maxDelay,
    maxPendingPoints: config.influx.maxPendingPoints,
  });

  base.stats.startProcessUsageReporting({
    drain: influx,
    component: config.app.statsComponent,
    process: 'server',
  });

  let WorkerType = workerType.setup({
    table: config.app.workerTypeTableName,
    credentials: config.azure,
    context: {
      keyPrefix: keyPrefix,
      provisionerId: provisionerId,
      provisionerBaseUrl: provisionerBaseUrl,
      pubKey: pubKey,
    },
  });

  let WorkerState = workerState.setup({
    table: config.app.workerStateTableName,
    credentials: config.azure,
  });

  let Secret = secret.setup({
    table: config.app.secretTableName,
    credentials: config.azure,
  });

  await Promise.all([
    WorkerType.ensureTable(),
    WorkerState.ensureTable(),
    Secret.ensureTable(),
  ]);

  let validator = await base.validator({
    folder: path.join(__dirname, '..', 'schemas'),
    constants: require('../schemas/constants'),
    publish: config.app.publishMetaData === 'true',
    schemaPrefix: 'aws-provisioner/v1/',
    aws: config.aws,
  });

  let publisher = await exchanges.setup({
    credentials: config.pulse,
    exchangePrefix: config.app.exchangePrefix,
    validator: validator,
    referencePrefix: 'aws-provisioner/v1/exchanges.json',
    publish: config.app.publishMetaData === 'true',
    aws: config.aws,
    drain: influx,
    component: config.app.statsComponent,
    process: 'server',
  });

  let ec2 = {};
  for (let region of allowedRegions) {
    let ec2conf = config.aws;
    ec2conf.region = region;
    let s3Debugger = debugModule('aws-sdk:api');
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

  let reportInstanceStarted = series.instanceStarted.reporter(influx);

  // Create API router and publish reference if needed
  let router = await v1.setup({
    context: {
      WorkerType: WorkerType,
      WorkerState: WorkerState,
      Secret: Secret,
      publisher: publisher,
      keyPrefix: keyPrefix,
      pubKey: pubKey,
      provisionerId: provisionerId,
      provisionerBaseUrl: provisionerBaseUrl,
      reportInstanceStarted: reportInstanceStarted,
      credentials: config.taskcluster.credentials,
      dmsApiKey: config.deadmanssnitch.api.key,
      iterationSnitch: config.deadmanssnitch.iterationSnitch,
      ec2: ec2,
    },
    validator: validator,
    authBaseUrl: config.taskcluster.authBaseUrl,
    publish: config.app.publishMetaData === 'true',
    baseUrl: config.server.publicUrl + '/v1',
    referencePrefix: 'aws-provisioner/v1/api.json',
    aws: config.aws,
    component: config.app.statsComponent,
    drain: influx,
  });

  // Create app
  let app = base.app({
    port: Number(process.env.PORT || config.server.port),
    env: config.server.env,
    forceSSL: config.server.forceSSL,
    trustProxy: config.server.trustProxy,
  });

  // Mount API router
  app.use('/v1', router);

  // Create server
  return app.createServer();
};

// If server.js is executed start the server
if (!module.parent) {
  // Find configuration profile
  let profile_ = process.argv[2] || process.env.NODE_ENV;
  if (!profile_) {
    console.log('Usage: server.js [profile]');
    console.error('ERROR: No configuration profile is provided');
  }
  // Launch with given profile
  launch(profile_).then(function () {
    debug('launched server successfully');
  }).catch(function (err) {
    debug('failed to start server, err: %s, as JSON: %j', err, err, err.stack);
    // If we didn't launch the server we should crash
    throw new Error('failed to start server');
  });
}

// Export launch in-case anybody cares
module.exports = launch;
