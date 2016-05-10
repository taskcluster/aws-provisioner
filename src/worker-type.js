let base = require('taskcluster-base');
let assert = require('assert');
let debug = require('debug')('aws-provisioner:WorkerType');
let debugMigrate = require('debug')('aws-provisioner:migrate:WorkerType');
let util = require('util');
let slugid = require('slugid');
let keyPairs = require('./key-pairs');
let _ = require('lodash');

const KEY_CONST = 'worker-type';

// We do this three times, lets just stick it into a function
function fixUserData (x) {
  let ud = {};
  try {
    if (typeof x === 'string') {
      ud = JSON.parse(new Buffer(x, 'base64').toString());
    } else if (typeof x === 'object') {
      ud = _.deepClone(x);
    } else if (typeof x !== 'undefined') {
      debugMigrate('[alert-operator] this userData (%j) is garbage', x);
    }
  } catch (e) {
    debugMigrate('[alert-operator] error fixing UserData (%j) for migration %j %s', x, e, e.stack || '');
  }
  // These keys get overwriten automatically by the provisioner
  // so we don't really need them to ever be in UserData
  for (let y of ['provisionerId', 'workerType', 'capacity']) {
    delete ud[y];
  }
  return ud;
}

/**
 * This WorkerType class is used to store and manipulate the definitions
 * of worker types.  A WorkerType contains the information needed by
 * the provisioner to create workers.  This class also contains methods
 * which know how to create, alter and delete instances of these
 * WorkerTypes.  State and Pricing data which is used for provisioning
 * is not stored here.  The only time we fetch state here is for shutting
 * down everything.
 */
let WorkerType = base.Entity.configure({
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
     *   { instanceType: 'c1.small',
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
    // First, let's set up the static/easy data
    let newWorker = {
      workerType: item.workerType,
      minCapacity: item.minCapacity || 0,
      maxCapacity: item.maxCapacity,
      scalingRatio: item.scalingRatio,
      minPrice: item.minPrice,
      maxPrice: item.maxPrice,
      canUseOndemand: item.canUseOndemand,
      canUseSpot: item.canUseSpot,
      lastModified: new Date(),
      secrets: {},
      scopes: [],
      userData: fixUserData(item.launchSpecification.UserData),
      launchSpec: _.omit(_.cloneDeep(item.launchSpecification), 'UserData'),
    };

    // Now let's fix up the regions
    newWorker.regions = item.regions.map(r => {
      let ud = {};
      if (r.overwrites && r.overwrites.UserData) {
        ud = fixUserData(r.overwrites.UserData);
      }
      return {
        region: r.region,
        secrets: {},
        scopes: [],
        userData: ud,
        launchSpec: _.omit(_.cloneDeep(r.overwrites), 'UserData'),
      };
    });

    // Now let's fix up the instance types
    newWorker.instanceTypes = item.instanceTypes.map(t => {
      let ud = {};
      if (t.overwrites && t.overwrites.UserData) {
        ud = fixUserData(t.overwrites.UserData);
      }
      return {
        instanceType: t.instanceType,
        capacity: t.capacity,
        utility: t.utility,
        secrets: {},
        scopes: [],
        userData: ud,
        launchSpec: _.omit(_.cloneDeep(t.overwrites), 'UserData'),
      };
    });

    debugMigrate('Updated Worker from V1 -> V2:\n%j\n-->%j', item, newWorker);

    return newWorker;
  },
  context: ['provisionerId', 'provisionerBaseUrl', 'keyPrefix', 'pubKey'],
});

// We want to add a description field
WorkerType = WorkerType.configure({
  version: 3,
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
    lastModified: base.Entity.types.Date,
    userData: base.Entity.types.JSON,
    launchSpec: base.Entity.types.JSON,
    secrets: base.Entity.types.JSON,
    scopes: base.Entity.types.JSON,
    // Store a string description of this worker type
    description: base.Entity.types.String,
    // Store the owner of this worker type
    owner: base.Entity.types.String,
  },
  migrate: function (item) {
    item.description = '** WRITE THIS**';
    item.owner = '** WRITE THIS **';
    return item;
  },
  context: ['provisionerId', 'provisionerBaseUrl', 'keyPrefix', 'pubKey'],
});

