'use strict';

var Promise = require('promise');
var debug = require('debug')('aws-provisioner:provision');
var assert = require('assert');
var WatchDog = require('./watchdog');
var taskcluster = require('taskcluster-client');
var delayer = require('./delayer');
var shuffle = require('knuth-shuffle');

var series = require('./influx-series');

const MAX_PROVISION_ITERATION = 1000 * 60 * 10; // 10 minutes
const MAX_KILL_TIME = 1000 * 30;
const MAX_FAILURES = 15;

// Docs for Ec2: http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/EC2.html

/**
 * A Provisioner knows how to use an AWS Manager and WorkerType to do provisioning.
 * It does not understand itself how to do AWS things or Azure things, it just
 * knows how and when certain things need to occur for provisioning to happen
 */
function Provisioner (cfg) {
  assert(typeof cfg === 'object');
  // We should have an AwsManager
  assert(cfg.awsManager);
  this.awsManager = cfg.awsManager;

  // We should have a WorkerType Entity
  assert(cfg.WorkerType);
  this.WorkerType = cfg.WorkerType;

  // We should have a WorkerState Entity
  assert(cfg.WorkerState);
  this.WorkerState = cfg.WorkerState;

  // We should have a Secret Entity
  assert(cfg.Secret);
  this.Secret = cfg.Secret;

  // We should have a Queue
  assert(cfg.queue);
  this.queue = cfg.queue;

  // We should have an influx object
  assert(cfg.influx);
  this.influx = cfg.influx;

  this.reportProvisioningIteration = series.provisionerIteration.reporter(this.influx);

  // This is the ID of the provisioner.  It is used to interogate the queue
  // for pending tasks
  assert(cfg.provisionerId);
  assert(typeof cfg.provisionerId === 'string');
  this.provisionerId = cfg.provisionerId;

  // We should have an influx instance
  assert(cfg.influx);
  this.influx = cfg.influx;

  // This is the number of milliseconds to wait between completed provisioning runs
  assert(cfg.provisionIterationInterval);
  assert(typeof cfg.provisionIterationInterval === 'number');
  assert(!isNaN(cfg.provisionIterationInterval));
  this.provisionIterationInterval = cfg.provisionIterationInterval;

  this.__provRunId = 0;

  this.__keepRunning = false;
  this.__watchDog = new WatchDog(MAX_PROVISION_ITERATION);
  this.__stats = {
    runs: 0,
    consecFail: 0,
  };
}

module.exports.Provisioner = Provisioner;

/**
 * For when you want to be really certain that the program will
 * exit
 */
function exitTimer (time) {
  var t = time || 30000;
  setTimeout(() => {
    debug('hey, so you probably are trying to figure out');
    debug('why this process suddenly disappeared.  a major');
    debug('error occured and you only get %d ms to exit after', t);
    debug('before we process.exit(44). handle things faster!');
    process.exit(44); // eslint-disable-line no-process-exit
  }, t);
}

/**
 * Start running a provisioner.
 */
Provisioner.prototype.run = async function () {
  this.__keepRunning = true;

  this.__watchDog.on('expired', () => {
    debug('[alert-operator] provisioning iteration exceeded max time');
    exitTimer(MAX_KILL_TIME);
    throw new Error('WatchDog expired');
  });

  this.__watchDog.start();

  const d = delayer(this.provisionIterationInterval);

  try {
    do {
      debug('starting iteration %d, consecutive failures %d',
            this.__stats.runs, this.__stats.consecFail);

      // If we don't do this, we'll have an uncaught exception
      this.__watchDog.touch();

      // We should make sure that we're not just permanently failing
      // We also don't want to
      if (this.__stats.consecFail > MAX_FAILURES) {
        debug('[alert-operator] dying after %d consecutive failures',
            MAX_FAILURES);
        exitTimer(MAX_KILL_TIME);
        throw new Error('provisioner is failing a lot');
      }

      var outcome;

      this.__stats.runs++;

      // Do the iterations
      try {
        await this.runAllProvisionersOnce();
        this.__stats.consecFail = 0;
        outcome = 'succeeded';
      } catch (err) {
        this.__stats.consecFail++;
        outcome = 'failed';
        debug('[alert-operator] provisioning iteration failure');
        if (err.stack) {
          debug('[alert-operator] stack: %s', err.stack.replace('\n', '\\n'));
        }
      }

      // Report on the iteration
      debug('provisioning iteration %s', outcome);
      debug('scheduling next iteration in %sms',
          this.provisionIterationInterval);
      // And delay for the next one so we don't overwhelm EC2
      await d();
    } while (this.__keepRunning && !process.env.PROVISION_ONCE);
    this.__watchDog.stop();
  } catch (err) {
    exitTimer(MAX_KILL_TIME);
    throw err;
  }
};

