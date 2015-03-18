'use strict';
var base = require('taskcluster-base');
var assert = require('assert');
var lodash = require('lodash');
var debug = require('debug')('aws-provisioner:WorkerType');

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
  /* eslint-disable new-cap */
  partitionKey: base.Entity.keys.ConstantKey(KEY_CONST),
  rowKey: base.Entity.keys.StringKey('workerType'),
  /* eslint-enable new-cap */
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
    minPrice: base.Entity.types.Number,
    maxPrice: base.Entity.types.Number,
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
    instanceTypes: base.Entity.types.JSON,
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
  context: ['provisionerId', 'keyPrefix'],
});

/**
 * Create a workerType in the table.  The properties
 * should not have a workerType key since that will be
 * specified in the workerType argument
 */
WorkerType.create = function(workerType, properties) {
  assert(workerType);
  assert(properties);
  assert(!properties.workerType);
  assert(/^[a-zA-Z0-9-_]{1,22}$/.exec(workerType));
  properties.workerType = workerType;
  return base.Entity.create.call(this, properties);
};


/**
 * Return a list of all known workerTypes
 */
WorkerType.loadAll = function() {
  var workers = [];

  var p = base.Entity.scan.call(this, {}, {
    handler: function (item) {
      workers.push(item);
    },
  });

  p = p.then(function() {
    return workers;
  });

  return p;
};

/**
 * Load the names of all known workerTypes
 */
WorkerType.listWorkerTypes = function() {
  var names = [];

  var p = base.Entity.scan.call(this, {}, {
    handler: function (item) {
      names.push(item.workerType);
    },
  });

  p = p.then(function() {
    return names;
  });

  return p;
};


/**
 * Load a single workerType by name
 */
WorkerType.load = function(toLoad) {
  assert(toLoad);
  return base.Entity.load.call(this, toLoad);
};


/**
 * Return an Object for JSON encoding which represents
 * the data associated with this WorkerType.  This is a
 * method intended for use in displaying the data associated
 * with a given workerType
 */
WorkerType.prototype.json = function() {
  return lodash.clone(this.__properties);
};

/**
 * Retreive the InstanceType data for a given instanceType
 * and optionally a single property from it.
 */
WorkerType.prototype.getInstanceType = function(instanceType) {
  var types = this.instanceTypes.filter(function(t) {
    return t.instanceType === instanceType;
  });
  assert(types.length === 1);
  return types[0];
};

/**
 * Retreive the Region data for a given region and optionally a
 * single property from it.
 */
WorkerType.prototype.getRegion = function(region) {
  var regions = this.regions.filter(function(r) {
    return r.region === region;
  });
  assert(regions.length === 1);
  return regions[0];
};

/**
 * Return the capacity for a given type
 */
WorkerType.prototype.utilityOfType = function(instanceType) {
  return this.getInstanceType(instanceType).utility;
};

/**
 * Return the capacity for a given type
 */
WorkerType.prototype.capacityOfType = function(instanceType) {
  return this.getInstanceType(instanceType).capacity;
};

/**
 * Create an AWS LaunchSpecification for this workerType.  This method
 * does all the various overwriting of type and region specific LaunchSpecification
 * keys.
 */
WorkerType.prototype.createLaunchSpec = function(region, instanceType) {
  assert(region);
  assert(instanceType);
  return WorkerType.createLaunchSpec(region, instanceType, this, this.keyPrefix, this.provisionerId);
};


/**
 * Make sure that all combinations of LaunchSpecs work.  This sync
 * function will throw if there is an error found or will return
 * a dictionary of all the launch specs!
 */
WorkerType.prototype.testLaunchSpecs = function() {
  return WorkerType.testLaunchSpecs(this, this.keyPrefix, this.provisionerId);
};


/**
 * We need to be able to create a launch specification for testing without
 * already having an instance.  This is available as a non-instance method
 * so that we can create and test launch specifications before inserting
 * them into Azure.
 */
