'use strict';

var Promise = require('promise');
var lodash = require('lodash');
var assert = require('assert');
var debug = require('debug')('aws-provisioner:aws-manager');

/**
 * AWS EC2 state at a specific moment in time
 */
function AwsManager(ec2, keyPrefix, pubKey) {
  assert(ec2);
  assert(keyPrefix);
  assert(pubKey);
  this.ec2 = ec2;
  this.keyPrefix = keyPrefix;
  this.pubKey = pubKey;
  this.__apiState = {};
  this.__internalState = {};
  this.__knownKeyPairs = [];
}

module.exports = AwsManager;

/**
 * Update the state from the AWS API and return a promise
 * with no resolution value when completed.
 */
AwsManager.prototype.update = function() {
  var that = this;

  var p = Promise.all([
    that.ec2.describeInstances({
      Filters: [
        {
          Name: 'key-name',
          Values: [that.keyPrefix + '*'],
        },
        {
          Name: 'instance-state-name',
          Values: ['running', 'pending'],
        },
      ],
    }),
    that.ec2.describeSpotInstanceRequests({
      Filters: [
        {
          Name: 'launch.key-name',
          Values: [that.keyPrefix + '*'],
        }, {
          Name: 'state',
          Values: ['open'],
        },
      ],
    }),
  ]);

  p = p.then(function(res) {
    var filteredSpotRequests = that._filterSpotRequests(res[1]);
    that.__apiState = that._classify(res[0], filteredSpotRequests.good);
    return that.handleStalledRequests(filteredSpotRequests.stalled);
  });

  p = p.then(function() {
    // We want to make sure that our internal state is always up to date when
    // we fetch the updated state
    that._reconcileInternalState();
  });

  return p;
};

/**
 * Handle SpotRequests that we consider to have stalled.
 * For now, this means just cancel them.  In future this
 * will do nifty things like maintaining state about which
 * type/region/zone combinations are not working well right
 * now
 */
AwsManager.prototype.handleStalledRequests = function(spotReqs) {
  var that = this;
  return Promise.all(Object.keys(spotReqs).map(function(region) {
    return that.killCancel(region, [], spotReqs[region].map(function(sr) {
      debug('killing stalled spot request ' + sr.SpotInstanceRequestId);
      return sr.SpotInstanceRequestId;
    }));
  }));
};

/**
 * We want to separate spot requests into two buckets:
 *   * those which are going to be fulfilled quickly
 *   * those which should be canceled because of AWS
 * This function returns an object with the spot requests sorted
 * into these buckets.
 */
AwsManager.prototype._filterSpotRequests = function(spotReqs) {
  var data = {
    good: {},
    stalled: {},
  };
  Object.keys(spotReqs).forEach(function(region) {
    data.good[region] = [];
    data.stalled[region] = [];

    spotReqs[region].SpotInstanceRequests.forEach(function(sr) {
      // These are states which have a state of 'open' but which
      // are likely not to be fulfilled expeditiously
      var stalledStates = [
        'capacity-not-available',
        'capacity-oversubscribed',
        'price-too-low',
        'not-scheduled-yet',
        'launch-group-constraint',
        'az-group-constraint',
        'placement-group-constraint',
        'constraint-not-fulfillable ',
      ];

      if (stalledStates.includes(sr.Status.Code)) {
        data.stalled[region].push(sr);
      } else {
        data.good[region].push(sr);
      }

    });
  });

  return data;
};

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
AwsManager.prototype._classify = function(instanceState, spotReqs) {
  var that = this;
  var state = {};

  that.ec2.regions.forEach(function(region) {
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
        var workerType = instance.KeyName.substr(that.keyPrefix.length);
        x(workerType);
        rState[workerType][instance.State.Name].push(instance);
      });
    });

    spotReqs[region].forEach(function(request) {
      var workerType = request.LaunchSpecification.KeyName.substr(that.keyPrefix.length);
      x(workerType);
      rState[workerType].spotReq.push(request);
    });

  });

  return state;
};

/**
 * Return API tracked state.  If region is passed as first param, the returned
 * object will be for that region.  If region and type are passed as params,
 * the state for that region and worker type is returned
 */
AwsManager.prototype.getApi = function(region, type) {
  if (region && type) {
    if (!this.__apiState[region]) {
      return {};
    }
    return this.__apiState[region][type] || {
      running: [],
      pending: [],
      spotReq: [], 
    };
  } else if (region && !type) {
    return this.__apiState[region];
  } else if (!region && !type) {
    return this.__apiState;
  }
};

