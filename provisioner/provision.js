'use strict';

//var Promise = require('promise');
var Promise = require('promise');
var debug = require('debug')('aws-provisioner:provisioner:provision');
var base = require('taskcluster-base');
var aws = require('aws-sdk-promise');
var taskcluster = require('taskcluster-client');
var lodash = require('lodash');

var ec2 = module.exports.ec2 = new aws.EC2({'region': 'us-west-2'});

var Queue = new taskcluster.Queue();

/* I don't want to do any setup in this module... This function should be
 * passed in a configured base.Entity, which will be used in this function.
 * I'm open to a better way to do this */
var WorkerType;
var ProvisionerId;
var KeyPrefix;
function init (id, wt, kp) {
  ProvisionerId = id;
  WorkerType = wt;
  KeyPrefix = kp;
}
module.exports.init = init;

/* Influx DB
    - probably in queue
    - tests in base.
 */


// XXX: We should make allowed instances this a mapping between
// instance-type and launch spec overrides that should happen instance type
// should have a utility value, how much better than a standard unit type
// -- for figuring out which config to buy also store the capacity per
// instance type bug about not giving each worker type star creds, temp
// credentials in userdata

/*
  TODO:

  1. Store instance type dictionary
  2. Figure out capacity instead of number of running nodes
  3. 

*/ 


/* This is the main entry point into the provisioning routines.  It will
 * return an array of promises with the outcome of provisioning */
function provisionAll() {
  // We grab the pending task count here instead of in the provisionForType
  // method to avoid making a bunch of unneeded API calls
  debug('Running provisionAll()');

  return new Promise(function(resolve, reject) {
    Promise.all([
      Queue.pendingTaskCount(ProvisionerId),
      WorkerType.loadAllNames(),
      awsState(),
    ]).then(function(res) {
      var pendingTaskCount = res.shift();
      var workerTypes = res.shift();
      var awsState = res.shift();

      debug('Found managed AWSzeug: %s', JSON.stringify(Object.keys(awsState)));
      debug('Found workerTypes: %s', JSON.stringify(workerTypes));

      var provisioningPromises = workerTypes.map(function(workerType) {
        return provisionForType(workerType, awsState[workerType] || {}, pendingTaskCount[workerType] || 0);
      });

      return Promise.all(provisioningPromises);
    }, reject);
  });
}
module.exports.provisionAll = provisionAll;


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
function awsState() {
  /* To make this multiregion we should
     1. pass in a regions list which is all allowed regions in all worker types
     2. create a list of promises for each region
     3. for each region, run the instance/spotreq queries
     4. join everything together
   */
  debug('Starting to find aws state');
  return new Promise(function(resolve, reject) {
    var allState = {};
    // If I don't use exports., sinon is unable to actually stub this
    awsStateAwsCalls().then(function(res) {
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

      resolve(allState);

    }, reject).done();
  });
}

/* Provision a specific workerType.  This promise will have a value of true if
 * everything worked.  Another option is resolving to the name of the worker to
 * make it easier to see which failed, but I'd prefer that to be tracked in the
 * caller. Note that awsState as passed in should be specific to a workerType
 */
function provisionForType(name, awsState, pending) {
  debug('Provising Worker Type %s', name);
  return new Promise(function(resolve, reject) {
    WorkerType.load(name).then(function(workerType) {
     debug('Provisioning for %s', name);

      // Gather all the information we need
      var infoPromises = Promise.all([
        countRunningCapacity(workerType, awsState),
      ]);

      infoPromises.then(function(res) {
        var runningCapacityCount = res[0] || 0

        var capacityChange = determineCapacityChange(
          workerType.scalingRatio,
          runningCapacityCount,
          pending
        );

        debug('Capacity should %s by %d capacity units',
              capacityChange > 0 ? 'increase' : 'decrease',
              capacityChange);

        createOrDestroy(workerType, awsState, capacityChange).then(resolve, reject);
      });
    }, reject);
  });
}

