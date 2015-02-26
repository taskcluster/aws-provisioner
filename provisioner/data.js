'use strict';
var base        = require('taskcluster-base');
var assert      = require('assert');
var Promise     = require('promise');
var lodash      = require('lodash');

var KEY_CONST = 'worker-type';


/**
 * This WorkerType class is used to store and manipulate the definitions
 * of worker types.  A WorkerType contains the information needed by
 * the provisioner to create workers.  This class also contains methods
 * which know how to create, alter and delete instances of these
 * WorkerTypes.  State and Pricing data which is used for provisioning
 * is not stored here.  The only time we fetch state here is for shutting
 * down everything.
 */
var WorkerType = base.Entity.configure({
  version: 1,
  partitionKey: base.Entity.keys.ConstantKey(KEY_CONST),
  rowKey: base.Entity.keys.StringKey('workerType'),
  properties: {
    /* This is a string identifier of the Worker Type.  It
     * is what we give to the Queue to figure out whether there
     * is pending work. */
    workerType: base.Entity.types.String,
    /* This is the basic AWS LaunchSpecification.  It is
     * stored as an opaque JSON blob and represents the
     * information which will be shared between all instances
     * of this worker across all regions and instance types */
    launchSpecification: base.Entity.types.JSON,
    /* This is the minimum capacity we will run */
    minCapacity: base.Entity.types.Number,
    /* This is the maximum capacity which we will ever run */
    maxCapacity: base.Entity.types.Number,
    /* Scaling ratio a ratio of pending jobs to capacity.  A number
     * which is between 0 and 1 will ensure that there is always 
     * idle capacity and a number greater than 1 will ensure that
     * some percentage of tasks will remain pending before we spawn
     * instances. */
    scalingRatio: base.Entity.types.Number,
    /* This is the minimum spot bid... It isn't actually read
     * and should be moved to the instance type definition... */
    minSpotBid: base.Entity.types.Number,
    maxSpotBid: base.Entity.types.Number,
    /* Right now this is ineffective */
    canUseOndemand: base.Entity.types.JSON,
    /* Right now this is ineffective */
    canUseSpot: base.Entity.types.JSON,
    /* This dictionary describes which instance types that this workerType
     * can run on as well as type-specific information.
     * This is a dictionary in the shape:
     * {
     *   'c1.small': {
     *     capacity: 1,
     *     utility: 1,
     *     overwrites: {}
     *   }
     * }
     * The top level key is the EC2 instance type which should
     * be used.  In each instance type, there are three keys:
     *   - capacity: this is the number of tasks this instance
     *               can run concurrently.
     *   - utility: this is an arbitrary number which we multiply
     *              by spot price and compare to other instance
     *              types to figure out which machine to bid on
     *   - overwrites: this object overwrites keys in the general
     *                 launch specification
     */
    types: base.Entity.types.JSON,
    /* This is a JSON object which contains the regions which this
     * workerType is allowed to run in as well as the region-specific
     * information.  It is in the shape:
     * {
     *   'us-west-1': {
     *     'overwrites': {
     *       'ImageId': 'ami-aaaaaaa'
     *      }
     *   }
     * } */
    regions: base.Entity.types.JSON,
  },
  context: ['ec2', 'keyPrefix', 'pubKey', 'influx'],
});


WorkerType.create = function(workerType, properties) {
  assert(workerType);
  assert(properties);
  properties.workerType = workerType;
  return base.Entity.create.call(this, properties);
};


WorkerType.loadAll = function() {
  var workers = [];

  var p = base.Entity.scan.call(this, {}, {
    handler: function (item) {
      workers.push(item);
    }
  });

  p = p.then(function() {
    return workers;
  });

  return p;
};


WorkerType.loadAllNames = function() {
  var names = [];

  var p = base.Entity.scan.call(this, {}, {
    handler: function (item) {
      names.push(item.workerType);
    }
  });

  p = p.then(function() {
    return names;
  });

  return p;
};


WorkerType.load = function(workerType) {
  assert(workerType);
  return base.Entity.load.call(this, {
    workerType: workerType
  });
};


/**
 * Return an Object for JSON encoding which represents
 * the data associated with this WorkerType
 */
WorkerType.prototype.json = function() {
  return lodash.clone(this.__properties);
};


/**
 * Return the list of regions which can be operated in.
 * This is a subset of the regions which a given node
 * is allowed to run in and the list of regions that the
 * API is configred to run in.
 */