/**
 * Return Internally tracked state.  If region is passed as first param, the
 * returned object will be for that region.  If region and type are passed as
 * params, the state for that region and worker type is returned.  Remember
 * that Internal state contains an extra Container object which contains the
 * the raw `request`, the `workerType` name, the `bid` and a datetime of when
 * it was `submitted`
 */
AwsManager.prototype.getInternal = function(region, type) {
  if (region && type) {
    if (!this.__internalState[region]) {
      return {};
    }
    return this.__internalState[region][type] || {
      running: [],
      pending: [],
      spotReq: [], 
    };
  } else if (region && !type) {
    return this.__internalState[region];
  } else if (!region && !type) {
    return this.__internalState;
  }
};

/**
 * List the types known worker types in a given region
 */
AwsManager.prototype.workerTypesInRegion = function(region) {
  assert(region);
  var apiState = this.getApi(region) || {};
  var internalState = this.getInternal(region) || {};

  var types = Object.keys(apiState);
  Array.prototype.push.apply(types, Object.keys(internalState).filter(function(type) {
    return !types.includes(type);
  }));
  return types;
};

/**
 * List the regions that this Manager is configured to
 * manage
 */
AwsManager.prototype.managedRegions = function () {
  return lodash.clone(this.ec2.regions);
};

/**
 * Return a list of workerTypes known to AWS
 */
