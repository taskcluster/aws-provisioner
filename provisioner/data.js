'use strict';
var base = require('taskcluster-base');
var assert = require('assert');
var lodash = require('lodash');
var debug = require('debug')('aws-provisioner:WorkerType');
var util = require('util');
var slugid = require('slugid');

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

// We want to add a lastModified field
WorkerType = WorkerType.configure({
  version: 2,
  properties: {
    // These fields are documented in Version 1 of this Entity
    workerType: base.Entity.types.String,
    minCapacity: base.Entity.types.Number,
    maxCapacity: base.Entity.types.Number,
    scalingRatio: base.Entity.types.Number,
    minPrice: base.Entity.types.Number,
    maxPrice: base.Entity.types.Number,
    canUseOndemand: base.Entity.types.JSON, // delete this
    canUseSpot: base.Entity.types.JSON, // delete this
    instanceTypes: base.Entity.types.JSON,
    regions: base.Entity.types.JSON,
    // Store the date of last modification for this entity
    lastModified: base.Entity.types.Date,
    // Global base UserData object for overwriting
    userData: base.Entity.types.JSON,
    // Global base LaunchSpecification object for overwriting
    launchSpec: base.Entity.types.JSON,
    // Global base secrets object for overwriting
    secrets: base.Entity.types.JSON,
    // Global base scope list for appending, these are the scopes that
    // temporary TC credentials will be issued against
    scopes: base.Entity.types.JSON,
  },
  migrate: function (item) {
    console.log('Upgrading a workerType to version 2');
    console.log(JSON.stringify(item, null, 2));
    var oldUserData;
    if (item.launchSpecification.UserData) {
      oldUserData = JSON.parse(new Buffer(item.launchSpecification.UserData, 'base64').toString());
    } else {
      oldUserData = {};
    }
    var oldLaunchSpec = item.launchSpecification;
    delete item.launchSpecification;
    delete oldLaunchSpec.UserData;
    item.launchSpec = lodash.clone(oldLaunchSpec);
    item.secrets = {};
    item.scopes = [];
    item.userData = lodash.clone(oldUserData);

    // Now, strip out the UserData and LaunchSpec stuff from existing entries
    // and put them in the right structure then create empty scopes and secrets
    item.regions.forEach(r => {
      // Let's get the old launch spec and user data
      var oldUserData;
      if (r.overwrites && r.overwrites.UserData) {
        oldUserData = JSON.parse(new Buffer(r.overwrites.UserData, 'base64').toString());
      } else {
        oldUserData = {};
      }
      var oldOverwrites = r.overwrites;
      delete r.overwrites;

      // Now set them up
      r.userData = oldUserData;
      r.launchSpec = oldOverwrites;
      r.secrets = {};
      r.scopes = [];

    });

    item.instanceTypes.forEach(t => {
      // Let's get the old launch spec and user data
      var oldUserData;
      if (t.overwrites && t.overwrites.UserData) {
        oldUserData = JSON.parse(new Buffer(t.overwrites.UserData, 'base64').toString());
      } else {
        oldUserData = {};
      }
      var oldOverwrites = t.overwrites;
      delete t.overwrites;

      // Now set them up
      t.userData = oldUserData;
      t.launchSpec = oldOverwrites;
      t.secrets = {};
      t.scopes = [];
    });

    item.lastModified = new Date();
    return item;
  },
  context: ['provisionerId', 'provisionerBaseUrl', 'keyPrefix'],
});

/**
 * Create a workerType in the table.  The properties
 * should not have a workerType key since that will be
 * specified in the workerType argument
 */
WorkerType.create = function (workerType, properties) {
  assert(workerType, 'missing workerType param');
  assert(properties, 'missing properties param');
  assert(!properties.workerType, 'properties cannot contain worker name');
  assert(/^[a-zA-Z0-9-_]{1,22}$/.exec(workerType), 'worker name invalid');
  properties.workerType = workerType;
  return base.Entity.create.call(this, properties);
};

/**
 * Return a list of all known workerTypes
 */
WorkerType.loadAll = function () {
  var workers = [];

  var p = base.Entity.scan.call(this, {}, {
    handler: function (item) {
      workers.push(item);
    },
  });

  p = p.then(function () {
    return workers;
  });

  return p;
};

