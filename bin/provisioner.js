'use strict';

var debug = require('debug')('aws-provisioner:bin:provisioner');
var Promise = require('promise');
var base = require('taskcluster-base');
var provision = require('../provisioner/provision');
var aws = require('multi-region-promised-aws');
var data = require('../provisioner/data');

var profile = process.argv[2];

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
      'influx_connectionString'
  ]
});

var allowedRegions = cfg.get('provisioner:allowedRegions').split(',');

var ec2 = new aws('EC2', cfg.get('aws'), allowedRegions);

var influx = new base.stats.Influx({
  connectionString:   cfg.get('influx:connectionString'),
  maxDelay:           cfg.get('influx:maxDelay'),
  maxPendingPoints:   cfg.get('influx:maxPendingPoints')
});

var WorkerType = data.WorkerType.setup({
    table: cfg.get('provisioner:workerTypeTableName'),
    credentials: cfg.get('azure'),
    context: {
      ec2:            ec2,
      keyPrefix:      cfg.get('provisioner:awsKeyPrefix'),
      pubKey:         cfg.get('provisioner:awsInstancePubkey'),
      influx:         influx,
    },
  });


var config = {
  WorkerType: WorkerType,
  provisionerId: cfg.get('provisioner:id'),
  awsKeyPrefix: cfg.get('provisioner:awsKeyPrefix'),
  awsInstancePubKey: cfg.get('provisioner:awsInstancePubkey'),
  taskcluster: cfg.get('taskcluster'),
  ec2: ec2,
  influx: influx,
  provisionIterationInterval: cfg.get('provisioner:iterationInterval'),
  allowedAwsRegions: allowedRegions,
}

var provisioner = new provision.Provisioner(config);
provisioner.run();