WorkerType.prototype.listRegions = function() {
  var that = this;
  return Object.keys(this.regions).filter(function(region) {
    return that.ec2.regions.indexOf(region) !== -1;
  }); 
};


/**
 * We use KeyPair names to determine ownership and workerType
 * in the EC2 world because we can't tag SpotRequests until they've
 * mutated into Instances.  This sucks and all, but hey, what else
 * can we do?  This method checks which regions have the required
 * KeyPair already and creates the KeyPair in regions which do not
 * already have it
 */
WorkerType.prototype.createKeyPair = function() {
  var that = this;

  var keyName = this.keyPrefix + this.workerType;

  var p = this.ec2.describeKeyPairs.inRegions(this.listRegions(), {
    Filters: [{
      Name: 'key-name',
      Values: [keyName]
    }] 
  });

  p = p.then(function(res) {
    var toCreate = [];

    that.listRegions().forEach(function(region) {
      var matchingKey = res[region].KeyPairs[0];
      if (!matchingKey) {
        toCreate.push(that.ec2.importKeyPair.inRegion(region, {
          KeyName: keyName,
          PublicKeyMaterial: that.pubKey,
        }));
      } 
    });
    return Promise.all(toCreate);
  });

  return p;

};


/**
 * Delete a KeyPair when it's no longer needed.  This method
 * does nothing more and you shouldn't run it until you've turned
 * everything off.
 */
WorkerType.prototype.deleteKeyPair = function() {
  var that = this;

  var keyName = this.keyPrefix + this.workerType;

  var p = this.ec2.describeKeyPairs({
    Filters: [{
      Name: 'key-name',
      Values: [keyName]
    }] 
  });

  p = p.then(function(res) {
    var toDelete = [];

    that.listRegions().forEach(function(region) {
      var matchingKey = res[region].KeyPairs[0];
      if (matchingKey) {
        toDelete.push(that.ec2.deleteKeyPair.inRegion(region, {
          KeyName: keyName,
        }));
      } 
    });
    return Promise.all(toDelete);
  });

  return p;

};


/**
 * Turn off every single EC2 instance and cancel all spot
 * requests which were created by this Provisioner
 */
WorkerType.killEverything = function (debug) {
  assert(debug);
  var p = WorkerType.loadAll();

  p = p.then(function(workerTypes) {
    return Promise.all(workerTypes.map(function(workerType) {
      return workerType.killall(debug);
    }));
  });

  return p;
};


/**
 * Shutdown all instances of this workerType, cancel
 * any open spot requests.
 */
WorkerType.prototype.killAll = function(debug) {
  assert(debug);
  var that = this;
  var regionDeaths = {};

  var p = Promise.all([
    this.ec2.describeInstances({
      Filters: [{
        Name: 'key-name',
        Values: [this.keyPrefix + this.workerType]
      },{
        Name: 'instance-state-name',
        Values: ['running', 'pending']
      }
    ]}),
    this.ec2.describeSpotInstanceRequests({
      Filters: [{
        Name: 'launch.key-name',
        Values: [this.keyPrefix + this.workerType]
      }, {
        Name: 'state',
        Values: ['open']
      }]
    }),
  ]);

  p = p.then(function(res) {
    var killinators = [];
    that.listRegions().forEach(function(region) {
      var instances = [];
      var spotreqs = [];

      res[0][region].Reservations.forEach(function(reservation) {
        reservation.Instances.forEach(function(instance) {
          instances.push(instance.InstanceId);
          debug('Killing %s instance %s in %s',
            that.workerType, instance.InstanceId, region);
        });
      });

      res[1][region].SpotInstanceRequests.forEach(function(request) {
        spotreqs.push(request.SpotInstanceRequestId);
        debug('Cancelling %s spot request %s in %s',
          that.workerType, request.SpotInstanceRequestId, region);
      });

      if (instances.length > 0) {
        debug('Killing %d instances in %s', instances.length, region);
        killinators.push(that.ec2.terminateInstances.inRegion(region, {
          InstanceIds: instances,
        }));
      }

      if (spotreqs.length > 0) {
        debug('Cancelling %d spot requests in %s', spotreqs.length, region);
        killinators.push(that.ec2.cancelSpotInstanceRequests.inRegion(awsRegion, {
          SpotInstanceRequestIds: spotreqs,
        }));
      }

    });
    return Promise.all(killinators);
  });

  p = p.then(function(res) {
    debug('Submitted kill and cancel requests for %s', that.workerType);
  });

  return p;

};


