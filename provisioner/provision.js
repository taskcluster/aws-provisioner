'use strict';

var Promise = require('promise');
var _debug = require('debug');
var baseDbgStr = 'aws-provisioner'; 
var generalDebug = require('debug')(baseDbgStr + ':general');
var base = require('taskcluster-base');
var lodash = require('lodash');
var uuid = require('node-uuid');
var util = require('util');
var data = require('./data');
var assert = require('assert');

var MAX_PROVISION_ITERATION = 1000 * 60 * 20; // 20 minutes

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
  assert(typeof cfg.provisionIterationInterval === 'number')
  assert(!isNaN(cfg.provisionIterationInterval));
  this.provisionIterationInterval = cfg.provisionIterationInterval;

  this.__provRunId = 0;
}

module.exports.Provisioner = Provisioner;

/**
 * Start running a provisioner.
 */
Provisioner.prototype.run = function () {
  var that = this;

  this.__keepRunning = true;

  function provisionIteration() {
    // We should cancel the last iteration's watch dog
    if (that.__watchdog) {
      clearTimeout(that.__watchdog);
    }
    // And make sure we set this one!
    that.__watchdog = setTimeout(function() {
      generalDebug('KILLING PROVISIONER BECAUSE IT APPEARS TO BE STUCK...');
      // Hmm, should I instead just process.exit(1);
      throw new Error('PROVISIONER HAS FALLEN AND CAN\'T GET BACK UP');
    }, MAX_PROVISION_ITERATION);

    var p = that.runAllProvisionersOnce();

    p = p.then(function() {
      if (that.__keepRunning && !process.env.PROVISION_ONCE) {
        generalDebug('Done! Scheduling another provisioning iteration');
        setTimeout(provisionIteration, that.provisionIterationInterval);
      } else {
        generalDebug('Done! Not scheduling another provisioning iteration');
      }
    });

    p = p.catch(function(err) {
      generalDebug('Error running a provisioning iteration');
      console.error(err, err.stack);
    });
  }

  provisionIteration();

};


/**
 * Stop launching new provisioner iterations but don't
 * end the current one
 */
Provisioner.prototype.stop = function () {
  this.__keepRunning = false;
  if (this.__watchdog) {
    clearTimeout(this.__watchdog);
  }
};


/**
 * Run provisioners for all known worker types once
 */
Provisioner.prototype.runAllProvisionersOnce = function() {

  var that = this;
  // So that we get per-iteration strings
  var debug = _debug(baseDbgStr + ':all:run_' + ++this.__provRunId);

  debug('%s Beginning provisioning iteration', this.provisionerId);
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

    debug('AWS knows of these workerTypes: %s', JSON.stringify(that.awsManager.knownWorkerTypes()));
    // We could probably combine this with the .map of workerTypes below... meh...
    debug('There are workerType definitions for these: %s', JSON.stringify(workerTypes.map(function(x) {
      return x.workerType;
    })));

    return Promise.all(workerTypes.map(function(workerType) {
      // We should be able to filter by a specific workerType
      var wtDebug = 
        _debug(baseDbgStr + ':workerType_' + workerType.workerType + ':run_' + that.__provRunId);
      return that.provisionType(wtDebug, workerType, pricing);
    }));
  });

  p = p.then(function(res) {
    debug('Completed provisioning iteration');
    return res;
  });

  return p;
};



/**
 * Provision a specific workerType.  This promise will have a value of true if
 * everything worked.  Another option is resolving to the name of the worker to
 * make it easier to see which failed, but I'd prefer that to be tracked in the
 * caller. Note that awsState as passed in should be specific to a workerType
 */
Provisioner.prototype.provisionType = function(debug, workerType, pricing) {
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

    debug('running capacity %d, pending capacity %d, pending tasks %s',
      runningCapacity, pendingCapacity, pending);

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
      return []
    }

  });

  p = p.then(function(bids) {
    return Promise.all(bids.map(function(bid) {
      return that.awsManager.requestSpotInstance(workerType, bid);
    }));
  });

  return p;
};