/**
 * Load the names of all known workerTypes
 */
WorkerType.listWorkerTypes = function () {
  var names = [];

  var p = base.Entity.scan.call(this, {}, {
    handler: function (item) {
      names.push(item.workerType);
    },
  });

  p = p.then(function () {
    return names;
  });

  return p;
};

/**
 * Return an Object for JSON encoding which represents
 * the data associated with this WorkerType.  This is a
 * method intended for use in displaying the data associated
 * with a given workerType
 */
WorkerType.prototype.json = function () {
  return lodash.clone(this.__properties);
};

/**
 * Retreive the InstanceType data for a given instanceType
 * and optionally a single property from it.
 */
WorkerType.prototype.getInstanceType = function (instanceType) {
  var types = this.instanceTypes.filter(function (t) {
    return t.instanceType === instanceType;
  });
  if (types.length === 1) {
    return types[0];
  } else if (types.length === 0) {
    throw new Error(this.workerType + ' does not contain ' + instanceType);
  } else {
    throw new Error(this.workerType + ' contains duplicate ' + instanceType);
  }
  return types[0];
};

/**
 * Retreive the Region data for a given region and optionally a
 * single property from it.
 */
WorkerType.prototype.getRegion = function (region) {
  var regions = this.regions.filter(function (r) {
    return r.region === region;
  });
  if (regions.length === 1) {
    return regions[0];
  } else if (regions.length === 0) {
    throw new Error(this.workerType + ' does not contain ' + region);
  } else {
    throw new Error(this.workerType + ' contains duplicate ' + region);
  }
  return regions[0];
};

/**
 * Return the capacity for a given type
 */
WorkerType.prototype.utilityOfType = function (instanceType) {
  return this.getInstanceType(instanceType).utility;
};

/**
 * Return the capacity for a given type
 */
WorkerType.prototype.capacityOfType = function (instanceType) {
  return this.getInstanceType(instanceType).capacity;
};

/**
 * Create an AWS LaunchSpecification for this workerType.  This method
 * does all the various overwriting of type and region specific LaunchSpecification
 * keys.
 */
WorkerType.prototype.createLaunchSpec = function (region, instanceType) {
  assert(region);
  assert(instanceType);
  return WorkerType.createLaunchSpec(region, instanceType,
      this, this.keyPrefix, this.provisionerId, this.provisionerBaseUrl);
};

/**
 * Make sure that all combinations of LaunchSpecs work.  This sync
 * function will throw if there is an error found or will return
 * a dictionary of all the launch specs!
 */
WorkerType.prototype.testLaunchSpecs = function () {
  return WorkerType.testLaunchSpecs(this, this.keyPrefix, this.provisionerId);
};

/**
 * We need to be able to create a launch specification for testing without
 * already having an instance.  This is available as a non-instance method
 * so that we can create and test launch specifications before inserting
 * them into Azure.
 */
