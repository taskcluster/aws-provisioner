'use strict';

//var Promise = require('promise');
var Promise = require('promise');
var debug = require('debug')('aws-provisioner:provisioner:provision');
var base = require('taskcluster-base');
var aws = require('aws-sdk-promise');
var taskcluster = require('taskcluster-client');
var lodash = require('lodash');
var uuid = require('node-uuid');
var util = require('util');

// Docs for Ec2: http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/EC2.html

/* I don't want to do any setup in this module... This function should be
 * passed in a configured base.Entity, which will be used in this function.
 * I'm open to a better way to do this */
var WorkerType;
var ProvisionerId;
var KeyPrefix;
var cfg;
var Queue;
var ec2;

function init (_cfg, wt) {
  cfg = _cfg;

  ProvisionerId = cfg.get('provisioner:id');
  WorkerType = wt;
  KeyPrefix = cfg.get('provisioner:awsKeyPrefix');

  Queue = new taskcluster.Queue({credentials: cfg.get('taskcluster:credentials')});
  ec2 = module.exports.ec2 = new aws.EC2(cfg.get('aws'));
}
module.exports.init = init;


/* Influx DB
    - probably in queue
    - tests in base.
 */

/*
  TODO:

  1. update schema to reflect the structure of the instance type dict
  2. sprinkle some uuids on debug messages for sanity's sake
  3. should delete instances that might've been managed by provisioner but aren't currently known
  4. figure out why promises are broken when returning promises from the .map() in provisionAll()
  5. schema for allowedinstancetypes should ensure overwrites.InstanceType exists
  6. schema should ensure UserData is all Base64 valid
  7. kill instances when we exceed the max capacity
  8. kill instances/sir when they aren't known on the workerType table
  9. create keypairs if they do not exist already

*/ 


/* This is the main entry point into the provisioning routines.  It will
 * return an array of promises with the outcome of provisioning */
function provisionAll() {
  // We grab the pending task count here instead of in the provisionForType
  // method to avoid making a bunch of unneeded API calls

  var pendingTasks;
  var workerTypes;
  var awsState;
  var runId = uuid.v4();
  var wtRunIds = [];

  debug('%s Beginning provisioning run %s', ProvisionerId, runId);
  var p = Promise.all([
    Queue.pendingTaskCount(ProvisionerId),
    WorkerType.loadAllNames(),
    fetchAwsState()
  ]);

  p = p.then(function(res) {
    pendingTasks = res.shift();
    workerTypes = res.shift();
    awsState = res.shift();
    debug('%s AWS State for runId: %s', runId, JSON.stringify(Object.keys(awsState)));
    debug('%s WorkerTypes for runId: %s', runId, JSON.stringify(workerTypes));
    //debug('%s Pending tasks for runId: ', runId, pendingTasks);

    return Promise.all(workerTypes.map(function(workerType) {
      var wtRunId = uuid.v4();
      wtRunIds.push(wtRunId);
      debug('%s[%s] == %s worker', runId, workerType, wtRunId);
      var workerState = awsState[workerType] || {};
      var pendingForWorker = pendingTasks[workerType] || 0;
      return provisionForType(wtRunId, workerType, workerState, pendingForWorker);
    }));
  });

  p = p.then(function(res) {
    workerTypes.forEach(function(workerType, idx) {
      debug('%s Completed provisioning for worker type %s', wtRunIds[idx], workerType);
    });
    debug('%s Provisioning run completed', runId); 
    return res;
  });
  return p;
}
module.exports.provisionAll = provisionAll;


/* Aws calls for finding state.  This is in it's own function to make
 * testing easier */
var awsStateAwsCalls = function () {
  return Promise.all([
    ec2.describeInstances({
      Filters: [{
        Name: 'key-name',
        Values: [KeyPrefix + '*']
      },{
        Name: 'instance-state-name',
        Values: ['running', 'pending']
      }
    ]}).promise(),
    ec2.describeSpotInstanceRequests({
      Filters: [{
        Name: 'launch.key-name',
        Values: [KeyPrefix + '*']
      }, {
        Name: 'state',
        Values: ['open']
      }]
    }).promise(),
  ]);
}