AwsManager.prototype.knownWorkerTypes = function() {
  var workerTypes = [];
  var that = this;

  this.managedRegions().forEach(function(region) {
    that.workerTypesInRegion(region).forEach(function(workerType) {
      if (!workerTypes.includes(workerType)) {
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
AwsManager.prototype.listRunningInstanceIds = function() {
  var allIds = [];
  var that = this;

  this.managedRegions().forEach(function(region) {
    that.workerTypesInRegion(region).forEach(function(workerType) {
      var ids = that.getApi(region, workerType).running.map(function(x) {
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
AwsManager.prototype.listPendingInstanceIds = function() {
  var allIds = [];
  var that = this;

  this.managedRegions().forEach(function(region) {
    that.workerTypesInRegion(region).forEach(function(workerType) {
      var ids = that.getApi(region, workerType).pending.map(function(x) {
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
AwsManager.prototype.listSpotUnfulfilledRequestIds = function() {
  var allIds = [];
  var that = this;

  this.managedRegions().forEach(function(region) {
    that.workerTypesInRegion(region).forEach(function(workerType) {
      var ids = that.getApi(region, workerType).spotReq.map(function(x) {
        return x.SpotInstanceRequestId;
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
AwsManager.prototype.listSpotRequestIds = function() {
  var ids = [];
  var that = this;

  this.managedRegions().forEach(function(region) {
    that.workerTypesInRegion(region).forEach(function(workerType) {
      that.getApi(region, workerType).spotReq.forEach(function(x) {
        ids.push(x.SpotInstanceRequestId);
      });
      that.getApi(region, workerType).running.forEach(function(x) {
        if (x.SpotInstanceRequestId) {
          ids.push(x.SpotInstanceRequestId);
        }
      });
      that.getApi(region, workerType).pending.forEach(function(x) {
        if (x.SpotInstanceRequestId) {
          ids.push(x.SpotInstanceRequestId);
        }
      });
    });
  });

  return ids;
};

/**
 * Count the capacity of this workerType that are in the states specified
 * by `states`.  Doing this uses the Capacity key from the workerType's
 * types dictionary.  Remember that capacity is the number of tasks
 * that this instance/request will be able to service.
 * If specified, `extraSpotRequests` is a dictionary which contains a region
 * and worker type categorized list of outstanding spot requests
 */
AwsManager.prototype.capacityForType = function(workerType, states) {
  assert(workerType);
  var that = this;
  var wName = workerType.workerType;
  var capacity = 0;
  if (!states) {
    states = ['running', 'pending', 'spotReq'];
  }

  // Find instances in the retrevied state and add them to the capacity
  // according to their declared capacity
  this.ec2.regions.forEach(function(region) {
    var rState = that.getApi(region);

    if (!rState[wName]) {
      return;
    }

    var wState = rState[wName];

    if (states.includes('running')) {
      wState.running.forEach(function(instance) {
        capacity += workerType.capacityOfType(instance.InstanceType);
      });
    }

    if (states.includes('pending')) {
      wState.pending.forEach(function(instance) {
        capacity += workerType.capacityOfType(instance.InstanceType);
      });
    }

    if (states.includes('spotReq')) {
      wState.spotReq.forEach(function(request) {
        capacity += workerType.capacityOfType(request.LaunchSpecification.InstanceType);
      });
    }
  });

  // Extra spot requests are those which known to the provisioner but aren't
  // available yet through the API.  We want to make sure that they are counted
  // in the available capacity so that we don't resubmit requests for them
  // over and over again
  Object.keys(this.getInternal()).forEach(function(region) {
    var wState = that.getInternal(region, workerType.workerType);

    var notInApi = 0;

    if (wState && states.includes('spotReq')) {
      wState.spotReq.forEach(function(sr) {
        capacity += workerType.capacityOfType(sr.request.LaunchSpecification.InstanceType);
        notInApi++;
      });
      if (notInApi > 0) {
        debug('%d instances (not capacity) not showing up in API calls', notInApi);
      }
    }
  });

  return capacity;
};

/**
 * Because the AWS is eventually consistent, it will sometimes take time for
 * spot requests to show up in the describeSpotInstanceRequests calls for
 * AWS state.  We will maintain an internal table of these submitted but
 * not yet visible spot requests so that we can offset the count of a given
 * instance type for figuring out running capacity.  If the provisioning
 * process is restarted before the spot request shows up in the api's
 * state we will lose track of it until it turns into an instance.
 */
AwsManager.prototype._trackNewSpotRequest = function(sr) {
  // sr is a SpotRequest object which we get back from the
  // AWS Api when we submit the SpotRequest
  assert(sr);

  var that = this;
  var allKnownIds = this.listSpotRequestIds();

  // Ensure that there are places in the internal state for
  // new state information
  if (!this.__internalState[sr.bid.region]) {
    this.__internalState[sr.bid.region] = {};
  }
  if (!this.__internalState[sr.bid.region][sr.workerType]) {
    this.__internalState[sr.bid.region][sr.workerType] = {
      running: [],
      pending: [],
      spotReq: [],
    };
  }

  // Store the new spot request in the internal state
  if (!allKnownIds.includes(sr.request.SpotInstanceRequestId)) {
    that.__internalState[sr.bid.region][sr.workerType].spotReq.push(sr);
  }
};

/**
 * Once a SpotRequest shows up in the state returned from the AWS api
 * we should remove it from the internal state of spot requests that
 * is needed.  We do this before running the provisioner of each
 * workerType to avoid double counting a newly discovered spot request
 */
AwsManager.prototype._reconcileInternalState = function() {
  // Remove the SRs which AWS now tracks from internal state

  var that = this;
  var now = new Date();
  var allKnownIds = this.listSpotRequestIds();

  this.managedRegions().forEach(function(region) {
    that.workerTypesInRegion(region).forEach(function(type) {
      if (that.__internalState[region] && that.__internalState[region][type]) {
        // We could also splice the items to delete out, but that feels like
        // an over-optimization right now
        that.__internalState[region][type].spotReq = that.__internalState[region][type].spotReq.filter(function(sr) {
          var id = sr.request.SpotInstanceRequestId;
          if (!allKnownIds.includes(id)) {
            debug('request %s for %s in %s not showing up in api calls', id, type, region);
            return true;
          } else {
            var delay = now - sr.submitted;
            debug('%s took up to %d seconds to show up in AWS api', id, delay / 1000);
            return false;
          }
        });
      }
    });
  });
};

/**
 * Create an instance of a WorkerType and track it.  Internally,
 * we will track the outstanding spot requests until they are seen
 * in the EC2 API.  This makes sure that we don't ignroe spot requests
 * that we've made but not yet seen.  This avoids run-away provisioning
 */
AwsManager.prototype.requestSpotInstance = function(workerType, bid) {
  var that = this;
  assert(bid, 'Must specify a spot bid');
  assert(typeof bid.price === 'number', 'Spot Price must be number');

  assert(workerType.getRegion(bid.region));
  assert(workerType.getInstanceType(bid.type));

  assert(this.managedRegions().includes(bid.region));

  var launchSpec = workerType.createLaunchSpec(bid.region, bid.type, this.keyPrefix);

  // Add the availability zone info
  launchSpec.Placement = {
    AvailabilityZone: bid.zone,
  };

  var p = this.ec2.requestSpotInstances.inRegion(bid.region, {
    InstanceCount: 1,
    Type: 'one-time',
    LaunchSpecification: launchSpec,
    SpotPrice: bid.price.toString(),
  });

  p = p.then(function(spotRequest) {
    // We only do InstanceCount == 1, so we'll hard code only caring about the first sir
    return spotRequest.SpotInstanceRequests[0];
  });

  p = p.then(function(spotReq) {
    debug('submitted spot request %s for $%d for %s in %s/%s for %s',
      spotReq.SpotInstanceRequestId, bid.price, workerType.workerType, bid.region, bid.zone, bid.type);
    var userData = new Buffer(launchSpec.UserData, 'base64').toString();
    userData = JSON.stringify(JSON.parse(userData), null, 2);
    debug('Used this userdata: %s', userData);
    var info = {
      workerType: workerType.workerType,
      request: spotReq,
      bid: bid,
      submitted: new Date(),
    };
    return info;
  });

  p = p.then(function(info) {
    that._trackNewSpotRequest(info);
  });

  return p;
};

/**
 * We use KeyPair names to determine ownership and workerType
 * in the EC2 world because we can't tag SpotRequests until they've
 * mutated into Instances.  This sucks and all, but hey, what else
 * can we do?  This method checks which regions have the required
 * KeyPair already and creates the KeyPair in regions which do not
 * already have it.  Note that the __knownKeyPair cache should never
 * become shared, since we rely on it not surviving restarts in the
 * case that we start running this manager in another region.  If
 * we didn't dump the cache, we could create the key in one region
 * but not the new one that we add.  TODO: Look into what happens
 * when we add a region to the list of allowed regions... I suspect
 * that we'll end up having to track which regions the workerName
 * is enabled in.
 */
AwsManager.prototype.createKeyPair = function(workerName) {
  assert(workerName);
  var that = this;
  var keyName = this.keyPrefix + workerName;

  if (this.__knownKeyPairs.includes(workerName)) {
    // Short circuit checking for a key but return
    // a promise so this cache is invisible to the
    // calling function from a non-cached instance
    return Promise.resolve();
  }

  var p = this.ec2.describeKeyPairs.inRegions(this.ec2.regions, {
    Filters: [
      {
        Name: 'key-name',
        Values: [keyName],
      },
    ],
  });

  p = p.then(function(res) {
    var toCreate = [];

    that.ec2.regions.forEach(function(region) {
      var matchingKey = res[region].KeyPairs[0];
      if (!matchingKey) {
        debug('creating missing key %s in %s', keyName, region);
        toCreate.push(that.ec2.importKeyPair.inRegion(region, {
          KeyName: keyName,
          PublicKeyMaterial: that.pubKey,
        }));
      }
    });
    return Promise.all(toCreate);
  });

  p = p.then(function() {
    that.__knownKeyPairs.push(workerName);
  });

  return p;

};

/**
 * Delete a KeyPair when it's no longer needed.  This method
 * does nothing more and you shouldn't run it until you've turned
 * everything off.
 */
AwsManager.prototype.deleteKeyPair = function(workerName) {
  assert(workerName);
  var that = this;

  var keyName = this.keyPrefix + workerName;

  var p = this.ec2.describeKeyPairs({
    Filters: [
      {
        Name: 'key-name',
        Values: [keyName],
      },
    ],
  });

  p = p.then(function(res) {
    return Promise.all(that.managedRegions().filter(function(region) {
      return !!res[region].KeyPairs[0];
    }).map(function(region) {
      debug('deleting key %s in %s', keyName, region);
      return that.ec2.deleteKeyPair.inRegion(region, {
        KeyName: keyName,
      });
    }));
  });

  p = p.then(function() {
    that.__knownKeyPairs = that.__knownKeyPairs.filter(function(knownKeyPair) {
      return knownKeyPair !== workerName;
    });
  });

  return p;

};

/**
 * Rouge Killer.  A rouge is an instance that has a KeyPair name
 * that belongs to this provisioner but is not present in the list
 * of workerNames provided.  We can also use this to shut down all
 * instances of everything if we just pass an empty list of workers
 * which will say to this function that all workerTypes are rouge.
 * Sneaky, huh?
 */
AwsManager.prototype.rougeKiller = function(configuredWorkers) {
  assert(configuredWorkers);
  var that = this;
  var workersInState = this.knownWorkerTypes();
  var rouge = [];
  debug(workersInState);
  debug(configuredWorkers);

  workersInState.filter(function(name) {
    return !configuredWorkers.includes(name);
  }).forEach(function(name) {
    debug('killing rouge instances for type %s', name);
    rouge.push(that.deleteKeyPair(name));
    rouge.push(that.killByName(name));
  });

  return Promise.all(rouge);
};

/**
 * Kill all instances in all regions of a given workerName.  
 */
AwsManager.prototype.killByName = function(name, states) {
  var deaths = [];
  var that = this;
  if (!states) {
    states = ['running', 'pending', 'spotReq'];
  }

  that.managedRegions().forEach(function(region) {
    var apiState = that.getApi(region, name) || {};
    var internalState = that.getInternal(region, name) || {};

    var instances = [];
    var requests = [];

    [apiState, internalState].forEach(function(state) {
      if (states.includes('running') && state.running) {
        Array.prototype.push.apply(instances, state.running.map(function(r) {
          return r.InstanceId;
        }));
      }

      if (states.includes('pending') && state.pending) {
        Array.prototype.push.apply(instances, state.pending.map(function(r) {
          return r.InstanceId;
        }));
      }

      if (states.includes('spotReq') && state.spotReq) {
        Array.prototype.push.apply(requests, state.spotReq.map(function(r) {
          // Remember that internal state is wrapped with some meta data!
          if (r.request) {
            return r.request.SpotInstanceRequestId;
          } else {
            return r.SpotInstanceRequestId;
          }
        }));
      }
    });

    deaths.push(that.killCancel(region, instances, requests));
  });

  return Promise.all(deaths);
};

/**
 * Kill instances and cancel spot requests
 */
AwsManager.prototype.killCancel = function(region, instances, requests) {
  assert(instances || requests);
  var that = this;

  var promises = [];
  var i = instances || [];
  var r = requests || [];

  if (i.length > 0) {
    debug('killing instances %s in %j', i, region);
    promises.push(that.ec2.terminateInstances.inRegion(region, {
      InstanceIds: i,
    }));
  }

  if (r.length > 0) {
    debug('cancelling spot requests %j in %s', r, region);
    promises.push(that.ec2.cancelSpotInstanceRequests.inRegion(region, {
      SpotInstanceRequestIds: r,
    }));
  }

  return Promise.all(promises);
};


/**
 * Kill spot requests to change negatively by a capacity unit change.
 * We use this function to do things like canceling spot requests that
 * exceed the number we require.
 */
AwsManager.prototype.killCapacityOfWorkerType = function(workerType, count, states) {
  assert(workerType);
  assert(typeof count === 'number');
  assert(states);
  var minCap = workerType.minimumCapacity;
  // Utility Factors, by instance type
  var caps = {};
  var that = this;

  workerType.instanceTypes.forEach(function(t) {
    caps[t.instanceType] = workerType.capacityOfType(t.instanceType);
  });

  var capToKill = 0;
  var capacity = this.capacityForType(workerType, states);

  // We use the list to track which spot requests to ignore
  // and the object to pass to the aws functions.  This is instead
  // of making a clone of state then deleting things from it.
  var toKill = [];
  var requestsToCancel = [];

  function cont() {
    return count <= capToKill && capacity >= workerType.minCapacity;
  }

  this.managedRegions().forEach(function(region) {
    var instances = [];
    var requests = [];
    var state = that.getApi(region);
    // We do pending first since it won't kill anything
    // in progress

    if (cont() && states.includes('pending') && state.pending) {
      state.running.forEach(function(i) {
        if (cont()) {
          capToKill += caps[i.InstanceType];
          toKill[region].instances.push(i.InstanceId);
        }
      });
    }

    if (cont() && states.includes('running') && state.running) {
      state.running.forEach(function(i) {
        if (cont()) {
          capToKill += caps[i.InstanceType];
          toKill[region].instances.push(i.InstanceId);
        }
      });
    }

    if (cont() && states.includes('spotReq') && state.spotReq) {
      state.spotReq.forEach(function(sr) {
        if (cont()) {
          capToKill += caps[sr.LaunchSpecification.InstanceType];
          toKill[region].instances.push(sr.LaunchSpecification.InstanceType);
        }
      });
    }
    
    toKill.push(that.killCancel(region, instances, requests));
  });

  return Promise.all(toKill);
  
};
