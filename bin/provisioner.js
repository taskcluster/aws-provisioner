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


var pulseRate = cfg.get('provisioner:pulseRate');
provision.init(
  cfg,
  data.WorkerType.configure({
    tableName:        cfg.get('provisioner:workerTypeTableName'),
    credentials:      cfg.get('azure')
  }
  )
);

// Things like running this every X minutes goes here.  As does things like submitting statistics on the
// provisioning run


function pulse () {
  provision.provisionAll().then(function(x) {
    setTimeout(pulse, pulseRate); 
    debug('This heart will beat in %d milliseconds', pulseRate);
  }).done();
  
}

pulse();
