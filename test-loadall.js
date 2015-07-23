'use strict';

let base = require('taskcluster-base');
let debug = require('debug')('aws-provisioner:bin:provisioner');
let workerType = require('./lib/worker-type');
let _ = require('lodash');

// Find configuration profile
let profile = process.argv[2] || process.env.NODE_ENV;
if (!profile) {
  console.log('Usage: server.js [profile]');
  console.error('ERROR: No configuration profile is provided');
}

let cfg = base.config({
  defaults: require('./config/defaults.js'),
  profile: require('./config/' + profile),
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

let allowedRegions = cfg.get('provisioner:allowedRegions').split(',');
let keyPrefix = cfg.get('provisioner:awsKeyPrefix');
let pubKey = cfg.get('provisioner:awsInstancePubkey');
let provisionerId = cfg.get('provisioner:id');
let provisionerBaseUrl = cfg.get('server:publicUrl') + '/v1';
let maxInstanceLife = cfg.get('provisioner:maxInstanceLife');

let influx = new base.stats.Influx({
  connectionString: cfg.get('influx:connectionString'),
  maxDelay: cfg.get('influx:maxDelay'),
  maxPendingPoints: cfg.get('influx:maxPendingPoints'),
});

let WorkerType = workerType.setup({
  table: cfg.get('provisioner:workerTypeTableName'),
  credentials: cfg.get('azure'),
  context: {
    keyPrefix: keyPrefix,
    provisionerId: provisionerId,
    provisionerBaseUrl: provisionerBaseUrl,
  },
});

async () => {
  console.log('###############################################');
  console.log('###############################################');
  console.log('###############################################');
  console.log('###############################################');
  for (var i = 0 ; i < 10000000 ; i++) {
    try {
      var x = await Promise.all([
        WorkerType.loadAll(),
        WorkerType.loadAll(),
        WorkerType.loadAll(),
        WorkerType.loadAll(),
        WorkerType.loadAll(),
        WorkerType.loadAll(),
        WorkerType.loadAll(),
        WorkerType.loadAll(),
        WorkerType.loadAll(),
        WorkerType.loadAll(),
        WorkerType.loadAll(),
        WorkerType.loadAll(),
        WorkerType.loadAll(),
        WorkerType.loadAll(),
        WorkerType.loadAll(),
        WorkerType.loadAll(),
        WorkerType.loadAll(),
        WorkerType.loadAll(),
      ]);
      console.log('loaded worker types for the ' + i + 'th time');
    } catch (err) {
      console.log(err);
      console.log(err.stack);
      throw err;
    }
  }
  console.log('###############################################');
  console.log('###############################################');
  console.log('###############################################');
  console.log('###############################################');
}();