/* Figure out what the current state is for AWS ec2 for
   managed image types.  This returns an object in the form:
  {
    workerType1: {
      running: [<instance>, <instance>],
      pending: [<instance>],
      requested: [<spotrequeset>],
    }
    workerType2: ...
  }
*/
function fetchAwsState() {
  /* To make this multiregion we should
     1. pass in a regions list which is all allowed regions in all worker types
     2. create a list of promises for each region
     3. for each region, run the instance/spotreq queries
     4. join everything together
   */
  debug('Starting to find aws state');
  var p = awsStateAwsCalls()
  p = p.then(function(res) {
    var allState = {};
    debug('Retreived state from AWS');
    res[0].data.Reservations.forEach(function(reservation) {
      reservation.Instances.forEach(function(instance) {
        var workerType = instance.KeyName.substr(KeyPrefix.length);
        var instanceState = instance.State.Name;
        
        // Make sure we have the needed slots
        if (!allState[workerType]) {
          allState[workerType] = {};
        }
        if (!allState[workerType][instanceState]){
          allState[workerType][instanceState] = [];
        }

        allState[workerType][instanceState].push(instance);
      });
    });

    debug('Processed instance state');

    res[1].data.SpotInstanceRequests.forEach(function(request) {
      var workerType = request.LaunchSpecification.KeyName.substr(KeyPrefix.length);

      if (!allState[workerType]) {
        allState[workerType] = {};
      }
      if (!allState[workerType]['requestedSpot']){
        allState[workerType]['requestedSpot'] = [];
      }
      allState[workerType]['requestedSpot'].push(request);
    });

    return Promise.resolve(allState);
  });

  return p;
}

/* Provision a specific workerType.  This promise will have a value of true if
 * everything worked.  Another option is resolving to the name of the worker to
 * make it easier to see which failed, but I'd prefer that to be tracked in the
 * caller. Note that awsState as passed in should be specific to a workerType
 */
function provisionForType(wtRunId, name, awsState, pending) {
  var workerType;
  var capacity;
  var change;

  var p = WorkerType.load(name);
  p = p.then(function (_workerType) { 
    workerType = _workerType;
    return _workerType;
  });
  p = p.then(function() {
    debug(workerType);
    return countRunningCapacity(workerType, awsState);
  });
  p = p.then(function (_capacity) {
    debug('%s %s has %d existing capacity units and %d pending tasks',
      wtRunId, name, _capacity, pending);
    capacity = _capacity; 
    return _capacity;
  });
  p = p.then(function () {
    change = determineCapacityChange(workerType.scalingRatio, capacity, pending);
    debug('%s %s needs %d capacity units created', wtRunId, name, change);
    return Promise.resolve(change);
  });
  p = p.then(function() {
    if (change <= 0) {
      debug('%s %s does not need more capacity', wtRunId, name);
      return Promise.resolve([]);
    }
    var spawners = [];
    while (change--) {
      spawners.push(spawnInstance(wtRunId, workerType, awsState));
    }
    return Promise.all(spawners);
  });
  
  return p;
}

/* Count the amount of capacity that's running or pending */
function countRunningCapacity(workerType, awsState) {
  // For now, let's assume that an existing node is occupied
  return new Promise(function(resolve, reject) {
    var capacity = 0;

    debug('hi');
    /* Remember that the allowedInstanceTypes is like this:
       { 
        'instance-type': {
          'capacity': 3,
          'utilityFactor': 4,
          'overwrites': {}
        }
       } */
    var capacities = {};
    debug(workerType);
    Object.keys(workerType.allowedInstanceTypes).forEach(function(type) {
      capacities[type] = workerType.allowedInstanceTypes[type].capacity;   
    });


    // We are including pending instances in this loop because we want to make
    // sure that they aren't ignored and duplicated
    var allInstances = [];
    if (awsState.running) {
      allInstances.concat(awsState.running);
    }
    if (awsState.pending) {
      allInstances.concat(awsState.pending);
    }
    if (awsState.spotRequesets) {
      allInstances.concat(awsState.spotRequests);
    }
    allInstances.forEach(function(instance, idx, arr) {
      var potentialCapacity = capacities[instance.InstanceType];
      if (potentialCapacity) {
        debug('Instance type %s for workerType %s has a capacity of %d, adding to %d',
              instance.InstanceType, workerType.workerType, potentialCapacity, capacity);
        capacity += capacities[instance.InstanceType];
      } else {
        /* Rather than assuming that an unknown instance type has no capacity, we'll
           assume the basic value (1) and move on.  Giving any other value would be
           a bad idea, 0 means that we would be scaling indefinately and >1 would be
           making assumptions which are not knowable */
        debug('WorkerType %s does not list capacity for instance type %s, adding 1 to %d',
              workerType.workerType, instance.InstanceType, capacity);
        capacity++;
      }
    });

    resolve(capacity);
      
  });
}
module.exports._countRunningCapacity = countRunningCapacity;

