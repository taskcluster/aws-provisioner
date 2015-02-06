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
var InstancePubKey;

function init (_cfg, wt) {
  cfg = _cfg;

  ProvisionerId = cfg.get('provisioner:id');
  WorkerType = wt;
  KeyPrefix = cfg.get('provisioner:awsKeyPrefix');
  InstancePubKey = cfg.get('provisioner:awsInstancePubkey'); 

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
   5. schema for allowedinstancetypes should ensure overwrites.instancetype exists
   7. kill instances when we exceed the max capacity
  11. make this an object
  12. pricing history should use the nextToken if present to
  13. store requests and instance data independently from AWS so that we don't have issues
      with the eventual consistency system.  This will also let us track when
      a spot request is rejected
  14. We should only kill orphans which have been orphaned for X hours in case of accidentally
      deleting the workerTypes

  To make this multiregion we should
   1. pass in a regions list which is all allowed regions in all worker types
   2. create a list of promises for each region
   3. for each region, run the instance/spotreq queries
   4. join everything together
 */


/* This is the main entry point into the provisioning routines.  It will
 * return an array of promises with the outcome of provisioning */
function provisionAll() {
  // We grab the pending task count here instead of in the provisionForType
  // method to avoid making a bunch of unneeded API calls

  var pendingTasks;
  var workerTypes;
  var awsState;
  var pricing;
  var runId = uuid.v4();
  var wtRunIds = [];

  debug('%s Beginning provisioning run %s', ProvisionerId, runId);
  var p = Promise.all([
    Queue.pendingTaskCount(ProvisionerId),
    WorkerType.loadAll(),
    fetchAwsState()
  ]);

  p = p.then(function(res) {
    pendingTasks = res.shift();
    workerTypes = res.shift();
    awsState = res.shift();

    debug('%s AWS has instances of workerTypes: %s', runId, JSON.stringify(Object.keys(awsState)));
    // We could probably combine this with the .map of workerTypes below... meh...
    debug('%s WorkerType Definitions for %s', runId, JSON.stringify(workerTypes.map(function(x) {
      return x.workerType;
    })));

    return res;
  });

  p = p.then(function() {
    return Promise.all([
        fetchSpotPricingHistory(workerTypes),
        killOrphans(awsState, workerTypes),
    ]);
  });

  p = p.then(function(res) {
    pricing = res[0].data.SpotPriceHistory;
    debug('%s Fetched EC2 Pricing data', runId);
    debug('%s Killed these orphaned instances: %s', runId, res[1]);
    return res; 
  });


  p = p.then(function() {
    return Promise.all(workerTypes.map(function(workerType) {
      var wtRunId = uuid.v4();
      wtRunIds.push(wtRunId);
      debug('%s[%s] == %s worker', runId, workerType.workerType, wtRunId);
      var workerState = awsState[workerType.workerType] || {};
      var pendingForWorker = pendingTasks[workerType.workerType] || 0;
      return provisionForType(wtRunId, workerType, workerState, pricing, pendingForWorker);
    }));
  });

  p = p.then(function(res) {
    workerTypes.forEach(function(workerType, idx) {
      debug('%s Completed provisioning for worker type %s', wtRunIds[idx], workerType.workerType);
    });
    debug('%s Provisioning run completed', runId); 
    return res;
  });

  return p;
}
module.exports.provisionAll = provisionAll;


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
  var p = Promise.all([
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

  p = p.then(function(res) {
    var allState = {};
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

/* When we find an EC2 instance or spot request that is for a workerType that we
 * don't know anything about, we will kill it.  NOTE: We currently do this as soon
 * as the workerType definition is not found, but we should probably do something
 * like wait for it to be gone for X hours before deleting it. */
function killOrphans(awsState, workerTypes) {
  var extant = Object.keys(awsState);
  var known = workerTypes.map(function(x) { return x.workerType });
  var orphans = extant.filter(function(x) { return known.indexOf(x) > 0 });
  var instances = [];
  var srs = [];

  orphans.forEach(function(name) {
    Array.prototype.push.apply(instances, awsState[name].running.map(function(x) { return x.InstanceId; }));
    Array.prototype.push.apply(instances, awsState[name].pending.map(function(x) { return x.InstanceId; }));
    Array.prototype.push.apply(srs, awsState[name].requestedSpot.map(function(x) { return x.SpotInstanceRequestId; }));
  });

  var killinators = [];
 
  if (instances.length > 0) {
    killinators.push(ec2.terminateInstances({
      InstanceIds: instances,
    }).promise());
  } 

  if (srs.length > 0) {
    killinators.push(ec2.cancelSpotInstanceRequests({
      SpotInstanceRequestIds: srs,
    }).promise());
  }

  return Promise.all(killinators).then(function(res) {
    return Promise.resolve(orphans); 
  });
  
}



/* Provision a specific workerType.  This promise will have a value of true if
 * everything worked.  Another option is resolving to the name of the worker to
 * make it easier to see which failed, but I'd prefer that to be tracked in the
 * caller. Note that awsState as passed in should be specific to a workerType
 */
function provisionForType(wtRunId, workerType, awsState, pricing, pending) {
  var capacity;
  var change;

  var p = Promise.all([
    countRunningCapacity(workerType, awsState),
    assertKeyPair(workerType.workerType),
  ]);

  p = p.then(function (res) {
    debug('%s %s has %d existing capacity units and %d pending tasks',
      wtRunId, workerType.workerType, res[0], pending);
    capacity = res[0]; 
    return res;
  });

  p = p.then(function () {
    change = determineCapacityChange(workerType.scalingRatio, capacity, pending);
    if (capacity + change > workerType.maxInstances) {
      debug('%s %s a change of %d would exceed max of %d', wtRunId,
          workerType.workerType, change, workerType.maxInstances);
      change = capacity - workerType.maxInstances;
    } else if (capacity + change < workerType.minInstances) {
      debug('%s %s a change of %d would be less than min of %d', wtRunId,
          workerType.workerType, change, workerType.minInstances);
      change = workerType.minInstances - capacity;
    }
    debug('%s %s submitting request for %d more capacity units',
        wtRunId, workerType.workerType, change);
    return Promise.resolve(change);
  });

  p = p.then(function() {
    if (change <= 0) {
      debug('%s %s does not need more capacity', wtRunId, workerType.workerType);
      return Promise.resolve([]);
    }
    var spawners = [];
    while (change--) {
      spawners.push(spawnInstance(wtRunId, workerType, awsState, pricing));
    }
    return Promise.all(spawners);
  });
  
  return p;
}

/* Check that we have a public key and create it if we don't */
function assertKeyPair(workerTypeName) {
  /* This might be better to do in the provisionAll step once the 
     workertypes are loaded, then we can do a single key check per
     provisioning run */
  var keyName = KeyPrefix + workerTypeName;
  var p = ec2.describeKeyPairs({
    Filters: [{
      Name: 'key-name',
      Values: [keyName]
    }] 
  }).promise();

  p = p.then(function(res) {
    var matchingKey = res.data.KeyPairs[0];

    if (matchingKey) {
      return Promise.resolve();
    } else {
      return ec2.importKeyPair({
        KeyName: keyName,
        PublicKeyMaterial: InstancePubKey,
      }).promise().then(function () {
        return Promise.resolve();
      });
    }
  });

  return p;
}


/* Fetch the last hour of EC2 pricing data.  For now, we'll
 * only fetch the first page of data, but in the future we will
 * make sure to use the nextToken to read the whole thing in
 */
function fetchSpotPricingHistory(workerTypes) {
/*
   This promise is an object with a SpotInstances key that's a list of these:
   {
      InstanceType: 'r3.xlarge', 
      ProductDescription: 'Linux/UNIX', 
      SpotPrice: '0.042300', 
      Timestamp: Thu Feb 05 2015 14:23:31 GMT+0100 (CET), 
      AvailabilityZone: 'us-west-2c'
    }
 */

  var types = [];
  workerTypes.forEach(function(workerType) {
    if (workerType.launchSpecification.InstanceType) {
      types.push(workerType.launchSpecification.InstanceType);
    }
    Array.prototype.push.apply(types, Object.keys(workerType.allowedInstanceTypes));
  });

  var startDate = new Date();
  startDate.setHours(startDate.getHours() - 2);

  var p = ec2.describeSpotPriceHistory({
    StartTime: startDate,
    Filters: [{
      Name: 'product-description',
      Values: ['Linux/UNIX'],
    }],
    InstanceTypes: types,
  }).promise(); 

  return p;
};

/* Count the amount of capacity that's running or pending */
function countRunningCapacity(workerType, awsState) {
  // For now, let's assume that an existing node is occupied
  return new Promise(function(resolve, reject) {
    var capacity = 0;

    /* Remember that the allowedInstanceTypes is like this:
       { 
        'instance-type': {
          'capacity': 3,
          'utility': 4,
          'overwrites': {}
        }
       } */
    var capacities = {};
    Object.keys(workerType.allowedInstanceTypes).forEach(function(type) {
      capacities[type] = workerType.allowedInstanceTypes[type].capacity;   
    });

    // We are including pending instances in this loop because we want to make
    // sure that they aren't ignored and duplicated
    var instances = [];
    if (awsState.running) {
      Array.prototype.push.apply(instances, awsState.running);
    }
    if (awsState.pending) {
      Array.prototype.push.apply(instances, awsState.pending);
    }
    if (awsState.spotRequesets) {
      Array.prototype.push.apply(instances, awsState.spotRequests);
    }

    instances.forEach(function(instance, idx, arr) {
      var potentialCapacity = capacities[instance.InstanceType];
      if (potentialCapacity) {
        capacity += capacities[instance.InstanceType];
      } else {
        /* Rather than assuming that an unknown instance type has no capacity, we'll
           assume the basic value (1) and move on.  Giving any other value would be
           a bad idea, 0 means that we would be scaling indefinately and >1 would be
           making assumptions which are not knowable */
        capacity++;
      }
    });

    resolve(capacity);
      
  });
}
module.exports._countRunningCapacity = countRunningCapacity;

/* Create Machines! */
function spawnInstance(wtRunId, workerType, awsState, pricing) {
  var spotBid;
  var instanceType;
  var launchSpec;

  var p = determineSpotBid(workerType, awsState, pricing);

  p = p.then(function(bidInfo) {
    instanceType = bidInfo.instanceType;
    spotBid = bidInfo.spotBid;
    debug('%s %s will bid on %s instance for $%d',
      wtRunId, workerType.workerType, instanceType, spotBid);
    return bidInfo;
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

/* Given the pricing data, what's the average price for this instance type.
 * For now, we'll just pick the average of the most recent for each availability
 * zone.  In future we should do things like:
 *    - weight each AZ's price by how long it was the price
 *    - do other smart things
 */
function findPriceForType(pricing, type) {
  // This could probably be a single loop
  var onlyThisType = pricing.filter(function(x) {
    return x.InstanceType === type;
  });
  var azsSeen = [];
  var sum = 0;
  onlyThisType.forEach(function(histPoint) {
    if (azsSeen.indexOf(histPoint.AvailabilityZone) < 0) {
      sum += parseFloat(histPoint.SpotPrice);
      azsSeen.push(histPoint.AvailabilityZone);
    }
  });

  return sum / azsSeen.length;
}

/* Decide based on the utility factor which EC2 instance type we should be
 * creating.  Right now, we just pick the first one in the Object.keys list of
 * instanceTypes allowed for a workerType.  In the future the goal is to pick
 * the lowest of instanceType * instanceTypePrice.  The plan is to not pick
 * all instance to be exactly the same type.  Maybe we'll have a schema key
 * which specifies max percentage or something like that.  We return
 * an object which has the spot bid to use and the type of instance.
 * The spotbid is the best instance type's average spot price multiplied
 * by 1.3 (30% more than what it is right now)*/
function determineSpotBid(workerType, awsState, pricing) {
  var ait = workerType.allowedInstanceTypes; // shorthand!  
  
  return new Promise(function(resolve, reject) {
    var cheapestType;
    var cheapestPrice;
    var spotBid;
    var priceMap = {};

    Object.keys(ait).forEach(function(potentialType) {
      var potentialSpotBid = findPriceForType(pricing, potentialType);
      // Like capacity we assume that if a utility factor is not available
      // that we consider it to be the base (1)
      var potentialPrice = (ait[potentialType].utility || 1) * potentialSpotBid;
      if (!cheapestPrice || (potentialPrice < cheapestPrice && potentialSpotBid > workerType.maxSpotBid)) {
        cheapestPrice = potentialPrice;
        cheapestType = potentialType;
        // We bid a little higher because we don't want the machine to end
        // too soon
        spotBid = Math.ceil(potentialSpotBid * 1.3 * 1000000) / 1000000
        
      }
    });

    resolve({spotBid: spotBid, instanceType: cheapestType});
  });
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
    newSpec.InstanceType = instanceType;
    resolve(newSpec);
  });
}
module.exports._createLaunchSpec = createLaunchSpec;

/* Figure out how many capacity units need to be created.  This number is
 * determined by calculating how much capacity is needed to maintain a given
 * scaling ratio and returns the number of capacity units which need to be
 * created or destroyed.  This will give an exact number of units, something
 * else will be required to decide what to do if the number of needed capacity
 * units does not fit nicely with the number of capacity units available per
 * instance type.  Positive value means add capacity, negative means destroy */
function determineCapacityChange(scalingRatio, capacity, pending) {
  // We need to know the current ratio of capacity to pending
  var percentPending = 1 + pending / capacity;

  var change = 0;

  // We only want to scale anything once we have a pending
  // percentage that exceeds the scalingRatio
  if (percentPending > scalingRatio) {
    // But when we do, let's submit enough requests that
    // we end up in an ideal state if all are fulfilled
    var ideal = (capacity + pending) / scalingRatio;
    var change = ideal - capacity;
  }

  return Math.round(change);

}
module.exports._determineCapacityChange = determineCapacityChange;