/**
 * Provision a given workerType based on the pricing available, capacity existing
 * and number of pending tasks.
 */
WorkerType.prototype.provision = function(debug, pricing, capacity, pending) {
  assert(debug);
  assert(pricing);
  assert(capacity);
  assert(pending);
  var that = this;

  var spotBids = this.determineSpotBids(debug, pricing, capacity, pending);

  if (spotBids.length === 0) {
    debug('no spot requests will be created');
    return [];
  } else {
    debug('creating %d spot requests', spotBids.length);
    return Promise.all(spotBids.map(function(bid) {
      return that.spawn(debug, bid);
    }));
  }

  return p;
};


/**
 * Create an AWS LaunchSpecification for this workerType.  This method
 * does all the various overwriting of type and region specific LaunchSpecification
 * keys.
 */
WorkerType.prototype.createLaunchSpec = function(debug, region, instanceType) {
  assert(debug);
  assert(region);
  assert(instanceType);
  return WorkerType.createLaunchSpec(debug, region, instanceType, this, this.keyPrefix);
}

/**
 * Make sure that all combinations of LaunchSpecs work.  This sync
 * function will throw if there is an error found or will return
 * a dictionary of all the launch specs!
 */
WorkerType.prototype.testLaunchSpecs = function(debug) {
  assert(debug);
  return WorkerType.testLaunchSpecs(debug, this, this.keyPrefix);
}

/**
 * We need to be able to create a launch specification for testing without
 * already having an instance.  This is available as a non-instance method
 * so that we can create and test launch specifications before inserting
 * them into Azure.
 */
WorkerType.createLaunchSpec = function(debug, region, instanceType, worker, keyPrefix) {
  // These are the keys which are only applicable to a given region.
  assert(debug); 
  assert(worker);
  assert(keyPrefix);
  assert(worker.regions[region], region + ' is not configured');
  assert(worker.types[instanceType], instanceType + ' is not configured');
  var typeSpecificKeys = ['InstanceType'];

  // AMI/ImageId are per-region
  var regionSpecificKeys = ['ImageId'];

  typeSpecificKeys.forEach(function(key) {
    if (worker.launchSpecification[key]) {
      throw new Error(key + ' is type specific, not general');
    }
    if (worker.regions[region][key]) {
      throw new Error(key + ' is type specific, not type specific');
    }
  });

  regionSpecificKeys.forEach(function(key) {
    if (worker.launchSpecification[key]) {
      throw new Error(key + ' is region specific, not general');
    }
    if (worker.types[instanceType][key]) {
      throw new Error(key + ' is type specific, not region specific');
    }
  });

  // We're going to make sure that none are set in the generic launchSpec
  if (!worker.types[instanceType]) {
    var e = worker.workerType + 'does not allow instance type ' + instanceType;
    throw new Error(e);
  }

  var actual = lodash.clone(worker.types[instanceType].overwrites);
  var newSpec = lodash.defaults(actual, worker.launchSpecification);
  if (!/^[A-Za-z0-9+/=]*$/.exec(newSpec.UserData)) {
    throw new Error('Launch specification does not contain Base64: ' + newSpec.UserData);
  }
  newSpec.KeyName = keyPrefix + worker.workerType;
  newSpec.InstanceType = instanceType;
  Object.keys(worker.regions[region].overwrites).forEach(function(key) {
    newSpec[key] = worker.regions[region].overwrites[key];
  });

  return newSpec;
    
};


/**
 * Make sure that all combinations of LaunchSpecs work.  This sync
 * function will throw if there is an error found or will return
 * a dictionary of all the launch specs!
 */
WorkerType.testLaunchSpecs = function(debug, worker, keyPrefix) {
  assert(debug);
  assert(worker);
  assert(keyPrefix);
  var errors = [];
  var launchSpecs = {};
  Object.keys(worker.regions).forEach(function(region) {
    launchSpecs[region] = {};
    Object.keys(worker.types).forEach(function(type) {
      try {
        launchSpecs[region][type] = WorkerType.createLaunchSpec(debug, region, type, worker, keyPrefix);
      } catch (e) {
        errors.push(e)
      }
    });
  });
  if (errors.length > 0) {
    var err = new Error('Launch specifications are invalid');
    err.code = 'InvalidLaunchSpecifications';
    err.reasons = errors;
    throw err;
  }
  return launchSpecs;
};


