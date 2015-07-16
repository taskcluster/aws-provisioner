'use strict';

let Promise = require('promise');
let debug = require('debug')('aws-provisioner:provision');
let assert = require('assert');
let WatchDog = require('./watchdog');
let taskcluster = require('taskcluster-client');
let delayer = require('./delayer');
let shuffle = require('knuth-shuffle');

let series = require('./influx-series');

const MAX_PROVISION_ITERATION = 1000 * 60 * 10; // 10 minutes
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
 * Start running a provisioner.
 */
Provisioner.prototype.run = async function () {
  this.__keepRunning = true;

  this.__watchDog.on('expired', () => {
    debug('[alert-operator] provisioning iteration exceeded max time');
    process.exit(1); //eslint-disable-line no-process-exit
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
        debug('exiting because there have been too many failures');
        process.exit(1); //eslint-disable-line no-process-exit
      }

      let outcome;

      this.__stats.runs++;

      // Do the iterations
      try {
        debug('about to runAllProvisionersOnce()');
        await this.runAllProvisionersOnce();
        debug('ran runAllProvisionersOnce() with success');
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
    debug('error trying to run all provisioners once, exiting');
    debug(err);
    if (err.stack) {
      debug(err.stack);
    }
    process.exit(1); //eslint-disable-line no-process-exit
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
  let res;
  try {
    res = await Promise.all([
      this.WorkerType.loadAll(),
      this.awsManager.update(),
    ]);
    debug('loaded all worker types and updated aws state');
  } catch (err) {
    debug('error loading workertypes or updating ec2 state');
    debug(err);
    if (err.stack) {
      debug(err.stack);
    }
    throw err;
  }

  let workerTypes = res[0];

  let workerNames = workerTypes.map(w => w.workerType);

  try {
    await Promise.all([
      this.awsManager.rougeKiller(workerNames),
      this.awsManager.zombieKiller(),
      this.awsManager.ensureTags(),
      Promise.all(workerNames.map(name => {
        return this.awsManager.createKeyPair(name);
      })),
    ]);

    debug('ran all housekeeping tasks');
  } catch (err) {
    debug('failure running housekeeping tasks');
    debug(err);
    if (err.stack) {
      debug(err.stack);
    }
  }

  debug('configured workers:           %j', workerNames);
  debug('managed requests/instances:   %j', this.awsManager.knownWorkerTypes());

  let forSpawning = [];

  for (let worker of workerTypes) {
    let change;
    try {
      change = await this.changeForType(worker);
      debug('type %s had a change of %d', worker.workerType, change);
    } catch (changeErr) {
      debug('error getting change for %s', worker.workerType);
      debug(changeErr);
      if (changeErr.stack) {
        debug(changeErr.stack);
      }
      throw changeErr;
    }

    // This is a slightly modified version of the aws objects
    // which are made smaller to fit into azure storage entities

    try {
      // This does create a bunch of extra logs... darn!
      let state = this.awsManager.stateForStorage(worker.workerType);
      await this.WorkerState.create(state, true);
      debug('state entity stored for %s (create)', worker.workerType);
    } catch (stateWriteErr) {
      debug('[alert-operator] failed to update state for %s', worker.workerType);
      debug(stateWriteErr);
      if (stateWriteErr.stack) {
        debug(stateWriteErr.stack);
      }
    }

    if (change > 0) {
      debug('%s needs %d capacity created', worker.workerType, change);
      let bids = worker.determineSpotBids(this.awsManager.ec2.regions, this.awsManager.__pricing, change);
      // This could probably be done cleaner
      for (let bid of bids) {
        forSpawning.push({workerType: worker, bid: bid});
      }
    } else if (change < 0) {
      let capToKill = -change;
      debug('%s needs %d capacity destroyed', worker.workerType, capToKill);
      try {
        await this.awsManager.killCapacityOfWorkerType(
              worker, capToKill, ['pending', 'spotReq']);
      } catch (killCapErr) {
        debug('error running the capacity killer');
        debug(killCapErr);
        if (killCapErr.stack) {
          debug(killCapErr.stack);
        }
        throw killCapErr;
      }
    } else {
      debug('%s needs no changes', worker.workerType);
    }
  }

  const d = delayer(500);
  const longD = delayer(2000);

  // We want to have a maximum number of attempts
  let attemptsLeft = forSpawning.length * 2;

  // We want to shuffle up the bids so that we don't prioritize
  // any particular worker type
  debug('START FOR SPAWNING');
  debug(JSON.stringify(forSpawning, null, 2));
  debug('END FOR SPAWNING');
  forSpawning = shuffle.knuthShuffle(forSpawning);

  while (forSpawning.length > 0 && attemptsLeft-- > 0) {
    let toSpawn = forSpawning.shift();
    try {
      await this.spawn(toSpawn.workerType, toSpawn.bid);
      debug('spawned a %s', toSpawn.workerType.workerType);
      await d();
    } catch (err) {
      try {
        await longD();
      } catch (longWaitErr) {
        debug(longWaitErr);
        debug(longWaitErr.stack);
      }
      debug('error spawning %s with bid %j, pushing it',
          toSpawn.workerType.workerType, toSpawn.bid);
      debug(err);
      if (err.stack) {
        debug(err.stack);
      }
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

  let launchInfo = workerType.createLaunchSpec(bid);

  try {
    await this.Secret.create({
      token: launchInfo.securityToken,
      workerType: workerType.workerType,
      secrets: launchInfo.secrets,
      scopes: launchInfo.scopes,
      expiration: taskcluster.fromNow('40 minutes'),
    });
    debug('created secret %s', launchInfo.securityToken);
  } catch (err) {
    debug('error inserting secret into storage');
    debug(err);
    if (err.stack) {
      debug(err.stack);
    }
    throw err;
  }

  return this.awsManager.requestSpotInstance(launchInfo, bid);
};

/**
 * Determine the change for a given worker type
 */
Provisioner.prototype.changeForType = async function (workerType) {
  let result;
  try {
    result = await this.queue.pendingTasks(this.provisionerId, workerType.workerType);
    debug('got pending tasks for %s', workerType.workerType);
  } catch (err) {
    debug('error checking queue for pending tasks');
    debug(err);
    if (err.stack) {
      debug(err.stack);
    }
    throw err;
  }

  let pendingTasks = result.pendingTasks;
  let runningCapacity = this.awsManager.capacityForType(workerType, ['running']);
  let pendingCapacity = this.awsManager.capacityForType(workerType, ['pending', 'spotReq']);
  let change = workerType.determineCapacityChange(
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