WorkerType.createLaunchSpec = function (region, instanceType, worker, keyPrefix, provisionerId, provisionerBaseUrl) {
  // These are the keys which are only applicable to a given region.
  assert(region);
  assert(instanceType);
  assert(worker);
  assert(keyPrefix);
  assert(provisionerId);
  assert(provisionerBaseUrl);

  // Find the region objects, assert if region is not found
  var regionOverwriteObjects = {};
  var foundRegion = false;
  worker.regions.forEach((r) => {
    if (r.region === region) {
      // We want to make sure that we've not already found this region
      if (foundRegion) {
        throw new Error('Region must be unique');
      }
      foundRegion = true;
      regionOverwriteObjects.launchSpec = r.launchSpec || {};
      regionOverwriteObjects.userData = r.userData || {};
      regionOverwriteObjects.secrets = r.secrets || {};
      regionOverwriteObjects.scopes = r.scopes || [];
      // Remember that we need to have an ImageId
      assert(r.launchSpec && r.launchSpec.ImageId, 'ImageId is required in region config');
    }
  });
  assert(foundRegion, 'Region for workertype not found');

  // Find the instanceType overwrites object, assert if type is not found
  var instanceTypeOverwriteObjects = {};
  var foundInstanceType = false;
  worker.instanceTypes.forEach((t) => {
    if (t.instanceType === instanceType) {
      if (foundInstanceType) {
        throw new Error('InstanceType must be unique');
      }
      foundInstanceType = true;
      instanceTypeOverwriteObjects.launchSpec = t.launchSpec || {};
      instanceTypeOverwriteObjects.userData = t.userData || {};
      instanceTypeOverwriteObjects.secrets = t.secrets || {};
      instanceTypeOverwriteObjects.scopes = t.scopes || [];
    }
  });
  assert(foundInstanceType, 'InstanceType for workertype not found');

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
  // Check for type specific keys in the general keys and region keys
  typeSpecificKeys.forEach(function (key) {
    if (worker.launchSpec[key]) {
      throw new Error(key + ' is type specific, not general');
    }
    if (regionOverwriteObjects.launchSpec[key]) {
      throw new Error(key + ' is type specific, not type specific');
    }
  });

  // Check for region specific keys in the general and type keys
  regionSpecificKeys.forEach(function (key) {
    if (worker.launchSpec[key]) {
      throw new Error(key + ' is region specific, not general');
    }
    if (instanceTypeOverwriteObjects.launchSpec[key]) {
      throw new Error(key + ' is type specific, not region specific');
    }
  });

  var config = {};

  // Do the cascading overwrites of the object things
  ['launchSpec', 'userData', 'secrets'].forEach(x => {
    config[x] = lodash.cloneDeep(worker[x] || {});
    lodash.assign(config[x], regionOverwriteObjects[x]);
    lodash.assign(config[x], instanceTypeOverwriteObjects[x]);
  });

  // Generate the complete list of scopes;
  config.scopes = lodash.cloneDeep(worker.scopes);
  regionOverwriteObjects.scopes.forEach(scope => {
    if (!config.scopes.includes(scope)) {
      config.scopes.push(scope);
    }
  });
  instanceTypeOverwriteObjects.scopes.forEach(scope => {
    if (!config.scopes.includes(scope)) {
      config.scopes.push(scope);
    }
  });

  // Set the KeyPair and InstanceType correctly
  config.launchSpec.KeyName = keyPrefix + worker.workerType;
  config.launchSpec.InstanceType = instanceType;

  // Here are the minimum number of things which must be stored in UserData.
  // We will overwrite anything in the definition's UserData with these values
  // because they so tightly coupled to how we do provisioning
  var capacity;
  worker.instanceTypes.forEach(function (t) {
    if (t.instanceType === instanceType) {
      assert(!capacity, 'instanceTypes must be unique');
      capacity = t.capacity;
    }
  });
  assert(capacity);

  config.userData.capacity = capacity;
  config.userData.workerType = worker.workerType;
  config.userData.provisionerId = provisionerId;
  config.userData.region = region;
  config.userData.instanceType = instanceType;
  config.userData.launchSpecGenerated = new Date().toISOString();
  config.userData.workerModified = worker.lastModified.toISOString();
  config.userData.provisionerBaseUrl = provisionerBaseUrl;
  config.userData.securityToken = slugid.v4();

  config.userData.data = {};
  config.userData.extra = {};

  var dataKeys = [
    'capacity',
    'workerType',
    'provisionerId',
    'region',
    'instanceType',
    'workerModified',
    'provisionerBaseUrl',
    'securityToken',
  ];

  dataKeys.forEach(udk => {
    config.userData.data[udk] = config.userData[udk];
  });

  var extraKeys = [
    'launchSpecGenerated',
  ];

  extraKeys.forEach(udk => {
    config.userData.extra[udk] = config.userData[udk];
  });

  config.launchSpec.UserData = new Buffer(JSON.stringify(config.userData)).toString('base64');

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
  mandatoryKeys.forEach(function (key) {
    assert(config.launchSpec[key], 'Your launch spec must have key ' + key);
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
  Object.keys(config.launchSpec).forEach(function (key) {
    assert(allowedKeys.includes(key), 'Your launch spec has invalid key ' + key);
  });

  // These are keys which we do not allow in the generated launch spec
  var disallowedKeys = [
    'Placement',
  ];

  disallowedKeys.forEach(function (key) {
    assert(!config.launchSpec[key], 'Your launch spec must not have key ' + key);
  });

  /**
   * We want to return all of the generated data.  There is a little redundancy here
   * but it's not much and I'd rather optimize for easy look up
   */
  return {
    launchSpec: config.launchSpec,
    secrets: config.secrets, // Remember these are static secrets
    scopes: config.scopes,
    userData: config.userData,
    securityToken: config.userData.securityToken,
  };
};

/**
 * Make sure that all combinations of LaunchSpecs work.  This sync
 * function will throw if there is an error found or will return
 * a dictionary of all the launch specs!
 */
WorkerType.testLaunchSpecs = function (worker, keyPrefix, provisionerId, provisionerBaseUrl) {
  assert(worker);
  assert(keyPrefix);
  assert(provisionerId);
  assert(provisionerBaseUrl);
  var errors = [];
  var launchSpecs = {};
  worker.regions.forEach(function (r) {
    var region = r.region;
    launchSpecs[region] = {};
    worker.instanceTypes.forEach(function (t) {
      var type = t.instanceType;
      try {
        var x = WorkerType.createLaunchSpec(region, type, worker, keyPrefix, provisionerId, provisionerBaseUrl);
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
WorkerType.prototype.determineCapacityChange = function (runningCapacity, pendingCapacity, pending) {
  assert(typeof runningCapacity === 'number');
  assert(typeof pendingCapacity === 'number');
  assert(typeof pending === 'number');

  // scalingRatio = 0.2   => keep pending tasks as 20% of runningCapacity
  // scalingRatio = 0     => keep pending tasks as  0% of runningCapacity
  var desiredPending = Math.round(this.scalingRatio * runningCapacity);

  // desiredPending < pending - pendingCapacity    =>   Create spot requests
  //                                        , otherwise Cancel spot requests
  var capacityChange = pending - pendingCapacity - desiredPending;

  // capacityChange > 0  => Create spot requests for capacityChange
  // capacityChange < 0  => cancel spot requests for capacityChange
  var capacityAfterChange = capacityChange + pendingCapacity + runningCapacity;

  debug('%s: capacity change is %d, which will result in capacity %d',
        this.workerType, capacityChange, capacityAfterChange);

  // Ensure we are within limits
  var newCapacityChange;
  if (capacityAfterChange >= this.maxCapacity) {
    // If there is more than max capacity we should always aim for maxCapacity
    newCapacityChange = this.maxCapacity - runningCapacity - pendingCapacity;
    debug('%s: would exceed maxCapacity of %d with %d.  Using %d instead of %d as change',
          this.workerType, this.maxCapacity, capacityAfterChange,
          newCapacityChange, capacityChange);
    return newCapacityChange;
  } else if (capacityAfterChange < this.minCapacity) {
    newCapacityChange = this.minCapacity - runningCapacity - pendingCapacity;
    debug('%s: would not have minCapacity of %d with %d.  Using %d instead of %d as change',
          this.workerType, this.minCapacity, capacityAfterChange,
          newCapacityChange, capacityChange);
    return newCapacityChange;
  } else {
    debug('%s: change %d is within bounds %d/%d to become %d',
          this.workerType, capacityChange, this.minCapacity, this.maxCapacity,
          capacityAfterChange);
  }

  // If we're not hitting limits, we should aim for the capacity change that
  // fits with the scalingRatio, to keep pending tasks around as a percentage
  // of the running capacity.
  return capacityChange;
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
WorkerType.prototype.determineSpotBids = function (managedRegions, pricing, change) {
  assert(managedRegions);
  assert(pricing);
  assert(change);
  assert(typeof change === 'number');
  var that = this;

  var spotBids = [];

  var pricingData = pricing.maxPrices();

  /* eslint-disable no-loop-func */
  while (change > 0) {
    var cheapestType;
    var cheapestRegion;
    var cheapestZone;
    var cheapestPrice;
    var cheapestBid;

    // Utility Factors, by instance type
    var uf = {};

    // Create a utility factor mapping between ec2 instance type
    // name and the numeric utility factor for easier access
    var types = this.instanceTypes.map(function (t) {
      uf[t.instanceType] = that.utilityOfType(t.instanceType);
      return t.instanceType;
    });

    // Create a list of regions which is the subset of the regions
    // which this worker type is configured for and that the
    // provisioner is configured for
    var regions = that.regions.filter(function (r) {
      return managedRegions.includes(r.region);
    }).map(function (r) {
      return r.region;
    });

    // Instead of interleaving debug() calls, let's instead join all of these
    // into one single debug call
    var priceDebugLog = [];

    regions.forEach(function (region) {
      types.forEach(function (type) {
        if (pricingData[region] && pricingData[region][type]) {
          var zones = Object.keys(pricingData[region][type]);
        } else {
          zones = [];
        }
        zones.forEach(function (zone) {
          try {
            var potentialBid = pricingData[region][type][zone];
          } catch(err) {
            console.dir(regions);
            console.dir(zones);
            console.dir(types);
            console.log(err);
            console.dir(pricingData);
            if (err.stack) {
              console.log(err.stack);
            }
            throw err;
          }
          var potentialPrice = potentialBid / uf[type];

          if (!cheapestPrice) {
            // If we don't already have a cheapest price, that means we
            // should just take the first one we see
            priceDebugLog.push(util.format('%s no existing price, picking %s/%s/%s at price %d(%d)',
                  that.workerType, region, zone, type, potentialPrice, potentialBid));
            cheapestPrice = potentialPrice;
            cheapestRegion = region;
            cheapestType = type;
            cheapestZone = zone;
            cheapestBid = potentialBid;
          } else if (potentialPrice < cheapestPrice) {
            // If we find that we have a cheaper option, let's switch to it
            priceDebugLog.push(util.format('%s cheapest was %s/%s/%s at price %d(%d), now is %s/%s/%s at price %d(%d)',
                  that.workerType,
                  cheapestRegion, cheapestZone, cheapestType, cheapestPrice, cheapestBid,
                  region, zone, type, potentialPrice, potentialBid));
            cheapestPrice = potentialPrice;
            cheapestRegion = region;
            cheapestType = type;
            cheapestZone = zone;
            cheapestBid = Math.ceil(potentialBid * 2 * 1000000) / 1000000;
          } else {
            // If this option is not first and not cheapest, we'll
            // ignore it but tell the logs that we did
            priceDebugLog.push(util.format('%s is not picking %s/%s/%s at price %d(%d)',
                  that.workerType,
                  region, zone, type, potentialPrice, potentialBid));
          }
        });
      });
    });

    if (cheapestPrice < that.minPrice) {
      var oldCheapestBid = cheapestBid;
      cheapestBid = Math.ceil(that.minPrice / uf[cheapestType] * 1000000) / 1000000;
      priceDebugLog.push(util.format('%s price was too low %d --> %d',
            this.workerType, oldCheapestBid, cheapestBid));
    }

    debug(priceDebugLog.join('\n'));

    if (cheapestBid && cheapestPrice <= that.maxPrice) {
      change -= that.capacityOfType(cheapestType);
      spotBids.push({
        price: cheapestBid, // Ugh, awful naming!
        truePrice: cheapestPrice, // for history reasons
        region: cheapestRegion,
        type: cheapestType,
        zone: cheapestZone,
      });
    } else {
      if (cheapestPrice > that.maxPrice) {
        debug('WorkerType %s is exceeding its max price of %d with %d',
              that.workerType, that.maxPrice, cheapestPrice);
      }
      throw new Error('Could not create a bid which satisfies requirements');
    }

    // This is a sanity check to prevent a screw up where we theoretically
    // bid $6000 for a spot node.  Code above should make sure that the optimal
    // bid is selected.  I would argue that if we start bidding on $10/h machines
    // that we really ought to be very well aware of this, and having to make a
    // change to the provisioner is a demonstration of our knowledge of that.
    if (cheapestBid > 10) {
      debug('[alert-operator] %s spot bid is exceptionally high...', this.workerType);
      throw new Error('Spot bid really shouldn\'t be higher than $10');
    }
  }
  /* eslint-enable no-loop-func */

  return spotBids;
};

exports.WorkerType = WorkerType;
