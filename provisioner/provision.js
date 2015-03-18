'use strict';

var Promise = require('promise');
var debug = require('debug')('aws-provisioner:provision');
var assert = require('assert');
var WatchDog = require('../lib/watchdog');

var MAX_PROVISION_ITERATION = 1000 * 60 * 10; // 10 minutes

// Docs for Ec2: http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/EC2.html


/**
 * A Provisioner knows how to use an AWS Manager and WorkerType to do provisioning.
 * It does not understand itself how to do AWS things or Azure things, it just
 * knows how and when certain things need to occur for provisioning to happen
 */
function Provisioner(cfg) {
  // We should have an AwsManager
  assert(cfg.awsManager);
  this.awsManager = cfg.awsManager;

  // We should have a WorkerType Entity
  assert(cfg.WorkerType);
  this.WorkerType = cfg.WorkerType;

  // We should have a Queue
  assert(cfg.queue);
  this.queue = cfg.queue;

  // We should have a Pricing Cache
  assert(cfg.pricingCache);
  this.pricingCache = cfg.pricingCache;

  // This is the ID of the provisioner.  It is used to interogate the queue
  // for pending tasks
  assert(cfg.provisionerId);
  assert(typeof cfg.provisionerId === 'string');
  this.provisionerId = cfg.provisionerId;

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

/**
 * Start running a provisioner.
 */
Provisioner.prototype.run = function () {
  var that = this;

  this.__keepRunning = true;
  this.__watchDog.on('expired', function() {
    debug('[alert-operator] Provisioner is stuck, killing');
    throw new Error('WatchDog expired');
  });
  this.__watchDog.start();

  function provisionIteration() {
    debug('starting iteration %d, successes %d, failures %d',
          stats.iterations++,
          stats.success,
          stats.failure);

    that.__watchDog.touch();

    // We should make sure that we're not just permanently failing
    // We also don't want to
    if (stats.iterations > 20 && stats.failures > 2 * stats.success) {
      debug('[alert-operator] killing provisioner because it has run ' +
            'for a while but has failed lots of iterations');
      throw new Error('provisioner is failing a lot');
    }

    var p = that.runAllProvisionersOnce();

    p = p.then(function() {
      stats.success++;
      if (that.__keepRunning && !process.env.PROVISION_ONCE) {
        debug('success. next iteration in %d seconds',
          Math.round(that.provisionIterationInterval / 1000));
        setTimeout(provisionIteration, that.provisionIterationInterval);
      } else {
        debug('Done! Not scheduling another provisioning iteration');
      }
    });

    p = p.catch(function(err) {
      stats.failure++;
      debug('[alert-operator] failure in provisioning');
      if (err.stack) {
        debug('[alert-operator] %s', err.stack.replace('\n', '\\n'));
      }
      setTimeout(provisionIteration, that.provisionIterationInterval);
    });
  }

  // To ensure that the first iteration is not called differently that
  // subsequent ones, we'll call it with a zero second timeout
  setTimeout(provisionIteration, 0);

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
Provisioner.prototype.runAllProvisionersOnce = function() {
  var that = this;

  var p = Promise.all([
    this.WorkerType.loadAll(),
    this.awsManager.update(),
    // Remember that we cache pricing data!
    this.pricingCache.get(),
  ]);

  p = p.then(function(res) {
    // We'll do a little house keeping before we pass the stuff
    // on to the actual provisioning logic
    var workerTypes = res[0];

    // We'll use this twice here... let's generate it only once
    var workerNames = workerTypes.map(function(x) {
      return x.workerType;
    });

    var houseKeeping = [that.awsManager.rougeKiller(workerNames)];

    // Remember that this thing caches stuff inside itself
    Array.prototype.push.apply(houseKeeping, workerNames.map(function(name) {
      return that.awsManager.createKeyPair(name);
    }));

    // We're just intercepting here... we want to pass the
    // resolution value this handler got to the next one!
    return Promise.all(houseKeeping).then(function() {
      return res;
    });
  });

  p = p.then(function(res) {
    var workerTypes = res[0];
    var pricing = res[2];
    return Promise.all(workerTypes.map(function(workerType) {
      return that.provisionType(workerType, pricing);
    }));
  });

  return p;
};


/**
 * Provision a specific workerType.  This promise will have a value of true if
 * everything worked.  Another option is resolving to the name of the worker to
 * make it easier to see which failed, but I'd prefer that to be tracked in the
 * caller. Note that awsState as passed in should be specific to a workerType
 */
Provisioner.prototype.provisionType = function(workerType, pricing) {
  var that = this;

  var p = this.queue.pendingTasks(this.provisionerId, workerType.workerType);

  p = p.then(function (result) {
    var pending = result.pendingTasks;
    // Remember that we send the internally tracked state so that we can
    // offset the count that we get here
    var runningCapacity = that.awsManager.capacityForType(workerType, ['running']);
    var pendingCapacity = that.awsManager.capacityForType(workerType, ['pending', 'spotReq']);
    var totalCapacity = runningCapacity + pendingCapacity;

    if (typeof pending !== 'number') {
      console.error(pending);
      pending = 0;
      debug('GRRR! Queue.pendingTasks(str, str) is returning garbage!  Assuming 0');
    }

    if (totalCapacity < workerType.maxCapacity) {
      return workerType.determineSpotBids(
        that.awsManager.managedRegions(),
        pricing,
        runningCapacity,
        pendingCapacity,
        pending
      );
    } else {
      // This is where we should kill excess capacity
      // TODO: Kill all spot requests here
      return [];
    }

  });

  p = p.then(function(bids) {
    return Promise.all(bids.map(function(bid) {
      return that.awsManager.requestSpotInstance(workerType, bid);
    }));
  });

  return p;
};
