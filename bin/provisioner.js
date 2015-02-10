'use strict';

var debug = require('debug')('aws-provisioner:bin:provisioner');
var Promise = require('promise');
var base = require('taskcluster-base');
var provision = require('../provisioner/provision');
var data = require('../provisioner/data');

var profile = process.argv[2];

var cfg = base.config({
  defaults: require('../config/defaults.js'),
  profile: require('../config/' + profile),
  filename: 'taskcluster-aws-provisioner',
  envs: [
      'provisioner_publishMetaData',
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

var config = {
  provisionerId: cfg.get('provisioner:id'),
  workerTypeTableName: cfg.get('provisioner:workerTypeTableName'),
  awsKeyPrefix: cfg.get('provisioner:awsKeyPrefix'),
  awsInstancePubKey: cfg.get('provisioner:awsInstancePubkey'),
  taskcluster: cfg.get('taskcluster'),
  aws: cfg.get('aws'),
  azure: cfg.get('azure'),
  pulseRate: cfg.get('provisioner:pulseRate'),
  allowedAwsRegions: cfg.get('provisioner:allowedRegions').split(','),
}

var provisioner = new provision.Provisioner(config);
provisioner.run();