WorkerType.createLaunchSpec = function(region, instanceType, worker, keyPrefix, provisionerId) {
  // These are the keys which are only applicable to a given region.
  assert(region);
  assert(instanceType);
  assert(worker);
  assert(keyPrefix);
  assert(provisionerId);

  var hasRegion = false;
  worker.regions.forEach(function(r) {
    if (r.region === region) {
      hasRegion = true;
    }
  });
  if (!hasRegion) {
    throw new Error('workerType not configured for ' + region);
  }
  var hasType = false;
  worker.instanceTypes.forEach(function(r) {
    if (r.instanceType === instanceType) {
      hasType = true;
    }
  });
  if (!hasType) {
    throw new Error('workerType not configured for ' + instanceType);
  }

  // These are keys that are only allowable in the set of type specific
  // overwrites.  Only keys which are strictly related to instance type
  // should ever be here.
  var typeSpecificKeys = [
    'InstanceType', // InstanceType decides which instancetype to use...
  ];

  // These are keys that are only allowable in the set of region specific
  // overwrites.  Only things which are strictly linked to the region
  // should ever be in this list.
  // TODO: Are kernel ids region specific as well?
  var regionSpecificKeys = [
    'ImageId', // AMI IDs (ImageId) are created and are different per-region
  ];

  // Find the region overwrites object
  var regionOverwrites;
  worker.regions.forEach(function(r) {
    if (r.region === region) {
      assert(!regionOverwrites, 'regions must be unique');
      regionOverwrites = r.overwrites;
    }
  });
  assert(regionOverwrites);

  // Find the instanceType overwrites object
  var typeOverwrites;
  worker.instanceTypes.forEach(function(t) {
    if (t.instanceType === instanceType) {
      assert(!typeOverwrites, 'instanceTypes must be unique');
      typeOverwrites = t.overwrites;
    }
  });
  assert(typeOverwrites);

  // Check for type specific keys in the general keys and region keys
  typeSpecificKeys.forEach(function(key) {
    if (worker.launchSpecification[key]) {
      throw new Error(key + ' is type specific, not general');
    }
    if (regionOverwrites[key]) {
      throw new Error(key + ' is type specific, not type specific');
    }
  });

  // Check for region specific keys in the general and type keys
  regionSpecificKeys.forEach(function(key) {
    if (worker.launchSpecification[key]) {
      throw new Error(key + ' is region specific, not general');
    }
    if (typeOverwrites[key]) {
      throw new Error(key + ' is type specific, not region specific');
    }
  });

  // Start with the general options
  var launchSpec = lodash.cloneDeep(worker.launchSpecification);

  // Now overwrite things
  lodash.assign(launchSpec, regionOverwrites);
  lodash.assign(launchSpec, typeOverwrites);

  // set the KeyPair and InstanceType correctly
  launchSpec.KeyName = keyPrefix + worker.workerType;
  launchSpec.InstanceType = instanceType;

  // We want to make sure that whatever UserData is in there is in
  // base64
  if (!/^[A-Za-z0-9+/=]*$/.exec(launchSpec.UserData)) {
    throw new Error('Launch specification does not contain Base64: ' + launchSpec.UserData);
  }

  // Here are the minimum number of things which must be stored in UserData.
  // We will overwrite anything in the definition's UserData with these values
  // because they so tightly coupled to how we do provisioning
  var capacity;
  worker.instanceTypes.forEach(function(t) {
    if (t.instanceType === instanceType) {
      assert(!capacity, 'instanceTypes must be unique');
      capacity = t.capacity;
    }
  });
  assert(capacity);

  var generatedUserData = {
    capacity: capacity,
    workerType: worker.workerType,
    provisionerId: provisionerId,
    region: region,
    instanceType: instanceType,
    launchSpecGenerated: new Date().toISOString(),
  };

  // We're going to try to read in the stored UserData field and use
  // it as the basis for our generated UserData
  // Note that we're enforcing here that UserData will contain
  // JSON encoded values.  If the stored UserData is not in a format
  // which is not parsable as Base64(Json(x)) then we're going to
  // include it verbatim as a key
  var hardCodedUserData = {};
  try {
    hardCodedUserData = JSON.parse(new Buffer(launchSpec.UserData, 'base64').toString());
  } catch(e) {
    generatedUserData.originalUserData = launchSpec.UserData;
    debug('%s stored user data is not base64 encoded JSON', worker.workerType);
    debug(launchSpec.UserData);
  }

  var userData = lodash.assign(hardCodedUserData, generatedUserData);
  launchSpec.UserData = new Buffer(JSON.stringify(userData)).toString('base64');

  // These are the keys that we require to be set.  They
  // are not listed as required in the api docs, but we
  // are going to say that they are required in our world
  // http://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_LaunchSpecification.html
  var mandatoryKeys = [
    'ImageId',
    'InstanceType',
    'KeyName',
    'UserData',
  ];

  // Now check that we have all the mandatory keys
  mandatoryKeys.forEach(function(key) {
    assert(launchSpec[key], 'Your launch spec must have key ' + key);
  });

  // These are the additional keys which *might* be specified
  var allowedKeys = mandatoryKeys.concat([
    'SecurityGroups',
    'AddressingType',
    'BlockDeviceMappings',
    'EbsOptimized',
    'IamInstanceProfile',
    'KernelId',
    'MonitoringEnabled',
    'NetworkInterfaces',
    'Placement',
    'RamdiskId',
    'SubnetId',
  ]);

  // Now check that there are no unknown keys
  Object.keys(launchSpec).forEach(function(key) {
    assert(allowedKeys.indexOf(key) !== -1, 'Your launch spec has invalid key ' + key);
  });

  // These are keys which we do not allow in the generated launch spec
  var disallowedKeys = [
    'Placement',
  ];

  disallowedKeys.forEach(function(key) {
    assert(!launchSpec[key], 'Your launch spec must not have key ' + key);
  });

  return launchSpec;
};


/**
 * Make sure that all combinations of LaunchSpecs work.  This sync
 * function will throw if there is an error found or will return
 * a dictionary of all the launch specs!
 */
