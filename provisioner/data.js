'use strict';
var base        = require('taskcluster-base');
var assert      = require('assert');
var Promise     = require('promise');
var lodash      = require('lodash');
var debug       = require('debug')('aws-provisioner:WorkerType');

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
  context: [],
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
    }
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
    }
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
  assert(workerType);
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
 * Shutdown all instances of this workerType, cancel
 * any open spot requests.
 */
WorkerType.prototype.killAll = function() {
  throw new Error('Broken!');
  var that = this;
  var regionDeaths = {};

  // First find all the known-to-aws instances
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

  // Then create promises to kill all of them
  p = p.then(function(res) {
    var killinators = [];
    that.listRegions().forEach(function(region) {

      // We have lists of instances and spot requests
      // instead of just pushing new promises for each
      // discovered instance and request so that we can
      // reduce the number of API calls from 
      // regions * (instances+requests) to at most 2 api
      // calls
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
        killinators.push(that.ec2.cancelSpotInstanceRequests.inRegion(region, {
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
 * Create an AWS LaunchSpecification for this workerType.  This method
 * does all the various overwriting of type and region specific LaunchSpecification
 * keys.
 */
WorkerType.prototype.createLaunchSpec = function(region, instanceType, keyPrefix) {
  assert(region);
  assert(instanceType);
  return WorkerType.createLaunchSpec(region, instanceType, this, keyPrefix);
}


/**
 * Make sure that all combinations of LaunchSpecs work.  This sync
 * function will throw if there is an error found or will return
 * a dictionary of all the launch specs!
 */
WorkerType.prototype.testLaunchSpecs = function(keyPrefix) {
  return WorkerType.testLaunchSpecs(this, keyPrefix);
}


/**
 * We need to be able to create a launch specification for testing without
 * already having an instance.  This is available as a non-instance method
 * so that we can create and test launch specifications before inserting
 * them into Azure.
 */
WorkerType.createLaunchSpec = function(region, instanceType, worker, keyPrefix) {
  // These are the keys which are only applicable to a given region.
  assert(worker);
  assert(keyPrefix);
  assert(worker.regions[region], region + ' is not configured');
  assert(worker.types[instanceType], instanceType + ' is not configured');

  // These are keys that are only allowable in the set of type specific
  // overwrites.  Only keys which are strictly related to instance type
  // should ever be here.
  var typeSpecificKeys = [
    'InstanceType', // InstanceType decides which instancetype to use...
  ];

  // These are keys that are only allowable in the set of region specific
  // overwrites.  Only things which are strictly linked to the region
  // should ever be in this list.
  var regionSpecificKeys = [
    'ImageId', // AMI IDs (ImageId) are created and are different per-region
  ];

  // Check for type specific keys in the general keys and region keys
  typeSpecificKeys.forEach(function(key) {
    if (worker.launchSpecification[key]) {
      throw new Error(key + ' is type specific, not general');
    }
    if (worker.regions[region][key]) {
      throw new Error(key + ' is type specific, not type specific');
    }
  });

  // Check for region specific keys in the general and type keys
  regionSpecificKeys.forEach(function(key) {
    if (worker.launchSpecification[key]) {
      throw new Error(key + ' is region specific, not general');
    }
    if (worker.types[instanceType][key]) {
      throw new Error(key + ' is type specific, not region specific');
    }
  });

  // Make sure that this worker allows the requested workerType
  if (!worker.types[instanceType]) {
    var e = worker.workerType + ' does not allow instance type ' + instanceType;
    throw new Error(e);
  }

  // Make sure that this worker allows the requested region
  if (!worker.regions[region]) {
    var e = worker.workerType + ' does not allow region ' + region;
    throw new Error(e);
  }

  // Start with the general options
  var launchSpec = lodash.clone(worker.launchSpecification);

  // Now overwrite the ones that are region specific
  Object.keys(worker.regions[region].overwrites).forEach(function(regionKey) {
    launchSpec[regionKey] = worker.regions[region].overwrites[regionKey];
  });

  // Now overwrite the ones that are type specific
  Object.keys(worker.types[instanceType].overwrites).forEach(function(typeKey) {
    launchSpec[typeKey] = worker.types[instanceType].overwrites[typeKey];
  });

  // set the KeyPair and InstanceType correctly
  launchSpec.KeyName = keyPrefix + worker.workerType;
  launchSpec.InstanceType = instanceType;

  if (!/^[A-Za-z0-9+/=]*$/.exec(launchSpec.UserData)) {
    throw new Error('Launch specification does not contain Base64: ' + launchSpec.UserData);
  }

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
    assert(-1 !== allowedKeys.indexOf(key), 'Your launch spec has invalid key ' + key);
  });

  return launchSpec;
};


/**
 * Make sure that all combinations of LaunchSpecs work.  This sync
 * function will throw if there is an error found or will return
 * a dictionary of all the launch specs!
 */
WorkerType.testLaunchSpecs = function(worker, keyPrefix) {
  assert(worker);
  assert(keyPrefix);
  var errors = [];
  var launchSpecs = {};
  Object.keys(worker.regions).forEach(function(region) {
    launchSpecs[region] = {};
    Object.keys(worker.types).forEach(function(type) {
      try {
        launchSpecs[region][type] = WorkerType.createLaunchSpec(region, type, worker, keyPrefix);
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
WorkerType.prototype.determineCapacityChange = function(capacity, pending) {
  assert(typeof capacity === 'number');
  assert(typeof pending === 'number');
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
WorkerType.prototype.determineSpotBids = function(regions, pricing, capacity, pending) {
  assert(regions);
  assert(pricing);
  assert(typeof capacity === 'number');
  assert(typeof pending === 'number');
  var that = this;
  
  var cheapestType;
  var cheapestPrice;
  var cheapestRegion;
  var spotBid;

  var change = this.determineCapacityChange(capacity, pending);

  var spotBids = [];

  var pricingInfo = pricing.pricesByRegionAndType();

  var allowedRegions = Object.keys(this.regions).filter(function(region) {
    return regions.indexOf(region) !== -1;
  });

  if (allowedRegions.length === 0) {
    throw new Error('No configured region is allowed by ' + this.workerType);
  }

  while (change > 0) {
    Object.keys(this.types).forEach(function(potentialType) {
      allowedRegions.forEach(function(potentialRegion) {
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


/**
 * Return the capacity for a given type
 */
WorkerType.prototype.capacityOfType = function(type) {
  return this.types[type].capacity;
};

exports.WorkerType = WorkerType;
