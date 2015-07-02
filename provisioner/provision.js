'use strict';

var Promise = require('promise');
var debug = require('debug')('aws-provisioner:provision');
var assert = require('assert');
var WatchDog = require('../lib/watchdog');
var taskcluster = require('taskcluster-client');
var awsPricing = require('./aws-pricing');

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
}

module.exports.Provisioner = Provisioner;

/**
 * Store basic stats of each iteration
 */
var stats = {
  iterations: 0,
  success: 0,
  failure: 0,
};

// For when you want to be really certain that the program will
// exit
function exitTimer(time) {
  var t = time || 30000;
  setTimeout(() => {
    debug('hey, so you probably are trying to figure out');
    debug('why this process suddenly disappeared.  a major');
    debug('error occured and you only get %d ms to exit after', t);
    debug('before we process.exit(44). handle things faster!');
    process.exit(44);
  }, t);
}

/**
 * Start running a provisioner.
 */
Provisioner.prototype.run = function () {
  this.__keepRunning = true;

  this.__watchDog.on('expired', function () {
    debug('[alert-operator] provisioning iteration exceeded max time');
    exitTimer(MAX_KILL_TIME);
    throw new Error('WatchDog expired');
  });

  this.__watchDog.start();

  var provisionIteration = async () => {
    debug('starting iteration %d, successes %d, failures %d',
          stats.iterations,
          stats.success,
          stats.failure);

    this.__watchDog.touch();

    // We should make sure that we're not just permanently failing
    // We also don't want to
    if (stats.failure > MAX_FAILURES) {
      debug('[alert-operator] dieing after %d failures', MAX_FAILURES);
      exitTimer(MAX_KILL_TIME);
      throw new Error('provisioner is failing a lot');
    }

    var outcome;

    try {
      await this.runAllProvisionersOnce();
      stats.success++;
      stats.iterations++;
      outcome = 'succeeded';
    } catch (err) {
      stats.failure++;
      stats.iterations++;
      outcome = 'failed';
      debug('[alert-operator] provisioning iteration failure');
      if (err.stack) {
        debug('[alert-operator] stack: %s', err.stack.replace('\n', '\\n'));
      }
    }

    debug('provisioning iteration %s', outcome);

    if (this.__keepRunning && !process.env.PROVISION_ONCE) {
      debug('scheduling another iteration in %d seconds', 
        Math.round(this.provisionIterationInterval / 1000));
      setTimeout(() => {
        provisionIteration().catch(() => {
          process.exit(1);
        });
      }, this.provisionIterationInterval);
    } else {
      debug('not scheduling further iterations');
    }
  }

  // To ensure that the first iteration is not called differently that
  // subsequent ones, we'll call it with a zero second timeout
  setTimeout(() => {
    provisionIteration().catch(() => {
      process.exit(1);
    });
  }, 0);

};

/**
 * Stop launching new provisioner iterations but don't
 * end the current one
 */
Provisioner.prototype.stop = function () {
  this.__keepRunning = false;
  this.__watchDog.stop();
  stats.iterations = 0;
  stats.success = 0;
  stats.failure = 0;
};

/**
 * Run provisioners for all known worker types once
 */
Provisioner.prototype.runAllProvisionersOnce = async function () {
  var that = this;

  var p = Promise.all([
    this.WorkerType.loadAll(),
    this.awsManager.update(),
    awsPricing(this.awsManager.ec2),
  ]);

  p = p.then(function (res) {
    var workerTypes = res[0];

    // We'll use this twice here... let's generate it only once
    var workerNames = workerTypes.map(function (x) {
      return x.workerType;
    });

    debug('configured workers:           %j', workerNames);
    debug('managed requests/instances:   %j', that.awsManager.knownWorkerTypes());
    var houseKeeping = [
      that.awsManager.rougeKiller(workerNames),
      that.awsManager.zombieKiller(),
      that.awsManager.ensureTags(),
    ];

    // Remember that this thing caches stuff inside itself
    Array.prototype.push.apply(houseKeeping, workerNames.map(function (name) {
      return that.awsManager.createKeyPair(name);
    }));

    // We're just intercepting here... we want to pass the
    // resolution value this handler got to the next one!
    return Promise.all(houseKeeping).then(function () {
      return res;
    });
  });

  p = p.then(function (res) {
    var workerTypes = res[0];
    var pricing = res[2];
    return Promise.all(workerTypes.map(function (workerType) {
      return that.provisionType(workerType, pricing);
    }));
  });

  return p;
};