/* Count the amount of capacity that's running or pending */
function countRunningCapacity(workerType, awsState) {
  // For now, let's assume that an existing node is occupied
  var capacity = 0;

  /* Remember that the allowedInstanceTypes is like this:
     { 
      'instance-type': {
        'capacity': 3,
        'utilityFactor': 4,
        'overwrites': {}
      }
     } */
  var capacities = {};
  Object.keys(workerType.allowedInstanceTypes).forEach(function(type) {
    capacities[type] = workerType.allowedInstanceTypes[type].capacity;   
  });

  // We are including pending instances in this loop because we want to make
  // sure that they aren't ignored and duplicated
  [].concat(awsState.running).concat(awsState.pending).forEach(function(instance) {
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
  
  return Promise.resolve(capacity);
}
module.exports._countRunningCapacity = countRunningCapacity;

/* Make choices about whether machines should be created or destroyed.
   The promise returned resolves to the list of ec2 reponses from either
   of the appropriate api method */
function createOrDestroy(workerType, awsState, capacityChange) {
  if (capacityChange > 0) {
    return spawnInstances(workerType, awsState, capacityChange);   
  } else if (capacityChange < 0) {
    return destroyInstances(workerType, awsState, -capacityChange);   
  } else {
    return Promise.resolve([]);
  }
}

/* Create Machines! */
function spawnInstances(workerType, awsState, capacityNeeded) {
  return new Promise(function(resolve, reject) {
    var launchSpecs = [];

    var spotBidPrices = {};
    // This probably shouldn't be a while loop... does this
    // block the interpreter waiting on async results?
    while (capacityNeeded-- >= 0) { // Likely candidate for off by one!
      Promise.all([
        pickInstanceType(workerType, awsState, capacityNeeded),
        pickInstanceType(workerType, awsState, capacityNeeded),
      ]).then(function(res) {
        var region = res[0]; // only used later when we do multi-region
        var instanceType = res[1];

        var _overwrites = workerType.allowedInstances[instanceType].overwrites;
        createLaunchSpec(workerType, _overwrites, region).then(function(launchSpec) {
          launchSpecs.push(launchSpec) 
        }).done();
      }, reject);
    }

    var promises = [];
    var spotBids = {};

    launchSpecs.forEach(function(spec) {
      promises.push(ec2.requestSpotInstance({
        SpotPrice: workerType.maxSpotBid, // Thinking about it, this should probably move
                                          // into the instance type key so that we can set
                                          // per ec2-instanceType
        InstanceCount: 1,
        Type: 'one-time',
        LaunchSpecification: spec,
        DryRun: true,
      }).promise()) 
    });

    Promise.all(launchSpecs).then(resolve, reject);
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
    DryRun: true,
    SpotInstanceRequestId: awsState.requestedSpot.slice(0, srToCancel).map(function(x) {
      return x.SpotInstanceRequestId
    })
  }));

  var instancesToKill = capacityToKill - srToCancel;

  var instancesToKill = [].concat(awsState.pending).concat(awsState.running).slice(0, instancesToKill)

  promises.push(ec2.terminateInstances({
    DryRun: true,
    InstanceIds: instancesToKill.map(function(x) {
      x.InstanceId;
    })
  }));

  return Promise.all(promises);
}

function spotBid(region, instanceType) {
  return Promise.resolve(0.5);
}

/* Pick which instance type should be created.  We want to
   make sure that we select a variety of instance types to not put all
   eggs in one basket.  We'll use the utility factor and pricing data
   to ensure that we pick the best value for the money instance type
   NOTE: For now we're just going to pick the first instance type
*/
function pickInstanceType(workerType, awsState) {
  return Promise.resolve(Object.keys(workerType.allowedInstances)[0]);
}

/* Pick which awsRegion to create or destroy in.  We want to make sure
   that even besides price that we don't always pick the same region.
   Ideally, we would say that no region can have more than 80% of all
   nodes.  When destroying is true, we use the opposite logic and say 
   that we are picking the region from which to evict a node.
   NOTE: we're just returning the first available region for now
 */
function pickRegion(workerType, awsState, destroying) {
  // Should probably use DescribeSpotPriceHistory
  return Promise.resolve(workerType.allowedRegions[0]);
}

/* Create a launch spec with values overwritten for a given aws instance type.
   the instanceTypeParam is the overwrites object from the allowedInstances
   workerType field */
function createLaunchSpec(workerType, overwrites) {
  var actual = lodash.clone(overwrites);
  return Promise.resolve(lodash.defaults(actual, workerType.launchSpecification));
}

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


/* Flow for monitoring nodes:

   1. provisioner provides node with URL that it should hit every X minutes to prove it's alive
      and give a 'utilization' percentage and another URL to ping when it changes from Occupied to Non-Occupied
   2. provisioner monitors the results from these hits and when it thinks there's a dead
      machine, kill it with fire

*/
