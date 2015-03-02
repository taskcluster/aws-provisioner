'use strict';

var Promise = require('promise');
var lodash = require('lodash');
var util = require('util');
var Cache = require('../cache');
var assert = require('assert');
var debug = require('debug')('aws-provisioner:aws-state');


/**
 * Return a promise that resolves to an AWS State object.  We do this
 * so that we can grab the state using promises but then inspect state
 * using synchronus methods, as they're all just list processing
 */
function fetchState(ec2, keyPrefix) {
  assert(ec2);
  assert(keyPrefix);
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
 * AWS EC2 state at a specific moment in time
 */
function AwsState(keyPrefix, state) {
  this.__state = state;
  this.keyPrefix = keyPrefix;
}


/**
 * Get the raw state
 */
AwsState.prototype.get = function(region, type) {
  if (region && type) {
    return this.__state[region][type];
  } else if (region && !type) {
    return this.__state[region];
  } else if (!region && !type) {
    return this.__state;
  }
};



/**
 * Return a list of workerTypes known to AWS
 */
AwsState.prototype.knownWorkerTypes = function() {
  var workerTypes = [];
  var that = this;

  this.regions().forEach(function(region) {
    that.typesForRegion(region).forEach(function(workerType) {
      if (workerTypes.indexOf(workerType) === -1) {
        workerTypes.push(workerType);
      }
    });
  });

  return workerTypes;

};


/**
 * Return a list of all running Instance Ids that are known in this AWS State
 * These are not categorized by region.  It's one list of strings.
 */
AwsState.prototype.listRunningInstanceIds = function() {
  var allIds = [];
  var that = this;

  this.regions().forEach(function(region) {
    that.typesForRegion(region).forEach(function(workerType) {
      var ids = that.__state[region][workerType].running.map(function(x) {
        return x.InstanceId;
      });
      Array.prototype.push.apply(allIds, ids);
    });
  });

  return allIds;
};


/**
 * Return a list of all pending Instance Ids that are known in this AWS State
 * These are not categorized by region. It's one list of strings.
 */
AwsState.prototype.listPendingInstanceIds = function() {
  var allIds = [];
  var that = this;

  this.regions().forEach(function(region) {
    that.typesForRegion(region).forEach(function(workerType) {
      var ids = that.__state[region][workerType].pending.map(function(x) {
        return x.InstanceId;
      });
      Array.prototype.push.apply(allIds, ids);
    });
  });

  return allIds;
};


/**
 * Return a list of all Spot Request Ids that are known in this AWS State
 * These are not categorized by region or by instance type. It's one
 * list of strings.
 */
AwsState.prototype.listSpotRequestIds = function() {
  var allIds = [];
  var that = this;

  this.regions().forEach(function(region) {
    that.typesForRegion(region).forEach(function(workerType) {
      var ids = that.__state[region][workerType].spotReq.map(function(x) {
        return x.SpotInstanceRequestId;
      });
      Array.prototype.push.apply(allIds, ids);
    });
  });

  return allIds;
};


/**
 * Count the capacity of this workerType that are in the states specified
 * by `states`.  Doing this uses the Capcity key from the workerType's
 * types dictionary.  Remember that capacity is the number of tasks
 * that this instance/request will be able to service.
 * If specified, `extraSpotRequests` is a dictionary which contains a region
 * and worker type categorized list of outstanding spot requests
 */
AwsState.prototype.capacityForType = function(workerType, extraSpotRequests, states) {
  assert(workerType);
  var that = this;
  var wName = workerType.workerType;
  var capacity = 0;
  if (!states) {
    states = ['running', 'pending', 'spotReq'];
  }

  // Find instances in the retrevied state and add them to the capacity
  // according to their declared capacity
  workerType.listRegions().forEach(function(region) {
    var rState = that.__state[region]; 

    if (!rState[wName]) {
      return;
    }
    
    var wState = rState[wName];

    if (states.indexOf('running') !== -1) {
      wState.running.forEach(function(instance) {
        capacity += workerType.capacityOfType(instance.InstanceType);
      });
    }

    if (states.indexOf('pending') !== -1) {
      wState.pending.forEach(function(instance) {
        capacity += workerType.capacityOfType(instance.InstanceType);
      });
    }

    if (states.indexOf('spotReq') !== -1) {
      wState.spotReq.forEach(function(request) {
        capacity += workerType.capacityOfType(request.LaunchSpecification.InstanceType);
      });
    }

  });

  // Extra spot requests are those which known to the provisioner but aren't
  // available yet through the API.  We want to make sure that they are counted
  // in the available capacity so that we don't resubmit requests for them
  // over and over again
  if (extraSpotRequests) {
    Object.keys(extraSpotRequests).forEach(function(region) {
      var srs = extraSpotRequests[region][workerType.workerType];
      srs.forEach(function(sr) {
        var type = sr.request.LaunchSpecification.InstanceType;
        capacity += workerType.capacityOfType(type);
      });
    });
  }

  return capacity;
};


/**
 * List all the regions known to this AWS State
 */
AwsState.prototype.regions = function() {
  return Object.keys(this.__state);
};


/**
 * List the types known in a given region
 */
AwsState.prototype.typesForRegion = function(region) {
  assert(region);
  return Object.keys(this.__state[region]);
};
