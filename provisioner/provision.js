'use strict';

var Promise = require('promise');
var _debug = require('debug');
var baseDbgStr = 'aws-provisioner'; 
var generalDebug = require('debug')(baseDbgStr + ':general');
var base = require('taskcluster-base');
var taskcluster = require('taskcluster-client');
var lodash = require('lodash');
var uuid = require('node-uuid');
var util = require('util');
var data = require('./data');
var awsState = require('./aws-state');
var awsPricing = require('./aws-pricing');
var Cache = require('../cache');
var assert = require('assert');

var MAX_PROVISION_ITERATION = 1000 * 60 * 20; // 20 minutes

// Docs for Ec2: http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/EC2.html


/**
 * A provisioner object represents our knowledge of how to take AWS state, pricing data
 * and WorkerType definitions and provision EC2 instances.  It does not understand
 * how to actually create instances or fetch the state or pricing, rather it defers
 * to the workerType to create instances and the state and pricing determine all of
 * the relevant facts needed
 */
function Provisioner(cfg) {
  // This is the ID of the provisioner.  It is used to interogate the queue
  // for pending tasks
  assert(cfg.provisionerId);
  assert(typeof cfg.provisionerId === 'string');
  this.provisionerId = cfg.provisionerId;

  // This is a prefix which we use in AWS to determine ownership
  // of a given instance.  If we could tag instances while they were
  // still spot requests, we wouldn't need to do this.
  assert(cfg.awsKeyPrefix);
  assert(typeof cfg.awsKeyPrefix === 'string');
  this.awsKeyPrefix = cfg.awsKeyPrefix;

  // This is the number of milliseconds to wait between completed provisioning runs
  assert(cfg.provisionIterationInterval);
  assert(typeof cfg.provisionIterationInterval === 'number')
  assert(!isNaN(cfg.provisionIterationInterval));
  this.provisionIterationInterval = cfg.provisionIterationInterval;

  // This is the Queue object which we use for things like retreiving
  // the pending jobs.
  assert(cfg.taskcluster);
  assert(cfg.taskcluster.credentials)

  // We only grab the credentials for now, no need to store them in this object
  this.Queue = new taskcluster.Queue({credentials: cfg.taskcluster.credentials});

  // We need a set up WorkerType reference
  assert(cfg.WorkerType);
  this.WorkerType = cfg.WorkerType;
  
  // We want the subset of AWS regions to use
  assert(cfg.allowedAwsRegions);
  this.allowedAwsRegions = cfg.allowedAwsRegions;

  // We need a configured EC2 instance
  assert(cfg.ec2);
  this.ec2 = cfg.ec2;

  this.__provRunId = 0;

  // We cache aws pricing data because it's not important to be completely fresh
  this.pricingCache = new Cache(15, awsPricing, this.ec2);
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
    awsState(this.ec2, this.awsKeyPrefix),
    // Remember that we cache pricing data!
    this.pricingCache.get(),
  ]);

  p = p.then(function(res) {
    var workerTypes = res[0];
    var state = res[1];
    var pricing = res[2];

    that.reconcileNewlyTracked(debug, state);

    debug('AWS knows of these workerTypes: %s', JSON.stringify(state.knownWorkerTypes()));
    // We could probably combine this with the .map of workerTypes below... meh...
    debug('There are workerType definitions for these: %s', JSON.stringify(workerTypes.map(function(x) {
      return x.workerType;
    })));

    return Promise.all(workerTypes.map(function(workerType) {
      // We should be able to filter by a specific workerType
      var wtDebug = 
        _debug(baseDbgStr + ':workerType_' + workerType.workerType + ':run_' + that.__provRunId);
      return that.provisionType(wtDebug, workerType, state, pricing);
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
Provisioner.prototype.provisionType = function(debug, workerType, state, pricing) {
  var that = this;

  var p = this.Queue.pendingTasks(this.provisionerId, workerType.workerType);

  p = p.then(function (pending) {
    // Remember that we send the internally tracked state so that we can
    // offset the count that we get here
    var capacity = state.capacityForType(workerType);

    if (typeof pending !== 'number') {
      pending = 0;
      debug('GRRR! Queue.pendingTasks(str, str) is returning garbage!  Assuming 0');
    }

    debug('capacity %d, pending: %d', capacity, pending);

    if (capacity < workerType.maxCapacity) {
      return workerType.determineSpotBids(debug, pricing, capacity, pending);
    } else {
      // This is where we should kill excess capacity
      return []
    }

  });

  p = p.then(function(bids) {
    return Promise.all(bids.map(function(bid) {
      return state.requestSpotInstance(workerType, bid);
    }));
  });

  return p;
};


/**
 * When we have too many instances or outstanding spot requests, we should kill
 * spot requests and pending jobs.  We should also have a sanity threshold of
 * maxCapacity * 2 which will start to kill running instances
 */
Provisioner.prototype.killExcess = function(debug, workerType, capacity) {
  throw new Error('Implement me!');
};





