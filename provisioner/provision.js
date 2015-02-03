'use strict';

//var Promise = require('promise');
var Promise = require('promise');
var debug = require('debug')('aws-provisioner:provisioner:provision');
var base = require('taskcluster-base');
var aws = require('aws-sdk-promise');
var taskcluster = require('taskcluster-client');
var lodash = require('lodash');
var uuid = require('node-uuid');



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

*/ 


/* This is the main entry point into the provisioning routines.  It will
 * return an array of promises with the outcome of provisioning */
function provisionAll() {
  // We grab the pending task count here instead of in the provisionForType
  // method to avoid making a bunch of unneeded API calls
  debugger;
  return new Promise(function (resolve, reject) {
    var runId = uuid.v4();
    debug('Beginning provisioning run %s', runId);
    Promise.all([
      Queue.pendingTaskCount(ProvisionerId),
      WorkerType.loadAllNames(),
      awsState()
    ]).then(function(res) {
      var pendingTasks = res.shift();
      var workerTypes = res.shift();
      var awsState = res.shift();

      debug('AWS State for runId %s: ', runId, JSON.stringify(Object.keys(awsState)));
      debug('WorkerTypes for runId %s: ', runId, JSON.stringify(workerTypes));

      var wtRunIds = [];
      var p = workerTypes.map(function(workerType) {
        var wtRunId = uuid.v4();
        debug('Worker Type %s for runId %s has wtRunId of %s', workerType, runId, wtRunId);
        wtRunIds.push(wtRunId);
        return provisionForType(wtRunId, workerType, awsState[workerType] || {}, pendingTasks[workerType] || 0);
      });

      Promise.all(p).then(function(res2) {
        debug('Completed provisioning run %s', runId);
        workerTypes.forEach(function(wt, idx) {
          debug('Completed provisioning worker type %s with wtRunId %s', wt, wtRunIds[idx]);
        });
        resolve();
      }).catch(function(err) { reject(err) }).done();
      
    }).done();
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
function provisionForType(wtRunId, name, awsState, pending) {
  return new Promise(function(resolve, reject) {
    WorkerType.load(name).then(function(workerType){
      var infoPromises = [
        countRunningCapacity(workerType, awsState),
      ];

      Promise.all(infoPromises).then(function(res){
        var capacity = res[0] || 0; 

        var change = determineCapacityChange(
          workerType.scalingRatio,
          capacity,
          pending
        );

        debug('Capacity change: %d', change);
        resolve(change);
      }).then(function(change){
        createOrDestroy(workerType, awsState, change).then(function(){
          resolve(); 
        }).catch(function(err) {
          resolve(err)
        }).done();
      }).done();
    }).done(); 
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
  var allInstances = [];
  if (awsState.running) {
    allInstances.concat(awsState.running);
  }
  if (awsState.pending) {
    allInstances.concat(awsState.pending);
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
