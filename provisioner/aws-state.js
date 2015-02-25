'use strict';

var Promise = require('promise');
var lodash = require('lodash');
var util = require('util');
var Cache = require('../cache');
var assert = require('assert');


/**
 * Return a promise that resolves to an AWS State object.  We do this
 * so that we can grab the state using promises but then inspect state
 * using synchronus methods, as they're all just list processing
 */
function fetchState(ec2, keyPrefix) {
  var that = this;

  var p = Promise.all([
    ec2.describeInstances({
      Filters: [{
        Name: 'key-name',
        Values: [keyPrefix + '*']
      },{
        Name: 'instance-state-name',
        Values: ['running', 'pending']
      }
    ]}),
    ec2.describeSpotInstanceRequests({
      Filters: [{
        Name: 'launch.key-name',
        Values: [keyPrefix + '*']
      }, {
        Name: 'state',
        Values: ['open']
      }]
    }),
  ]);

  p = p.then(function(res) {
    return new AwsState(keyPrefix, _classify(ec2.regions, keyPrefix, res[0], res[1])
    );
  });

  return p;
}

module.exports = fetchState;

/**
 * AWS EC2 state at a specific moment in time
 */
function AwsState(keyPrefix, state) {
  this.__state = state;
  this.keyPrefix = keyPrefix;
}


/**
 * Classify the state received from AWS into something in the shape:
 * {
 *   region: {
 *     workerTypeName: {
 *       running: [<Instance>],
 *       pending: [<Instance>],
 *       spotReq: [<SpotRequest>],
 *     }
 *   }
 * }
 * The Instance and SpotRequest objects are those returned by AWS.
 * We flatten the Reservations because we don't really care about that
 * feature right now.
 */
function _classify(regions, keyPrefix, instanceState, spotReqs) {
  var that = this;
  var state = {};

  regions.forEach(function(region) {
    var rState = state[region] = {};

    function x(type) {
      if (!rState[type]) {
        rState[type] = {
          running: [],
          pending: [],
          spotReq: [],
        };
      }
    }

    instanceState[region].Reservations.forEach(function(reservation) {
      reservation.Instances.forEach(function(instance) {
        var workerType = instance.KeyName.substr(keyPrefix.length);
        x(workerType);
        rState[workerType][instance.State.Name].push(instance); 
      });
    });

    spotReqs[region].SpotInstanceRequests.forEach(function(request) {
      var workerType = request.LaunchSpecification.KeyName.substr(keyPrefix.length);
    }); 

  });

  return state;

};


/**
 * Return a list workerTypes known to AWS
 */
AwsState.prototype.knownWorkerTypes = function() {
  var workerTypes = [];
  var that = this;

  Object.keys(this.__state).forEach(function(region) {
    Object.keys(that.__state[region]).forEach(function(workerType) {
      if (workerTypes.indexOf(workerType) === -1) {
        workerTypes.push(workerType);
      }
    });
  });

  return workerTypes;

};


/**
 * Count the capacity of this workerType that are in the states specified
 * by `states`.  Doing this uses the Capcity key from the workerType's
 * types dictionary.  Remember that capacity is the number of tasks
 * that this instance/request will be able to service
 */
AwsState.prototype.capacityForType = function(workerType, states) {
  var that = this;
  var wName = workerType.workerType;
  var capacity = 0;
  if (!states) {
    states = ['running', 'pending', 'spotReq'];
  }

  // This is a mapping between EC2 Instance Type and Capacity Unit Count
  var capMap = {};
  Object.keys(workerType.types).forEach(function(type) {
    capMap[type] = workerType.types[type].capacity;
  });

  // Find instances and add them to the capacity
  workerType.listRegions().forEach(function(region) {
    var rState = that.__state[region]; 

    if (!rState[wName]) {
      return;
    }
    
    var wState = rState[wName];

    if (states.indexOf('running') !== -1) {
      wState.running.forEach(function(instance) {
        capacity += capMap[instance.InstanceType];
      });
    }

    if (states.indexOf('pending') !== -1) {
      wState.pending.forEach(function(instance) {
        capacity += capMap[instance.InstanceType];
      });
    }

    if (states.indexOf('spotReq') !== -1) {
      wState.spotReq.forEach(function(request) {
        capacity += capMap[request.LaunchSpecification.InstanceType];
      });
    }

  });

  return capacity;
  
};

