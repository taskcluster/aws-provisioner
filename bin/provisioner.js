'use strict';

var debug = require('debug')('aws-provisioner:bin:provisioner');
var base = require('taskcluster-base');
var provision = require('../provisioner/provision');
var Aws = require('multi-region-promised-aws');
var data = require('../provisioner/data');
var AwsManager = require('../provisioner/aws-manager');
var awsPricing = require('../provisioner/aws-pricing');
var Cache = require('../lib/cache');
var taskcluster = require('taskcluster-client');
var _ = require('lodash');


var launch = function(profile) {
  var cfg = base.config({
    defaults: require('../config/defaults.js'),
    profile: require('../config/' + profile),
    filename: 'taskcluster-aws-provisioner',
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
  });

  var allowedRegions = cfg.get('provisioner:allowedRegions').split(',');
  var keyPrefix = cfg.get('provisioner:awsKeyPrefix');
  var pubKey = cfg.get('provisioner:awsInstancePubkey');
  var provisionerId = cfg.get('provisioner:id');

  var influx = new base.stats.Influx({
    connectionString: cfg.get('influx:connectionString'),
    maxDelay: cfg.get('influx:maxDelay'),
    maxPendingPoints: cfg.get('influx:maxPendingPoints'),
  });

  var WorkerType = data.WorkerType.setup({
    table: cfg.get('provisioner:workerTypeTableName'),
    credentials: cfg.get('azure'),
    context: {
      keyPrefix: keyPrefix,
      provisionerId: provisionerId,
    },
  });

  // Create all the things which need to be injected into the
  // provisioner
  var ec2 = new Aws('EC2', _.omit(cfg.get('aws'), allowedRegions);
  var awsManager = new AwsManager(ec2, keyPrefix, pubKey);
  var queue = new taskcluster.Queue({credentials: cfg.get('taskcluster:credentials')});
  var pricingCache = new Cache(15, awsPricing, ec2);

  var config = {
    WorkerType: WorkerType,
    queue: queue,
    provisionerId: provisionerId,
    taskcluster: cfg.get('taskcluster'),
    influx: influx,
    awsManager: awsManager,
    pricingCache: pricingCache,
    provisionIterationInterval: cfg.get('provisioner:iterationInterval'),
  };

  var provisioner = new provision.Provisioner(config);
  provisioner.run();
};


// Only start up the server if we are running as a script
if (!module.parent) {
  // Find configuration profile
  var profile_ = process.argv[2] || process.env.NODE_ENV;
  if (!profile_) {
    console.log('Usage: server.js [profile]');
    console.error('ERROR: No configuration profile is provided');
  }
  // Launch with given profile
  launch(profile_);
  debug('launched provisioner successfully');
}

module.exports = launch;