/* Create Machines! */
function spawnInstance(wtRunId, workerType, awsState) {
  var spotBid;
  var instanceType;
  var launchSpec;

  var p = chooseInstanceType(workerType, awsState);
  p = p.then(function(_instanceType) {
    debug('%s %s will use instance type %s', wtRunId, workerType.workerType, _instanceType);
    instanceType = _instanceType;
    return _instanceType;
  });
  p = p.then(function() {
    return createLaunchSpec(workerType, instanceType);
  });
  p = p.then(function(_launchSpec) {
    debug('%s %s has a launch specification', wtRunId, workerType.workerType);
    //debug('Launch Spec: ' + JSON.stringify(_launchSpec));
    launchSpec = _launchSpec;
    return _launchSpec;
  });
  p = p.then(function() {
    return pickSpotBid(workerType, awsState, instanceType);
  });
  p = p.then(function(_spotBid) {
    debug('%s %s will have a spot bid of %d', wtRunId, workerType.workerType, _spotBid);
    spotBid = _spotBid; 
    return _spotBid;
  });
  p = p.then(function() {
    debug('%s %s is creating spot request', wtRunId, workerType.workerType)
    return ec2.requestSpotInstances({
      InstanceCount: 1,
      Type: 'one-time',
      LaunchSpecification: launchSpec,
      SpotPrice: String(spotBid).toString(),
    }).promise();
  });
  p = p.then(function(spotRequest) {
    // We only do InstanceCount == 1, so we'll hard code only caring about the first sir
    var sir = spotRequest.data.SpotInstanceRequests[0].SpotInstanceRequestId;
    debug('%s %s spot request %s submitted', wtRunId, workerType.workerType, sir);
    return Promise.resolve(sir);
  });
  return p;
}

/* Decide based on the utility factor which EC2 instance type we should be
 * creating.  Right now, we just pick the first one in the Object.keys list of
 * instanceTypes allowed for a workerType.  In the future the goal is to pick
 * the lowest of instanceType * instanceTypePrice.  The plan is to not pick
 * all instance to be exactly the same type.  Maybe we'll have a schema key
 * which specifies max percentage or something like that. */
function chooseInstanceType(workerType, awsState) {
  var instanceType = Object.keys(workerType.allowedInstanceTypes)[0];
  // TODO: We should allow instance type nicknames.  meh
  //var type = workerType.allowedInstanceTypes[instanceTypeTitle].overwrites.InstanceType;
  return Promise.resolve(instanceType);
}

/* Given an instanceType, pick what we should bid for the spot price */
function pickSpotBid(workerType, awsState, instanceType) {
  return Promise.resolve(workerType.maxSpotBid);
}

/* Destroy Machines! */
function destroyInstances(workerType, awsState, capacityToKill) {
  var promises = [];
  var srToCancel = 0;
  if (awsState.requestedSpot && awsState.requestedSpot.length > 0) {
    srToCancel = capacityToKill - awsState.requestedSpot.length;
    srToCancel = srToCancel > 0 ? srToCancel : 0;
  }

  promises.push(ec2.CancelSpotInstanceRequests({
    SpotInstanceRequestId: awsState.requestedSpot.slice(0, srToCancel).map(function(x) {
      return x.SpotInstanceRequestId
    })
  }));

  var instancesToKill = capacityToKill - srToCancel;

  var instancesToKill = [].concat(awsState.pending).concat(awsState.running).slice(0, instancesToKill)

  promises.push(ec2.terminateInstances({
    InstanceIds: instancesToKill.map(function(x) {
      x.InstanceId;
    })
  }));

  return Promise.all(promises);
}

var validB64Regex = /^[A-Za-z0-9+/=]*$/;

/* Create a launch spec with values overwritten for a given aws instance type.
   the instanceTypeParam is the overwrites object from the allowedInstances
   workerType field */
function createLaunchSpec(workerType, instanceType) {
  return new Promise(function(resolve, reject) {
    if (!workerType.allowedInstanceTypes[instanceType]) {
      reject(new Error(util.format('%s only allows [%s] instances, not %s',
            workerType.workerType,
            Object.keys(workerType.allowedInstanceTypes).join(', '),
            instanceType)));
    }
    var actual = lodash.clone(workerType.allowedInstanceTypes[instanceType].overwrites);
    var newSpec = lodash.defaults(actual, workerType.launchSpecification);
    if (!validB64Regex.exec(newSpec.UserData)) {
      reject(new Error(util.format('Launch specification does not contain Base64: %s', newSpec.UserData)));
    }
    newSpec.KeyName = KeyPrefix + workerType.workerType;
    resolve(newSpec);
  });
}
module.exports._createLaunchSpec = createLaunchSpec;

/* Figure out how many capacity units need to be created.  This number
   is determined by calculating how much capacity is needed to maintain a given
   scaling ratio and returns the number of capacity units which need to be
   created or destroyed.  This will give an exact number of units, something
   else will be required to decide what to do if the number of needed capacity
   units does not fit nicely with the number of capacity units available per
   instance type.  Positive value means add capacity, negative means destroy */
function determineCapacityChange(scalingRatio, capacity, pending) {

  var x = Math.ceil((capacity * scalingRatio) + pending) - capacity;

  // For now we don't bother with negative values because we can't 
  // ask machines to terminate, we can only force them off, which
  // we don't want to do
  return x > 0 ? x : 0;

}
module.exports._determineCapacityChange = determineCapacityChange;
