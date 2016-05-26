let debugModule = require('debug');
let debug = debugModule('aws-provisioner:bin:provisioner');
let base = require('taskcluster-base');
let Config = require('typed-env-config');
let provision = require('../lib/provision');
let aws = require('aws-sdk-promise');
let workerType = require('../lib/worker-type');
let secret = require('../lib/secret');
let workerState = require('../lib/worker-state');
let AwsManager = require('../lib/aws-manager');
let taskcluster = require('taskcluster-client');
let _ = require('lodash');
require('source-map-support').install();

process.on('unhandledRejection', err => {
  debug('[alert-operator] UNHANDLED REJECTION!\n' + err.stack || err);
});

let launch = async function (profile) {
  let config = Config(profile);

  let allowedRegions = config.app.allowedRegions.split(',');
  let keyPrefix = config.app.awsKeyPrefix;
  let pubKey = config.app.awsInstancePubkey;
  let provisionerId = config.app.id;
  let provisionerBaseUrl = config.server.publicUrl + '/v1';
  let maxInstanceLife = config.app.maxInstanceLife;

  let influx = new base.stats.Influx({
    connectionString: config.influx.connectionString,
    maxDelay: config.influx.maxDelay,
    maxPendingPoints: config.influx.maxPendingPoints,
  });

  let WorkerType = workerType.setup({
    table: config.app.workerTypeTableName,
    credentials: config.azure,
    context: {
      keyPrefix: keyPrefix,
      provisionerId: provisionerId,
      provisionerBaseUrl: provisionerBaseUrl,
      pubKey: pubKey,
    },
  });

  let WorkerState = workerState.setup({
    table: config.app.workerStateTableName,
    credentials: config.azure,
  });

  let Secret = secret.setup({
    table: config.app.secretTableName,
    credentials: config.azure,
  });

  // Get promise for workerType table created (we'll await it later)
  await Promise.all([
    WorkerType.ensureTable(),
    WorkerState.ensureTable(),
    Secret.ensureTable(),
  ]);

  // Create all the things which need to be injected into the
  // provisioner
  let ec2 = {};
  for (let region of allowedRegions) {
    let ec2conf = config.aws;
    ec2conf.region = region;
    let s3Debugger = debugModule('aws-sdk:provisioner');
    let awsDebugLoggerBridge = {
      write: x => {
        for (let y of x.split('\n')) {
          s3Debugger(y);
        }
      },
    };
    ec2conf.logger = awsDebugLoggerBridge;
    ec2[region] = new aws.EC2(ec2conf);
  }

  let awsManager = new AwsManager(
      ec2,
      provisionerId,
      keyPrefix,
      pubKey,
      maxInstanceLife,
      influx);
  let queue = new taskcluster.Queue({credentials: config.taskcluster.credentials});

  let provisioner = new provision.Provisioner({
    WorkerType: WorkerType,
    Secret: Secret,
    WorkerState: WorkerState,
    queue: queue,
    provisionerId: provisionerId,
    taskcluster: config.taskcluster,
    influx: influx,
    awsManager: awsManager,
    provisionIterationInterval: config.app.iterationInterval,
    dmsApiKey: config.deadmanssnitch.api.key,
    iterationSnitch: config.deadmanssnitch.iterationSnitch,
  });

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
