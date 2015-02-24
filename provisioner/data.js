var base        = require('taskcluster-base');
var assert      = require('assert');
var Promise     = require('promise');
var lodash      = require('lodash');

var KEY_CONST = 'worker-type';

/** Entities for persisting WorkerType */
var WorkerType = base.Entity.configure({
  version: 1,
  partitionKey: base.Entity.keys.ConstantKey(KEY_CONST),
  rowKey: base.Entity.keys.StringKey('workerType'),
  properties: {
    workerType: base.Entity.types.String,
    launchSpecification: base.Entity.types.JSON,
    minCapacity: base.Entity.types.Number,
    maxCapacity: base.Entity.types.Number,
    scalingRatio: base.Entity.types.Number,
    minSpotBid: base.Entity.types.Number,
    maxSpotBid: base.Entity.types.Number,
    canUseOndemand: base.Entity.types.JSON,
    canUseSpot: base.Entity.types.JSON,
    types: base.Entity.types.JSON,
    regions: base.Entity.types.JSON,
  },
  context: ['ec2', 'keyPrefix', 'pubKey'],
});

/** Create a worker type */
WorkerType.create = function(workerType, properties) {
  properties.workerType = workerType;
  return base.Entity.create.call(this, properties);
};

/** Load worker from worker type */
WorkerType.load = function(workerType) {
  return base.Entity.load.call(this, {
    workerType: workerType
  });
};

/** Give a JSON version of a worker type */
WorkerType.prototype.json = function() {
  return lodash.clone(this.__properties);
};

/** Load all worker types.  Note that this
 * This method only returns the __properties
 * from base.Entity.scan */
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
 * Create an AWS LaunchSpecification for this workerType
 */
WorkerType.prototype.createLaunchSpec = function(debug, region, instanceType) {
  // These are the keys which are only applicable to a given region.
  
  regionSpecificKeys = ['ImageId'];

  // We're going to make sure that none are set in the generic launchSpec
  var that = this;
  if (!this.types[instanceType]) {
    var e = this.workerType + 'does not allow instance type ' + instanceType;
    throw new Error(e);
  }

  var actual = lodash.clone(this.types[instanceType].overwrites);
  var newSpec = lodash.defaults(actual, this.launchSpecification);
  if (!/^[A-Za-z0-9+/=]*$/.exec(newSpec.UserData)) {
    throw new Error('Launch specification does not contain Base64: ' + newSpec.UserData);
  }
  newSpec.KeyName = this.keyPrefix + this.workerType;
  newSpec.InstanceType = instanceType;
  regionSpecificKeys.forEach(function(key) {
    newSpec[key] = that.regions[region].overwrites[key];
  });

  return newSpec;
    
};

/**
 * Return the list of regions which are configured to be  
 */
WorkerType.prototype.listRegions = function() {
  var that = this;
  return Object.keys(this.regions).filter(function(region) {
    return that.ec2.regions.indexOf(region) !== -1;
  }); 
}

/**
 * Create a key pair in all AWS Regions known to this worker
 * type
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
 * Delete a KeyPair when it is no longer needed
 * NOTE: This does not shutdown any instances!
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
 * any open spot requests.  I guess this could use
 * exisiting aws state from aws-state.js but this is
 * pretty single-purposed.
 */
WorkerType.prototype.killall = function(debug) {
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
    debug(res);
    debug('Submitted kill/cancel requests for %s', that.workerType);
    return that.deleteKeyPair();
  });

  return p;

}

/**
 * Provision this WorkerType
 */
WorkerType.prototype.provision = function(debug, pricing, capacity, pending) {
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
}

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
      that.regionsForType().forEach(function(potentialRegion) {
        debugger;
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
 * Spawn an instance!
 */
WorkerType.prototype.spawn = function(debug, bid) {
  var launchSpec = this.createLaunchSpec(bid.region, bid.type);

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
    debug('%s would exceed max, using %d instead', this.workerType, change); 
  } else if (capacity + change < this.minCapacity) {
    change = this.minCapacity - capacity;
    debug('%s wouldn\'t be meet min, using %d instead', this.workerType, change);
  } 

  return Math.round(change);
  
};


/**
 * Load all workerTypes.  This won't scale perfectly, but
 * we don't see there being a huge number of these upfront
 */
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

exports.WorkerType = WorkerType;