/**
 * Figure out how many capacity units need to be created.  This number is
 * determined by calculating how much capacity is needed to maintain a given
 * scaling ratio and returns the number of capacity units which need to be
 * created or destroyed.  This will give an exact number of units, something
 * else will be required to decide what to do if the number of needed capacity
 * units does not fit nicely with the number of capacity units available per
 * instance type.  Positive value means add capacity, negative means destroy
 */
WorkerType.prototype.determineCapacityChange = function(debug, capacity, pending) {
  assert(debug);
  assert(capacity);
  assert(pending);
  // We need to know the current ratio of capacity to pending
  var percentPending = 1 + pending / capacity;

  var change = 0;

  // We only want to scale anything once we have a pending
  // percentage that exceeds the scalingRatio
  if (percentPending > this.scalingRatio) {
    // But when we do, let's submit enough requests that
    // we end up in an ideal state if all are fulfilled
    var ideal = (capacity + pending) / this.scalingRatio;
    change = ideal - capacity;
  }

  debug('change needed is %d', change);

  if (capacity + change > this.maxCapacity) {
    change = this.maxCapacity - capacity;
    debug('would exceed max, using %d instead', change); 
  } else if (capacity + change < this.minCapacity) {
    change = this.minCapacity - capacity;
    debug('wouldn\'t be meet min, using %d instead', change);
  } 

  return Math.round(change);
  
};


/**
 * Select region, instance type and spot bids based on the amount of capacity units needed.
 * The region is picked randomly to distribute load but in future we could do smart things
 * like say no region can use more than X% of instances.  We use the utility factor to
 * determine which instance type to bid on.  Utility factor is a relative performance 
 * indicator.  If we say that a large is worth 2 and a small is worth 1, we'll bid on
 * smalls unless the price of a large is less than double that of a small.  Utility factors
 * are currently hardcoded, but in the future we could do smart things like compare runtimes
 * of things run on each instance type.  The spot bid is calcuated at the one in the price
 * history multiplied by 1.3 to give a 30% buffer.
 */
WorkerType.prototype.determineSpotBids = function(debug, pricing, capacity, pending) {
  assert(debug);
  assert(pricing);
  assert(capacity);
  assert(pending);
  var that = this;
  
  var cheapestType;
  var cheapestPrice;
  var cheapestRegion;
  var spotBid;

  var change = this.determineCapacityChange(debug, capacity, pending);

  var spotBids = [];

  var pricingInfo = pricing.pricesByRegionAndType();

  while (change > 0) {
    Object.keys(this.types).forEach(function(potentialType) {
      that.listRegions().forEach(function(potentialRegion) {
        var potentialSpotBid = pricingInfo[potentialRegion][potentialType];
        // Like capacity we assume that if a utility factor is not available
        // that we consider it to be the base (1)
        var potentialPrice = (that.types[potentialType].utility || 1) * potentialSpotBid;
        if (!cheapestPrice || (potentialPrice < cheapestPrice && potentialSpotBid > that.maxSpotBid)) {
          cheapestPrice = potentialPrice;
          cheapestType = potentialType;
          cheapestRegion = potentialRegion;
          // We bid a little higher because we don't want the machine to end
          // too soon
          spotBid = Math.ceil(potentialSpotBid * 1.3 * 1000000) / 1000000;
        }
      });
    });

    if (spotBid) {
      change -= that.types[cheapestType].capacity;
      spotBids.push({
        region: cheapestRegion,
        price: spotBid,
        type: cheapestType,
      });
    }
  }
  return spotBids;    
};


WorkerType.prototype.spawn = function(debug, bid) {
  assert(bid, 'Must specify a spot bid');
  assert(this.regions[bid.region], 'Must specify an allowed region');
  assert(this.types[bid.type], 'Must specify an allowed instance type');
  assert(typeof bid.price === 'number', 'Spot Price must be number');

  var launchSpec = this.createLaunchSpec(debug, bid.region, bid.type);

  var p = this.ec2.requestSpotInstances.inRegion(bid.region, {
    InstanceCount: 1,
    Type: 'one-time',
    LaunchSpecification: launchSpec,
    SpotPrice: bid.price.toString(),
  });

  p = p.then(function(spotRequest) {
    // We only do InstanceCount == 1, so we'll hard code only caring about the first sir
    return spotRequest.SpotInstanceRequests[0].SpotInstanceRequestId;
  });

  p = p.then(function(spotReqId) {
    debug('submitted spot request %s for $%d in %s for %s',
      spotReqId, bid.price, bid.region, bid.type);
    return spotReqId;
  });

  return p;
};


exports.WorkerType = WorkerType;