/**
 * Figure out how to create the launch information based on a bid then
 * insert the secrets into the secret storage
 */
Provisioner.prototype.spawn = function (workerType, bid) {
  assert(workerType);
  assert(bid);

  var launchInfo = workerType.createLaunchSpec(bid.region, bid.type);

  // This should probably move from here to createLaunchSpec but that
  // can happen later
  launchInfo.launchSpec.Placement = {
    AvailabilityZone: bid.zone,
  };

  var p = this.Secret.create({
    token: launchInfo.securityToken,
    workerType: workerType.workerType,
    secrets: launchInfo.secrets,
    scopes: launchInfo.scopes,
    expiration: taskcluster.fromNow('40 minutes'),
  });

  p = p.then(()=> {
    this.awsManager.requestSpotInstance(launchInfo, bid);
  });

  return p;
};

/**
 * Provision a specific workerType.  This promise will have a value of true if
 * everything worked.  Another option is resolving to the name of the worker to
 * make it easier to see which failed, but I'd prefer that to be tracked in the
 * caller. Note that awsState as passed in should be specific to a workerType
 */
Provisioner.prototype.provisionType = function (workerType, pricing) {
  var that = this;

  var p = this.queue.pendingTasks(this.provisionerId, workerType.workerType);

  p = p.then(function (result) {
    var pending = result.pendingTasks;
    // Remember that we send the internally tracked state so that we can
    // offset the count that we get here
    var runningCapacity = that.awsManager.capacityForType(workerType, ['running']);
    var pendingCapacity = that.awsManager.capacityForType(workerType, ['pending', 'spotReq']);
    var change = workerType.determineCapacityChange(runningCapacity, pendingCapacity, pending);

    debug('%s: %d running capacity, %d pending capacity and %d pending jobs',
        workerType.workerType, runningCapacity, pendingCapacity, pending);

    if (typeof pending !== 'number') {
      console.error(pending);
      pending = 0;
      debug('GRRR! Queue.pendingTasks(str, str) is returning garbage!  Assuming 0');
    }

    // Report on the stats for this iteration
    that.reportProvisioningIteration({
      provisionerId: that.provisionerId,
      workerType: workerType.workerType,
      pendingTasks: pending,
      runningCapacity: runningCapacity,
      pendingCapacity: pendingCapacity,
      change: change,
    });

    if (change > 0) {
      // We want to create bids when we have a change or when we have less then the minimum capacity
      var bids = workerType.determineSpotBids(that.awsManager.ec2.regions, pricing, change);
      var q = Promise.resolve();
      // To avoid API errors, we're going to run all of these promises sequentially
      // and with a slight break between the calls
      bids.forEach(function (bid) {
        q = q.then(function () {
          return new Promise(function (resolve, reject) {
            setTimeout(function () {
              that.spawn(workerType, bid).then(resolve, reject);
            }, 500);
          });
        });

        // We don't want to stop provisioning because one instance failed, but we will
        // increase the time out a little
        q = q.catch(function (err) {
          console.log('[alert-operator] ' + workerType.workerType + ' ' + err);
          console.log(err.stack);

          return new Promise(function (resolve, reject) {
            setTimeout(function () {
              that.spawn(workerType, bid).then(resolve, reject);
            }, 1500);
          });
        });
      });

      return q;
    } else if (change < 0) {
      // We want to cancel spot requests when we no longer need them, but only
      // down to the minimum capacity
      var capacityToKill = -change;
      debug('killing up to %d capacity', capacityToKill);
      return that.awsManager.killCapacityOfWorkerType(workerType, capacityToKill, ['pending', 'spotReq']);
    } else {
      debug('no change needed');
    }

  });

  return p;
};
