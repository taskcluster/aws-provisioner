#!/usr/bin/env node
let path = require('path');
let debug = require('debug')('aws-provisioner:bin:server');
let base = require('taskcluster-base');
let workerType = require('../lib/worker-type');
let secret = require('../lib/secret');
let workerState = require('../lib/worker-state');
let exchanges = require('../lib/exchanges');
let v1 = require('../lib/routes/v1');
let Aws = require('multi-region-promised-aws');
let _ = require('lodash');
let series = require('../lib/influx-series');
let aws = require('aws-sdk-promise');

/** Launch server */
let launch = async function (profile) {
  // Load configuration
  let cfg = base.config({
    defaults: require('../config/defaults'),
    profile: require('../config/' + profile),
    envs: [
      'provisioner_publishMetaData',
      'provisioner_awsInstancePubkey',
      'provisioner_awsKeyPrefix',
      'taskcluster_queueBaseUrl',
      'taskcluster_authBaseUrl',
      'taskcluster_credentials_clientId',
      'taskcluster_credentials_accessToken',
      'deadmanssnitch_api_key',
      'deadmanssnitch_iterationSnitch',
      'pulse_username',
      'pulse_password',
      'aws_accessKeyId',
      'aws_secretAccessKey',
      'azure_accountName',
      'azure_accountKey',
      'influx_connectionString',
    ],
    filename: 'taskcluster-aws-provisioner',
  });

  let keyPrefix = cfg.get('provisioner:awsKeyPrefix');
  let pubKey = cfg.get('provisioner:awsInstancePubkey');
  let provisionerId = cfg.get('provisioner:id');
  let provisionerBaseUrl = cfg.get('server:publicUrl') + '/v1';

  // Create InfluxDB connection for submitting statistics
  let influx = new base.stats.Influx({
    connectionString: cfg.get('influx:connectionString'),
    maxDelay: cfg.get('influx:maxDelay'),
    maxPendingPoints: cfg.get('influx:maxPendingPoints'),
  });

    // Start monitoring the process
  base.stats.startProcessUsageReporting({
    drain: influx,
    component: cfg.get('provisioner:statsComponent'),
    process: 'server',
  });

  // Configure WorkerType entities
  let WorkerType = workerType.setup({
    table: cfg.get('provisioner:workerTypeTableName'),
    credentials: cfg.get('azure'),
    context: {
      keyPrefix: keyPrefix,
      provisionerId: provisionerId,
      provisionerBaseUrl: provisionerBaseUrl,
      pubKey: pubKey,
    },
    //account: cfg.get('azure:accountName'),
    //credentials: cfg.get('taskcluster:credentials'),
    //authBaseUrl: cfg.get('taskcluster:authBaseUrl'),
  });

  // Configure WorkerState entities
  let WorkerState = workerState.setup({
    table: cfg.get('provisioner:workerStateTableName'),
    credentials: cfg.get('azure'),
  });

  // Configure WorkerType entities
  let Secret = secret.setup({
    table: cfg.get('provisioner:secretTableName'),
    credentials: cfg.get('azure'),
  });

  // Get promise for workerType table created (we'll await it later)
  let tablesCreated = Promise.all([
    WorkerType.ensureTable(),
    WorkerState.ensureTable(),
    Secret.ensureTable(),
  ]);

  // Setup Pulse exchanges and create a publisher
  // First create a validator and then publisher
  let validator = await base.validator({
    folder: path.join(__dirname, '..', 'schemas'),
    constants: require('../schemas/constants'),
    publish: cfg.get('provisioner:publishMetaData') === 'true',
    schemaPrefix: 'aws-provisioner/v1/',
    aws: cfg.get('aws'),
  });

  // Store the publisher to inject it as context into the API
  let publisher = await exchanges.setup({
    credentials: cfg.get('pulse'),
    exchangePrefix: cfg.get('provisioner:exchangePrefix'),
    validator: validator,
    referencePrefix: 'aws-provisioner/v1/exchanges.json',
    publish: cfg.get('provisioner:publishMetaData') === 'true',
    aws: cfg.get('aws'),
    drain: influx,
    component: cfg.get('provisioner:statsComponent'),
    process: 'server',
  });

  let allowedRegions = cfg.get('provisioner:allowedRegions').split(',');
  let ec2 = {};
  for (let region of allowedRegions) {
    let ec2conf = cfg.get('aws');
    ec2conf.region = region;
    ec2[region] = new aws.EC2(ec2conf);
  }

  // We also want to make sure that the table is created.
  await tablesCreated;

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
      credentials: cfg.get('taskcluster:credentials'),
      dmsApiKey: cfg.get('deadmanssnitch:api:key'),
      iterationSnitch: cfg.get('deadmanssnitch:iterationSnitch'),
      ec2: ec2,
    },
    validator: validator,
    authBaseUrl: cfg.get('taskcluster:authBaseUrl'),
    publish: cfg.get('provisioner:publishMetaData') === 'true',
    baseUrl: cfg.get('server:publicUrl') + '/v1',
    referencePrefix: 'aws-provisioner/v1/api.json',
    aws: cfg.get('aws'),
    component: cfg.get('provisioner:statsComponent'),
    drain: influx,
  });

  // Create app
  let app = base.app({
    port: Number(process.env.PORT || cfg.get('server:port')),
    env: cfg.get('server:env'),
    forceSSL: cfg.get('server:forceSSL'),
    trustProxy: cfg.get('server:trustProxy'),
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