WorkerType.testLaunchSpecs = function(worker, keyPrefix, provisionerId) {
  assert(worker);
  assert(keyPrefix);
  assert(provisionerId);
  var errors = [];
  var launchSpecs = {};
  worker.regions.forEach(function(r) {
    var region = r.region;
    launchSpecs[region] = {};
    worker.instanceTypes.forEach(function(t) {
      var type = t.instanceType;
      try {
        var x = WorkerType.createLaunchSpec(region, type, worker, keyPrefix, provisionerId);
        launchSpecs[region][type] = x;
      } catch (e) {
        errors.push(e);
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
 * instance type.  Positive value means add capacity, negative means destroy.
 * Running capacity are nodes that are on and assumed to be accepting jobs.
 * Since we don't currently have a way to know when the node is *actually*
 * accepting jobs, we'll just assume that running == accepting jobs.
 * Pending capacity are those units (pending instances, spot requests)
 * which are going to be created but have not yet been created.  We want to
 * offset the number of units that we'd be creating by the number of pending
 * capacity units
 */
WorkerType.prototype.determineCapacityChange = function(runningCapacity, pendingCapacity, pending) {
  assert(typeof runningCapacity === 'number');
  assert(typeof pendingCapacity === 'number');
  assert(typeof pending === 'number');

  // We need to know how many total capacity units are extant
  var totalCapacity = pendingCapacity + runningCapacity;

  // We need to know the current ratio of capacity to pending
  var percentPending = 1 + pending / totalCapacity;

  var change = 0;

  // We only want to scale anything once we have a pending
  // percentage that exceeds the scalingRatio
  if (percentPending > this.scalingRatio) {
    // But when we do, let's submit enough requests that
    // we end up in an ideal state if all are fulfilled
    var ideal = (totalCapacity + pending) / this.scalingRatio;
    change = ideal - totalCapacity;
  }

  // We need to offset the number of pending jobs by the
  // number of units that can't yet start running tasks
  change -= pendingCapacity;

  debug('"%s" change needed is %d (runningCapacity %d, pendingCapacity %d, pending tasks %d)',
        this.workerType, change, runningCapacity, pendingCapacity, pending);

  if (totalCapacity + change > this.maxCapacity) {
    change = this.maxCapacity - totalCapacity;
    debug('%s, would exceed max, using %d instead', this.workerType, change);
  } else if (totalCapacity + change < this.minCapacity) {
    change = this.minCapacity - totalCapacity;
    debug('%s wouldn\'t be meet min, using %d instead', this.workerType, change);
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
WorkerType.prototype.determineSpotBids = function(managedRegions, pricing, runningCapacity, pendingCapacity, pending) {
  assert(managedRegions);
  assert(pricing);
  assert(typeof runningCapacity === 'number');
  assert(typeof pendingCapacity === 'number');
  assert(typeof pending === 'number');
  var that = this;

  var change = this.determineCapacityChange(runningCapacity, pendingCapacity, pending);

  var spotBids = [];

  var pricingData = pricing.maxPrices();

  /* eslint-disable no-loop-func */
  while (change > 0) {
    var cheapestType;
    var cheapestPrice;
    var cheapestRegion;
    var cheapestZone;
    var spotBid;

    // Utility Factors, by instance type
    var uf = {};

    var types = this.instanceTypes.map(function(t) {
      uf[t.instanceType] = that.utilityOfType(t.instanceType) || 1;
      return t.instanceType;
    });

    var regions = that.regions.filter(function(r) {
      return managedRegions.includes(r.region);
    }).map(function(r) {
      return r.region;  
    });

    regions.forEach(function(region) {
      var zones = pricing.__zoneInfo[region];
      types.forEach(function(type) {
        zones.forEach(function(zone) {
          var potentialBid = pricingData[region][type][zone];
          var potentialPrice = uf[type] * potentialBid;
          if (!cheapestPrice || potentialPrice < cheapestPrice && potentialPrice < that.maxPrice) {
            cheapestPrice = potentialPrice;
            cheapestRegion = region;
            cheapestType = type;
            cheapestZone = zone;
            // We might want to make the overbid configurable
            spotBid = Math.ceil(potentialBid * 1.5 * 1000000) / 1000000;
            if (potentialPrice < that.minPrice) {
              spotBid = Math.ceil(that.minPrice / uf[type] * 1000000) / 1000000;
            }
          }
        });
      });
    });

    if (spotBid) {
      change -= that.capacityOfType(cheapestType);
      spotBids.push({
        price: spotBid,
        region: cheapestRegion,
        type: cheapestType,
        zone: cheapestZone,
      });
    } else {
      throw new Error('Counld not create a bid which satisfies requirements');
    }

    // This is a sanity check to prevent a screw up where we theoretically
    // bid $6000 for a spot node.  Code above should make sure that the optimal
    // bid is selected.  I would argue that if we start bidding on $20/h machines
    // that we really ought to be very well aware of this, and having to make a
    // change to the provisioner is a demonstration of our knowledge of that.
    if (spotBid > 20) {
      debug('[alert-operator] spot bid is exceptionally high...');
      throw new Error('Spot bid really shouldn\'t be higher than $20');
    }
  }
  /* eslint-enable no-loop-func */

  return spotBids;
};




exports.WorkerType = WorkerType;
