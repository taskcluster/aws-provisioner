let debug = require('debug')('aws-provisioner:bin:provisioner');
let base = require('taskcluster-base');
let provision = require('../lib/provision');
let Aws = require('multi-region-promised-aws');
let workerType = require('../lib/worker-type');
let secret = require('../lib/secret');
let workerState = require('../lib/worker-state');
let AwsManager = require('../lib/aws-manager');
let taskcluster = require('taskcluster-client');
let _ = require('lodash');

let launch = function (profile) {
  let cfg = base.config({
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

  let Secret = secret.setup({
    table: cfg.get('provisioner:secretTableName'),
    credentials: cfg.get('azure'),
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

  let WorkerState = workerState.setup({
    table: cfg.get('provisioner:workerStateTableName'),
    credentials: cfg.get('azure'),
  });

  // Create all the things which need to be injected into the
  // provisioner
  let ec2 = new Aws('EC2', _.omit(cfg.get('aws'), 'region'), allowedRegions);
  let awsManager = new AwsManager(
      ec2,
      provisionerId,
      keyPrefix,
      pubKey,
      maxInstanceLife,
      influx);
  let queue = new taskcluster.Queue({credentials: cfg.get('taskcluster:credentials')});

  let config = {
    WorkerType: WorkerType,
    Secret: Secret,
    WorkerState: WorkerState,
    queue: queue,
    provisionerId: provisionerId,
    taskcluster: cfg.get('taskcluster'),
    influx: influx,
    awsManager: awsManager,
    provisionIterationInterval: cfg.get('provisioner:iterationInterval'),
    dmsApiKey: cfg.get('deadmanssnitch:api:key'),
    iterationSnitch: cfg.get('deadmanssnitch:iterationSnitch'),
  };

  let provisioner = new provision.Provisioner(config);
  try {
    provisioner.run();
  } catch (err) {
    debug('[alert-operator] Error: %j %s', err, err.stack);
  }
};

// Only start up the server if we are running as a script
if (!module.parent) {
  // Find configuration profile
  let profile_ = process.argv[2] || process.env.NODE_ENV;
  if (!profile_) {
    console.log('Usage: server.js [profile]');
    console.error('ERROR: No configuration profile is provided');
  }
  launch(profile_);
  debug('launched provisioner successfully');
}

module.exports = launch;