// We want to add a description field
WorkerType = WorkerType.configure({
  version: 4,
  properties: {
    // These fields are documented in Version 1 of this Entity
    // Version 4 removes some fields we don't use
    workerType: base.Entity.types.String,
    minCapacity: base.Entity.types.Number,
    maxCapacity: base.Entity.types.Number,
    scalingRatio: base.Entity.types.Number,
    minPrice: base.Entity.types.Number,
    maxPrice: base.Entity.types.Number,
    instanceTypes: base.Entity.types.JSON,
    regions: base.Entity.types.JSON,
    lastModified: base.Entity.types.Date,
    userData: base.Entity.types.JSON,
    launchSpec: base.Entity.types.JSON,
    secrets: base.Entity.types.JSON,
    description: base.Entity.types.String,
    owner: base.Entity.types.String,
  },
  migrate: function (item) {
    let newWorker = {
      workerType: item.workerType,
      minCapacity: item.minCapacity,
      maxCapacity: item.maxCapacity,
      scalingRatio: item.scalingRatio,
      minPrice: item.minPrice,
      maxPrice: item.maxPrice,
      instanceTypes: _.cloneDeep(item.intanceTypes),
      regions: _.cloneDeep(item.regions),
      lastModified: _.cloneDeep(item.lastModified), // do dates need clone[Deep] ?
      userData: _.cloneDeep(item.userData),
      launchSpec: _.cloneDeep(item.launchSpec),
      secrets: _.cloneDeep(item.secrets),
      description: item.description,
      owner: item.owner,   
    };
    return newWorker;
  },
  context: ['provisionerId', 'provisionerBaseUrl', 'keyPrefix', 'pubKey'],
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
  properties = _.clone(properties);
  properties.workerType = workerType;
  return base.Entity.create.call(this, properties);
};

/**
 * Return a list of all known workerTypes
 */
WorkerType.loadAll = async function () {
  let workers = [];

  try {
    debug('going to load all workers by scanning the WorkerType table');
    await base.Entity.scan.call(this, {}, {
      handler: function (item) {
        workers.push(item);
      },
    });
    debug('loaded all workers by scanning the WorkerType table');
  } catch (err) {
    debug('error loading all workers');
    debug(err);
    if (err.stack) {
      debug(err.stack);
    }
    throw err;
  }

  return workers;
};

/**
 * Load the names of all known workerTypes
 */
WorkerType.listWorkerTypes = async function () {
  let names = [];

  try {
    await base.Entity.scan.call(this, {}, {
      handler: function (item) {
        names.push(item.workerType);
      },
    });
  } catch (err) {
    debug('error listing worker names');
    debug(err);
    if (err.stack) {
      debug(err.stack);
    }
    throw err;
  }

  return names;
};

/**
 * Return an Object for JSON encoding which represents
 * the data associated with this WorkerType.  This is a
 * method intended for use in displaying the data associated
 * with a given workerType
 */
WorkerType.prototype.json = function () {
  return JSON.parse(JSON.stringify(this._properties));
};

/**
 * Retreive the InstanceType data for a given instanceType
 * and optionally a single property from it.
 */
WorkerType.prototype.getInstanceType = function (instanceType) {
  let types = this.instanceTypes.filter(t => t.instanceType === instanceType);

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
  let regions = this.regions.filter(r => r.region === region);

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
WorkerType.prototype.createLaunchSpec = function (bid) {
  assert(bid);
  return WorkerType.createLaunchSpec(bid,
      this, this.keyPrefix, this.provisionerId, this.provisionerBaseUrl, this.pubKey, this.workerType);
};

/**
 * Make sure that all combinations of LaunchSpecs work.  This sync
 * function will throw if there is an error found or will return
 * a dictionary of all the launch specs!
 */
WorkerType.prototype.testLaunchSpecs = function () {
  return WorkerType.testLaunchSpecs(
      this,
      this.keyPrefix,
      this.provisionerId,
      this.provisionerBaseUrl,
      this.pubKey,
      this.workerType);
};

/**
 * We need to be able to create a launch specification for testing without
 * already having an instance.  This is available as a non-instance method
 * so that we can create and test launch specifications before inserting
 * them into Azure.
 */
WorkerType.createLaunchSpec = function (bid, worker, keyPrefix, provisionerId, provisionerBaseUrl, pubKey, workerName) {
  // These are the keys which are only applicable to a given region.
  assert(bid, 'must specify a bid');
  assert(bid.region, 'bid must specify a region');
  assert(bid.type, 'bid must specify a type');
  assert(bid.zone, 'bid must specify an availability zone');
  assert(worker, 'must provide a worker object');
  assert(keyPrefix, 'must provide key prefix');
  assert(provisionerId, 'must provide provisioner id');
  assert(provisionerBaseUrl, 'must provide provisioner base url');
  assert(pubKey, 'must provide public key data');
  assert(workerName, 'must provide a worker name');

  // Find the region objects, assert if region is not found
  let selectedRegion = {};
  let foundRegion = false;
  for (let r of worker.regions) {
    if (r.region === bid.region) {
      // We want to make sure that we've not already found this region
      if (foundRegion) {
        throw new Error('Region must be unique');
      }
      foundRegion = true;
      selectedRegion.launchSpec = r.launchSpec || {};
      selectedRegion.userData = r.userData || {};
      selectedRegion.secrets = r.secrets || {};
      selectedRegion.scopes = r.scopes || [];
      selectedRegion.region = r.region;
      // Remember that we need to have an ImageId
      assert(r.launchSpec && r.launchSpec.ImageId, 'ImageId is required in region config');
    }
  }
  assert(foundRegion, 'Region for workertype not found');

  // Find the instanceType overwrites object, assert if type is not found
  let selectedInstanceType = {};
  let foundInstanceType = false;
  for (let t of worker.instanceTypes) {
    if (t.instanceType === bid.type) {
      if (foundInstanceType) {
        throw new Error('InstanceType must be unique');
      }
      foundInstanceType = true;
      selectedInstanceType.launchSpec = t.launchSpec || {};
      selectedInstanceType.userData = t.userData || {};
      selectedInstanceType.secrets = t.secrets || {};
      selectedInstanceType.scopes = t.scopes || [];
      selectedInstanceType.capacity = t.capacity;
      selectedInstanceType.utility = t.utility;
      selectedInstanceType.instanceType = t.instanceType;
    }
  }
  assert(foundInstanceType, 'InstanceType for workertype not found');

  // These are keys that are only allowable in the set of type specific
  // launchSpec.  Only keys which are strictly related to instance type
  // should ever be here.
  let typeSpecificKeys = [
    'InstanceType', // InstanceType decides which instancetype to use...
  ];

  // These are keys that are only allowable in the set of region specific
  // launchSpec.  Only things which are strictly linked to the region
  // should ever be in this list.
  // TODO: Are kernel ids region specific as well?
  let regionSpecificKeys = [
    'ImageId', // AMI IDs (ImageId) are created and are different per-region
  ];

  // Check for type specific keys in the general keys and region keys
  for (let key of typeSpecificKeys) {
    if (worker.launchSpec[key]) {
      throw new Error(key + ' is type specific, not general');
    }
    if (selectedRegion.launchSpec[key]) {
      throw new Error(key + ' is type specific, not region');
    }
  }

  // Check for region specific keys in the general and type keys
  for (let key of regionSpecificKeys) {
    if (worker.launchSpec[key]) {
      throw new Error(key + ' is region specific, not general');
    }
    if (selectedInstanceType.launchSpec[key]) {
      throw new Error(key + ' is region specific, not type');
    }
  }

  let config = {};

  // Do the cascading overwrites of the object things
  for (let x of ['launchSpec', 'userData', 'secrets']) {
    config[x] = _.cloneDeep(worker[x] || {});
    _.assign(config[x], selectedRegion[x]);
    _.assign(config[x], selectedInstanceType[x]);
  }

  // Generate the complete list of scopes;
  config.scopes = _.cloneDeep(worker.scopes);

  // Region specific scopes
  for (let scope of selectedRegion.scopes) {
    if (!_.includes(config.scopes, scope)) {
      config.scopes.push(scope);
    }
  }

  // Instance Type specific scopes
  for (let scope of selectedInstanceType.scopes) {
    if (!_.includes(config.scopes, scope)) {
      config.scopes.push(scope);
    }
  }

  // Set the KeyPair, InstanceType and availability zone correctly
  config.launchSpec.KeyName = keyPairs.createKeyPairName(keyPrefix, pubKey, workerName);
  config.launchSpec.InstanceType = bid.type;

  // We want to make sure that we overwrite the least that we need
  // to, so we check if there's already an object and set the key
  // in that case
  if (!config.launchSpec.Placement) {
    config.launchSpec.Placement = {
      AvailabilityZone: bid.zone,
    };
  } else {
    config.launchSpec.Placement.AvailabilityZone = bid.zone;
  }

  // Here are the minimum number of things which must be stored in UserData.
  // We will overwrite anything in the definition's UserData with these values
  // because they so tightly coupled to how we do provisioning
  let capacity = selectedInstanceType.capacity;
  assert(capacity, 'workerType did not have a capacity');

  let securityToken = slugid.v4();

  config.userData = {
    data: config.userData,
    capacity: capacity,
    workerType: worker.workerType,
    provisionerId: provisionerId,
    region: bid.region,
    availabilityZone: bid.zone,
    instanceType: bid.type,
    spotBid: bid.price,
    price: bid.truePrice,
    launchSpecGenerated: new Date().toISOString(),
    workerModified: worker.lastModified.toISOString(),
    provisionerBaseUrl: provisionerBaseUrl,
    securityToken: securityToken,
  };

  assert(!config.launchSpec.UserData, 'Dont specify UserData in launchSpec');
  config.launchSpec.UserData = new Buffer(JSON.stringify(config.userData)).toString('base64');

  // These are the keys that we require to be set.  They
  // are not listed as required in the api docs, but we
  // are going to say that they are required in our world
  // http://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_LaunchSpecification.html
  let mandatoryKeys = [
    'ImageId',
    'InstanceType',
    'KeyName',
  ];

  // Now check that we have all the mandatory keys
  for (let key of mandatoryKeys) {
    assert(config.launchSpec[key], 'Your launch spec must have key ' + key);
  }

  // These are the additional keys which *might* be specified
  let allowedKeys = mandatoryKeys.concat([
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
    'UserData',
  ]);

  // Now check that there are no unknown keys
  for (let key of Object.keys(config.launchSpec)) {
    assert(_.includes(allowedKeys, key), 'Your launch spec has invalid key ' + key);
  }

  // These are keys which we do not allow in the generated launch spec
  let disallowedKeys = [
  ];

  for (let key of disallowedKeys) {
    assert(!config.launchSpec[key], 'Your launch spec must not have key ' + key);
  }

  /**
   * We want to return all of the generated data.  There is a little redundancy here
   * but it's not much and I'd rather optimize for easy look up
   */
  return {
    launchSpec: config.launchSpec,
    secrets: config.secrets, // Remember these are static secrets
    scopes: config.scopes,
    userData: config.userData,
    securityToken: securityToken,
    workerType: worker.workerType,
  };
};

/**
 * Make sure that all combinations of LaunchSpecs work.  This sync
 * function will throw if there is an error found or will return
 * a dictionary of all the launch specs!
 */
WorkerType.testLaunchSpecs = function (worker, keyPrefix, provisionerId, provisionerBaseUrl, pubKey, workerName) {
  assert(worker);
  assert(keyPrefix);
  assert(provisionerId);
  assert(provisionerBaseUrl);
  assert(pubKey);
  assert(workerName);
  let errors = [];
  let launchSpecs = {};
  for (let r of worker.regions) {
    let region = r.region;
    launchSpecs[region] = {};
    for (let t of worker.instanceTypes) {
      let type = t.instanceType;
      try {
        let bid = {
          price: 1,
          truePrice: 1,
          region: region,
          type: type,
          zone: 'fakezone1',
        };
        let x = WorkerType.createLaunchSpec(
            bid,
            worker,
            keyPrefix,
            provisionerId,
            provisionerBaseUrl,
            pubKey,
            workerName);
        launchSpecs[region][type] = x;
      } catch (e) {
        errors.push(e);
      }
    }
  }
  if (errors.length > 0) {
    let err = new Error('Launch specifications are invalid');
    err.code = 'InvalidLaunchSpecifications';
    err.reasons = errors;
    debug(errors.map(x => x.stack || x).join('\n'));
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
  let desiredPending = Math.round(this.scalingRatio * runningCapacity);

  // desiredPending < pending - pendingCapacity    =>   Create spot requests
  //                                        , otherwise Cancel spot requests
  let capacityChange = pending - pendingCapacity - desiredPending;

  // capacityChange > 0  => Create spot requests for capacityChange
  // capacityChange < 0  => cancel spot requests for capacityChange
  let capacityAfterChange = capacityChange + pendingCapacity + runningCapacity;

  debug('%s: capacity change is %d, which will result in capacity %d',
        this.workerType, capacityChange, capacityAfterChange);

  // Ensure we are within limits
  let newCapacityChange;
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
WorkerType.prototype.determineSpotBids = function (managedRegions, pricing, change, biaser) {
  assert(managedRegions);
  assert(pricing);
  assert(change);
  assert(typeof change === 'number');
  assert(biaser);
  let spotBids = [];

  let pricingData = pricing;

  /* eslint-disable no-loop-func */
  while (change > 0) {
    let cheapestType;
    let cheapestRegion;
    let cheapestZone;
    let cheapestPrice;
    let cheapestBid;
    let cheapestBias;

    // Utility Factors, by instance type
    let uf = {};

    // Create a utility factor mapping between ec2 instance type
    // name and the numeric utility factor for easier access
    let types = this.instanceTypes.map(t => {
      uf[t.instanceType] = this.utilityOfType(t.instanceType);
      return t.instanceType;
    });

    // Create a list of regions which is the subset of the regions
    // which this worker type is configured for and that the
    // provisioner is configured for
    let regions = this.regions
        .filter(r => _.includes(managedRegions, r.region))
        .map(r => r.region);

    // Instead of interleaving debug() calls, let's instead join all of these
    // into one single debug call
    let priceDebugLog = [];

    for (let region of regions) {
      for (let type of types) {
        let zones = [];
        if (pricingData[region] && pricingData[region][type]) {
          zones = Object.keys(pricingData[region][type]);
        }
        for (let zone of zones) {
          try {
            let potentialBid = pricingData[region][type][zone];
            let bias = biaser.getBias(region, zone, type);
            let potentialPrice = potentialBid / uf[type] * bias;
            priceDebugLog.push(util.format('%s %s/%s/%s has a bias of %d',
                  this.workerType, region, zone, type, bias));
            assert(typeof potentialBid === 'number');
            assert(typeof potentialPrice === 'number');
            if (!cheapestPrice) {
              // If we don't already have a cheapest price, that means we
              // should just take the first one we see
              priceDebugLog.push(util.format('%s no existing price, picking %s/%s/%s: %d(%d)',
                    this.workerType, region, zone, type, potentialPrice, potentialBid));
              cheapestPrice = potentialPrice;
              cheapestRegion = region;
              cheapestType = type;
              cheapestZone = zone;
              cheapestBid = Math.ceil(potentialBid * 2 * 1000000) / 1000000;
              cheapestBias = bias;
            } else if (potentialPrice < cheapestPrice) {
              // If we find that we have a cheaper option, let's switch to it
              priceDebugLog.push(util.format('%s cheapest was %s/%s/%s: %d(%d), now is %s/%s/%s: %d(%d)',
                    this.workerType,
                    cheapestRegion, cheapestZone, cheapestType, cheapestPrice, cheapestBid,
                    region, zone, type, potentialPrice, potentialBid));
              cheapestPrice = potentialPrice;
              cheapestRegion = region;
              cheapestType = type;
              cheapestZone = zone;
              cheapestBid = Math.ceil(potentialBid * 2 * 1000000) / 1000000;
              cheapestBias = bias;
            } else {
              // If this option is not first and not cheapest, we'll
              // ignore it but tell the logs that we did
              priceDebugLog.push(util.format('%s is not picking %s/%s/%s: %d(%d)',
                    this.workerType,
                    region, zone, type, potentialPrice, potentialBid));
            }
          } catch (err) {
            console.log(err);
            console.dir(pricingData);
            if (err.stack) {
              console.log(err.stack);
            }
            throw err;
          }
        }
      }
    }

    if (!cheapestBid) {
      throw new Error('Could not create any bid');
    }

    if (cheapestPrice < this.minPrice) {
      let oldCheapestBid = cheapestBid;
      cheapestBid = Math.ceil(this.minPrice / uf[cheapestType] * 1000000) / 1000000;
      priceDebugLog.push(util.format('%s price was too low %d --> %d',
            this.workerType, oldCheapestBid, cheapestBid));
    }

    debug(priceDebugLog.join('\n'));

    // Probably unneeded but I'm being paranoid
    assert(typeof cheapestBid === 'number', 'bid must be a number');
    assert(typeof cheapestPrice === 'number', 'price must be a number');

    if (cheapestPrice <= this.maxPrice) {
      change -= this.capacityOfType(cheapestType);
      spotBids.push({
        price: cheapestBid, // Ugh, awful naming!
        truePrice: cheapestPrice, // for history reasons
        region: cheapestRegion,
        type: cheapestType,
        zone: cheapestZone,
        bias: cheapestBias,
      });
    } else {
      debug('WorkerType %s is exceeding its max price of %d with %d',
            this.workerType, this.maxPrice, cheapestPrice);
      return spotBids;
    }

    // This is a sanity check to prevent a screw up where we theoretically
    // bid $6000 for a spot node.  Code above should make sure that the optimal
    // bid is selected.  I would argue that if we start bidding on $10/h machines
    // that we really ought to be very well aware of this, and having to make a
    // change to the provisioner is a demonstration of our knowledge of that.
    if (cheapestBid > 10) {
      debug('[alert-operator] %s spot bid is exceptionally high...', this.workerType);
      return spotBids;
    }
  }
  /* eslint-enable no-loop-func */

  return spotBids;
};

module.exports = WorkerType;
