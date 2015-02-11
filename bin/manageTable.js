'use strict';

var debug = require('debug')('aws-provisioner:bin:provisioner');
var Promise = require('promise');
var base = require('taskcluster-base');
var data = require('../provisioner/data');

var profile = process.argv[2];
var action = process.argv[3];

if (action !== 'delete' && action !== 'create') {
  console.error('Must specify either create or delete, not "%s"', action);
  process.exit(1);
}

var cfg = base.config({
  defaults: require('../config/defaults.js'),
  profile: require('../config/' + profile),
  envs: [
    'aws_accessKeyId',
    'aws_secretAccessKey',
  ],
  filename: 'taskcluster-aws-provisioner'
});
var tableName = cfg.get('provisioner:workerTypeTableName');
var credentials = cfg.get('azure');
var WorkerType = data.WorkerType.setup({
  table:            tableName,
  credentials:      credentials,
});

debug('Operating on %s', tableName);

if (action === 'create') {
  WorkerType.ensureTable().then(function(x) {
    console.log('Table Created');
    debug(x);
  }).catch(function(x) { 
    if (x.statusCode === 409) {
      console.log('Table is in the process of being deleted.  ' +
          'Please wait for it to be deleted by storage' +
          'backend');
      return Promise.resolve();
    } else {
      console.error('Other error while creating table!', x);
    }
  }).done();
} else if (action === 'delete') {
  WorkerType.removeTable().then(function(x) {
    console.log('Table Deleted'); 
  }).catch(function(x) {
    if (x.statusCode === 404) {
      console.log('Table does not exist, no need to delete')
      return Promise.resolve();
    } else {
      console.error('Other error while deleting table!', x);
    }
  }).done();
}
