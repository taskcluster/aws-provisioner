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
  envs: [
    'aws_accessKeyId',
    'aws_secretAccessKey',
  ],
  filename: 'taskcluster-aws-provisioner'
});

var provisionerId = cfg.get('provisioner:id');
var awsKeyPrefix = cfg.get('provisioner:awsKeyPrefix');
var pulseRate = cfg.get('provisioner:pulseRate');
debug('Using provisioner id of %s', provisionerId);

provision.init(
  provisionerId,    
  data.WorkerType.configure({
    tableName:        cfg.get('provisioner:workerTypeTableName'),
    credentials:      cfg.get('azure')
  }
  ),
  awsKeyPrefix
);

// Things like running this every X minutes goes here.  As does things like submitting statistics on the
// provisioning run


debug(pulseRate + 'Hiyooo');
function pulse () {
  provision.provisionAll().then(function(x) {
    setTimeout(pulse, pulseRate); 
    debug('This heart will beat in %d milliseconds', pulseRate);
  }).done();
  
}

pulse();