/**
 * Stop launching new provisioner iterations but don't
 * end the current one
 */
Provisioner.prototype.stop = function () {
  this.__keepRunning = false;
  this.__watchDog.stop();
  this.__stats.runs = 0;
  this.__stats.consecFail = 0;
};

/**
 * Run provisioners for all known worker types once
 */
Provisioner.prototype.runAllProvisionersOnce = async function () {
  var res = await Promise.all([
    this.WorkerType.loadAll(),
    this.awsManager.update(),
  ]);

  var workerTypes = res[0];

  var workerNames = workerTypes.map(x => {
    return x.workerType; // can't remember the nice es7 for this
  });

  await Promise.all([
    this.awsManager.rougeKiller(workerNames),
    this.awsManager.zombieKiller(),
    this.awsManager.ensureTags(),
    workerNames.map(name => {
      return this.awsManager.createKeyPair(name);
    }),
  ]);

  debug('configured workers:           %j', workerNames);
  debug('managed requests/instances:   %j', this.awsManager.knownWorkerTypes());

  var forSpawning = [];

  for (var worker of workerTypes) {
    var change = await this.changeForType(worker);
    var state = this.awsManager.stateForStorage(worker.workerType);
    try {
      // This does create a bunch of extra logs... darn!
      await this.WorkerState.create(state);
    } catch (err) {
      try {
        var stateEntity = await this.WorkerState.load({workerType: worker.workerType});
        await stateEntity.modify(function () {
          //debug('%j\n\n \\/ \n\n%j', s, state);
          this.instances = state.instances;
          this.requests = state.requests;
        });
        debug('hihihi');
      } catch (err2) {
        debug('[alert-operator] failed to update state for %s', worker.workerType);
        debug(err2);
        if (err2.stack) {
          debug(err2.stack);
        }
      }
    }

    if (change > 0) {
      debug('%s needs %d capacity created', worker.workerType, change);
      var bids = worker.determineSpotBids(this.awsManager.ec2.regions, this.awsManager.__pricing, change);
      // This could probably be done cleaner
      for (let bid of bids) {
        forSpawning.push({workerType: worker, bid: bid});
      }
    } else if (change < 0) {
      var capToKill = -change;
      debug('%s needs %d capacity destroyed', worker.workerType, capToKill);
      await this.awsManager.killCapacityOfWorkerType(
            worker, capToKill, ['pending', 'spotReq']);
    } else {
      debug('%s needs no changes', worker.workerType);
    }
  }

  const d = delayer(500);
  const longD = delayer(2000);

  // We want to have a maximum number of attempts
  var attemptsLeft = forSpawning.length * 2;

  // We want to shuffle up the bids so that we don't prioritize
  // any particular worker type
  forSpawning = shuffle.knuthShuffle(forSpawning);

  while (forSpawning.length > 0 && attemptsLeft-- > 0) {
    var toSpawn = forSpawning.shift();
    try {
      await this.spawn(toSpawn.workerType, toSpawn.bid);
      await d();
    } catch (err) {
      await longD();
      debug('ERROR! there was an error with bid %j: %j %s', toSpawn.bid, err, err.stack);
      forSpawning.push(toSpawn);
    }
  }
};

/**
 * Figure out how to create the launch information based on a bid then
 * insert the secrets into the secret storage
 */
Provisioner.prototype.spawn = async function (workerType, bid) {
  assert(workerType);
  assert(bid);

  var launchInfo = workerType.createLaunchSpec(bid);

  await this.Secret.create({
    token: launchInfo.securityToken,
    workerType: workerType.workerType,
    secrets: launchInfo.secrets,
    scopes: launchInfo.scopes,
    expiration: taskcluster.fromNow('40 minutes'),
  });

  return this.awsManager.requestSpotInstance(launchInfo, bid);
};

/**
 * Determine the change for a given worker type
 */
Provisioner.prototype.changeForType = async function (workerType) {
  var result = await this.queue.pendingTasks(
      this.provisionerId, workerType.workerType);
  var pendingTasks = result.pendingTasks;
  var runningCapacity = this.awsManager.capacityForType(workerType, ['running']);
  var pendingCapacity = this.awsManager.capacityForType(workerType, ['pending', 'spotReq']);
  var change = workerType.determineCapacityChange(
      runningCapacity, pendingCapacity, pendingTasks);
  debug('%s: %d running capacity, %d pending capacity and %d pending tasks',
      workerType.workerType, runningCapacity, pendingCapacity, pendingTasks);

  // Report on the stats for this iteration
  this.reportProvisioningIteration({
    provisionerId: this.provisionerId,
    workerType: workerType.workerType,
    pendingTasks: pendingTasks,
    runningCapacity: runningCapacity,
    pendingCapacity: pendingCapacity,
    change: change,
  });

  return change;
};
