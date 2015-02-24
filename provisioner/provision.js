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

// Docs for Ec2: http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/EC2.html

/* Influx DB
    - probably in queue
    - tests in base.
 */

/*
  TODO: Things in here

   5. schema for allowedinstancetypes should ensure overwrites.instancetype exists
  12. pricing history should use the nextToken if present to
  13. store requests and instance data independently from AWS so that we don't have issues
      with the eventual consistency system.  This will also let us track when
      a spot request is rejected
  17. provide metrics on how long it takes for spot request to be filled, etc
  25. overwrite userdata with temporary taskcluster credentials as base64 encoded json
  28. pulse msg for taskPending, has provisioner id in it.  could use to maintain
      state of pending jobs
  35. Look at Rail's joi patch and figure out why things are breaking with it
  36. verify that errors dont bring down the whole process
  38. redo the excess unit killer
  39. when testing, alter the UserData instead of copying ami-id
  40. be able to encrypt UserData using opengpg.js

  TODO: Things in the server API

  29. do ami copy when machine is inserted or updated in the azure table storage
      http://aws.amazon.com/about-aws/whats-new/2013/03/12/announcing-ami-copy-for-amazon-ec2/
  36. add the following things:
        - api end point that lists all instances and spot requests in all regions
        - api end point that shuts off all instances managed by this provisioner
        - api end point to kill all instances of a specific type
        - api end point to show capacity, etc for each workerType

  TODO: Other
  30. add influx timing to the multiaws
  33. api endpoint when the machine comes up to tell us how long it took to turn on

  Questions:
  1. How can I get JSON Schema to say I need a dictionary, i don't care what its
     key names are, but I care that the key points to an object of a given shape
  
 */


/**
 * Create a Provisioner object.  This object knows how to provision
 * AWS Instances.  The config object should be structured like this:
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
    var p = that.runAllProvisionersOnce();
    p = p.then(function() {
      generalDebug('Finished a provision iteration');
      if (that.__keepRunning && !process.env.PROVISION_ONCE) {
        generalDebug('Scheduling another provisioning iteration');
        setTimeout(provisionIteration, that.provisionIterationInterval);
      } else {
        generalDebug('PROVISION_ONCE environment variable is set, ');
      }
    });
    p = p.catch(function(err) {
      generalDebug('Error running a provisioning iteration');
      generalDebug(err);
    });
  }

  provisionIteration();

};

/**
 * Stop launching new provisioner iterations
 */
Provisioner.prototype.stop = function () {
  this.__keepRunning = false;
};

/**
 * Run provisioners for all known worker types once
 */
Provisioner.prototype.runAllProvisionersOnce = function() {
  // We grab the pending task count here instead of in the provisionForType
  // method to avoid making a bunch of unneeded API calls

  var that = this;
  var debug = _debug(baseDbgStr + ':all:run_' + ++this.__provRunId);

  debugger;
  debug('%s Beginning provisioning iteration', this.provisionerId);
  var p = Promise.all([
    this.WorkerType.loadAll(),
    awsState(this.ec2, this.awsKeyPrefix),
    this.pricingCache.get(),
  ]);

  p = p.then(function(res) {
    var workerTypes = res[0];
    var state = res[1];
    var pricing = res[2];

    debug('AWS has instances of workerTypes: %s', JSON.stringify(state.knownWorkerTypes()));
    // We could probably combine this with the .map of workerTypes below... meh...
    debug('WorkerType Definitions for %s', JSON.stringify(workerTypes.map(function(x) {
      return x.workerType;
    })));

    return Promise.all(workerTypes.map(function(workerType) {
      var wtDebug = 
        _debug(baseDbgStr + ':' + workerType.workerType + ':run_' + that.__provRunId);
      return that.provisionType(wtDebug, workerType, state, pricing);
    }));
  });

  p = p.then(function(res) {
    debug('Completed provisioning iteration'); 
    return res;
  });

  return p;
}

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
    var capacity = state.capacityForType(workerType);

    if (typeof pending !== 'number') {
      pending = 0;
      debug('GRRR! Queue.pendingTasks(str, str) is returning garbage!  Assuming 0');
    }

    if (capacity < workerType.maxCapacity) {
      return workerType.provision(debug, pricing, capacity, pending);
    } else {
      // This is where we should kill excess capacity
      return []
    }

  });
  
  return p;
}


/**
 * Kill excess
 */
Provisioner.prototype.killExcess = function(debug, workerType, capacity) {

};
