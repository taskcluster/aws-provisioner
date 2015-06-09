#!/usr/bin/env node
'use strict';
var path = require('path');
var debug = require('debug')('aws-provisioner:bin:server');
var base = require('taskcluster-base');
var data = require('../provisioner/data');
var secret = require('../provisioner/secret');
var exchanges = require('../provisioner/exchanges');
var AwsManager = require('../provisioner/aws-manager');
var v1 = require('../routes/v1');
var Aws = require('multi-region-promised-aws');
var _ = require('lodash');

/** Launch server */
var launch = function (profile) {
  // Load configuration
  var cfg = base.config({
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

  var keyPrefix = cfg.get('provisioner:awsKeyPrefix');
  var pubKey = cfg.get('provisioner:awsInstancePubkey');
  var provisionerId = cfg.get('provisioner:id');
  var provisionerBaseUrl = cfg.get('server:publicUrl') + '/v1';
  var maxInstanceLife = cfg.get('provisioner:maxInstanceLife');

  // Create InfluxDB connection for submitting statistics
  var influx = new base.stats.Influx({
    connectionString: cfg.get('influx:connectionString'),
    maxDelay: cfg.get('influx:maxDelay'),
    maxPendingPoints: cfg.get('influx:maxPendingPoints'),
  });

  // Configure me an EC2 API instance.  This one should be able
  // to run in any region, which we'll limit by the ones
  // store in the worker definition
  // NOTE: Should we use ec2.describeRegions? meh
  var ec2 = new Aws('EC2', _.omit(cfg.get('aws'), 'region'), [
    'us-east-1', 'us-west-1', 'us-west-2',
    'eu-west-1', 'eu-central-1',
    'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1',
    'sa-east-1',
  ]);

  // We want an AwsManger here as well since we want to be
  // able to inspect what goes on there from here
  var awsManager = new AwsManager(
      ec2,
      provisionerId,
      keyPrefix,
      pubKey,
      maxInstanceLife,
      influx);

  // We want to be updating the Aws State so that api clients can easily
  // access the information with the minimum overhead possible
  function updateAwsState () {
    awsManager.update().done();
  }
  updateAwsState();
  setTimeout(updateAwsState, 2 * 60 * 1000);

  // Start monitoring the process
  base.stats.startProcessUsageReporting({
    drain: influx,
    component: cfg.get('provisioner:statsComponent'),
    process: 'server',
  });

  // Configure WorkerType entities
  var WorkerType = data.WorkerType.setup({
    table: cfg.get('provisioner:workerTypeTableName'),
    credentials: cfg.get('azure'),
    context: {
      keyPrefix: keyPrefix,
      provisionerId: provisionerId,
      provisionerBaseUrl: provisionerBaseUrl,
    },
    //account: cfg.get('azure:accountName'),
    //credentials: cfg.get('taskcluster:credentials'),
    //authBaseUrl: cfg.get('taskcluster:authBaseUrl'),
  });

  // Configure WorkerType entities
  var Secret = secret.setup({
    table: cfg.get('provisioner:secretTableName'),
    credentials: cfg.get('azure'),
  });

  // Setup Pulse exchanges and create a publisher
  // First create a validator and then publisher
  var validator = null;
  var publisher = null;

  var p = base.validator({
    folder: path.join(__dirname, '..', 'schemas'),
    constants: require('../schemas/constants'),
    publish: cfg.get('provisioner:publishMetaData') === 'true',
    schemaPrefix: 'aws-provisioner/v1/',
    aws: cfg.get('aws'),
  });

  p = p.then(function (validator_) {
    validator = validator_;
    return exchanges.setup({
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
  });

  // Store the publisher to inject it as context into the API
  p = p.then(function (publisher_) {
    publisher = publisher_;
  });

  // Warm the Aws State Cache
  p = p.then(function () {
    return awsManager.update();
  });

  // We also want to make sure that the table is created.  We could
  // probably do this earlier
  p = p.then(function () {
    return Promise.all([
        WorkerType.ensureTable(),
        Secret.ensureTable(),
    ]);
  });

  p = p.then(function () {
    // Create API router and publish reference if needed
    return v1.setup({
      context: {
        WorkerType: WorkerType,
        Secret: Secret,
        publisher: publisher,
        awsManager: awsManager,
        keyPrefix: keyPrefix,
        provisionerId: provisionerId,
        provisionerBaseUrl: provisionerBaseUrl,
      },
      validator: validator,
      authBaseUrl: cfg.get('taskcluster:authBaseUrl'),
      credentials: cfg.get('taskcluster:credentials'),
      publish: cfg.get('provisioner:publishMetaData') === 'true',
      baseUrl: cfg.get('server:publicUrl') + '/v1',
      referencePrefix: 'aws-provisioner/v1/api.json',
      aws: cfg.get('aws'),
      component: cfg.get('provisioner:statsComponent'),
      drain: influx,
    });
  });

  p = p.then(function (router) {
    // Create app
    var app = base.app({
      port: Number(process.env.PORT || cfg.get('server:port')),
      env: cfg.get('server:env'),
      forceSSL: cfg.get('server:forceSSL'),
      trustProxy: cfg.get('server:trustProxy'),
    });

    // Mount API router
    app.use('/v1', router);

    // Create server
    return app.createServer();
  });

  return p;
};

// If server.js is executed start the server
if (!module.parent) {
  // Find configuration profile
  var profile_ = process.argv[2] || process.env.NODE_ENV;
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
