#!/usr/bin/env node
var path        = require('path');
var Promise     = require('promise');
var debug       = require('debug')('aws-provisioner:bin:server');
var base        = require('taskcluster-base');
var taskcluster = require('taskcluster-client');
var data        = require('../provisioner/data');
var exchanges   = require('../provisioner/exchanges');
var AwsManager    = require('../provisioner/aws-manager');
var v1          = require('../routes/v1');
var aws         = require('multi-region-promised-aws');
var Cache       = require('../cache');

/** Launch server */
var launch = function(profile) {
  // Load configuration
  var cfg = base.config({
    defaults:     require('../config/defaults'),
    profile:      require('../config/' + profile),
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
      'influx_connectionString'
    ],
    filename:     'taskcluster-aws-provisioner'
  });

  // Configure queue
  var queue = new taskcluster.Queue({
    baseUrl:        cfg.get('taskcluster:queueBaseUrl'),
    credentials:    cfg.get('taskcluster:credentials')
  });

  var keyPrefix = cfg.get('provisioner:awsKeyPrefix');
  var pubKey = cfg.get('provisioner:awsInstancePubkey');
  var provisionerId = cfg.get('provisioner:id');

  // Create InfluxDB connection for submitting statistics
  var influx = new base.stats.Influx({
    connectionString:   cfg.get('influx:connectionString'),
    maxDelay:           cfg.get('influx:maxDelay'),
    maxPendingPoints:   cfg.get('influx:maxPendingPoints')
  });

  // Configure me an EC2 API instance.  This one should be able
  // to run in any region, which we'll limit by the ones
  // store in the worker definition
  // NOTE: Should we use ec2.describeRegions? meh
  var ec2 = new aws('EC2', cfg.get('aws'), [
    'us-east-1', 'us-west-1', 'us-west-2',
    'eu-west-1', 'eu-central-1',
    'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1',
    'sa-east-1'
  ]);
  
  // We want an AwsManger here as well since we want to be
  // able to inspect what goes on there from here
  var awsManager = new AwsManager(ec2, keyPrefix, pubKey);

  // Start monitoring the process
  base.stats.startProcessUsageReporting({
    drain:      influx,
    component:  cfg.get('provisioner:statsComponent'),
    process:    'server'
  });

  // Configure WorkerType entities
  var WorkerType = data.WorkerType.setup({
    table: cfg.get('provisioner:workerTypeTableName'),
    credentials: cfg.get('azure'),
    context: {
      keyPrefix: keyPrefix,
      provisionerId: provisionerId,
    },
    //account: cfg.get('azure:accountName'),
    //credentials: cfg.get('taskcluster:credentials'),
    //authBaseUrl: cfg.get('taskcluster:authBaseUrl'),
  });

  // Setup Pulse exchanges and create a publisher
  // First create a validator and then publisher
  var validator = null;
  var publisher = null;

  var p = base.validator({
    folder:           path.join(__dirname, '..', 'schemas'),
    constants:        require('../schemas/constants'),
    publish:          cfg.get('provisioner:publishMetaData') === 'true',
    schemaPrefix:     'aws-provisioner/v1/',
    aws:              cfg.get('aws')
  });

  p = p.then(function(validator_) {
    validator = validator_;
    return exchanges.setup({
      credentials:        cfg.get('pulse'),
      exchangePrefix:     cfg.get('provisioner:exchangePrefix'),
      validator:          validator,
      referencePrefix:    'aws-provisioner/v1/exchanges.json',
      publish:            cfg.get('provisioner:publishMetaData') === 'true',
      aws:                cfg.get('aws'),
      drain:              influx,
      component:          cfg.get('provisioner:statsComponent'),
      process:            'server'
    });
  });
  
  // Store the publisher to inject it as context into the API
  p = p.then(function(publisher_) {
    publisher = publisher_;
  });

  // We also want to make sure that the table is created.  We could
  // probably do this earlier
  p = p.then(function() {
    return WorkerType.ensureTable();
  });

  p = p.then(function() {
    // Create API router and publish reference if needed
    return v1.setup({
      context: {
        WorkerType:     WorkerType,
        publisher:      publisher,
        awsManager:     awsManager,
        keyPrefix:      keyPrefix,
        provisionerId:  provisionerId,
      },
      validator:        validator,
      authBaseUrl:      cfg.get('taskcluster:authBaseUrl'),
      credentials:      cfg.get('taskcluster:credentials'),
      publish:          cfg.get('provisioner:publishMetaData') === 'true',
      baseUrl:          cfg.get('server:publicUrl') + '/v1',
      referencePrefix:  'aws-provisioner/v1/api.json',
      aws:              cfg.get('aws'),
      component:        cfg.get('provisioner:statsComponent'),
      drain:            influx
    });
  });

  p = p.then(function(router) {
    // Create app
    var app = base.app({
      port:           Number(process.env.PORT || cfg.get('server:port')),
      env:            cfg.get('server:env'),
      forceSSL:       cfg.get('server:forceSSL'),
      trustProxy:     cfg.get('server:trustProxy')
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
  var profile = process.argv[2] || process.env.NODE_ENV;
  if (!profile) {
    console.log("Usage: server.js [profile]")
    console.error("ERROR: No configuration profile is provided");
  }
  // Launch with given profile
  launch(profile).then(function() {
    debug("Launched server successfully");
  }).catch(function(err) {
    debug("Failed to start server, err: %s, as JSON: %j", err, err, err.stack);
    // If we didn't launch the server we should crash
    process.exit(1);
  });
}

// Export launch in-case anybody cares
module.exports = launch;
