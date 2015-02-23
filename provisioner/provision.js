'use strict';

var Promise = require('promise');
var _debug = require('debug');
var baseDbgStr = 'aws-provisioner'; 
var generalDebug = require('debug')(baseDbgStr + ':general');
var base = require('taskcluster-base');
var aws = require('multi-region-promised-aws');
var taskcluster = require('taskcluster-client');
var lodash = require('lodash');
var uuid = require('node-uuid');
var util = require('util');
var data = require('./data');
var Cache = require('../cache');

// Docs for Ec2: http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/EC2.html

/* Influx DB
    - probably in queue
    - tests in base.
 */

/*
  TODO: Things in here

   2. sprinkle some uuids on debug messages for sanity's sake
   5. schema for allowedinstancetypes should ensure overwrites.instancetype exists
  12. pricing history should use the nextToken if present to
  13. store requests and instance data independently from AWS so that we don't have issues
      with the eventual consistency system.  This will also let us track when
      a spot request is rejected
  14. We should only kill orphans which have been orphaned for X hours in case of accidentally
      deleting the workerTypes
  17. provide metrics on how long it takes for spot request to be filled, etc
  22. move data.WorkerType.configure to bin/provisioner... why?
  25. overwrite userdata with temporary taskcluster credentials as base64 encoded json
  26. move creating launch configuration to the WorkerType object
  28. pulse msg for taskPending, has provisioner id in it.  could use to maintain
      state of pending jobs
  31. find cheapest instance per region, then find the cheapest type
  32. testers don't change instance types!!
  34. verify that we use the subset of workerType allowed regions and config allowed
      regions instead of only one or the other
  35. Look at Rail's joi patch and figure out why things are breaking with it
  36. Create a cache object which stores the expiration date, data and has
      a .stillValid() method

  TODO: Things in the server API

  23. store the list of known to exist keynames in the program state OR #24 below.
  24. move the keypair creation and deletion to the create/delete provisioner-api
  29. do ami copy when machine is inserted or updated in the azure table storage
      http://aws.amazon.com/about-aws/whats-new/2013/03/12/announcing-ami-copy-for-amazon-ec2/
  36. add the following things:
        - api end point that lists all instances and spot requests in all regions
        - api end point that shuts off all instances managed by this provisioner
        - api end point to kill all instances of a specific type
        - api end point to show capacity, etc for each workerType

  TODO: Other
  30. add influx timing to the multiaws
  33. api endpoint when the machine comes up to tell us how long it took to turn on

  Questions:
  1. How can I get JSON Schema to say I need a dictionary, i don't care what its
     key names are, but I care that the key points to an object of a given shape
  
 */


/* Create a Provisioner object.  This object knows how to provision
 * AWS Instances.  The config object should be structured like this:
    cfg = {
      provisionerId: 'aws-provisioner2-dev',
      workerTypeTableName: 'AWSWorkerTypesDev',
      awsKeyPrefix: 'aws-provisioner2-dev:',
      taskcluster: { <taskcluster client library config object>},
      aws: { <aws config object> },
      azure: { <azure config object> },
      provisionIterationInterval: 10000,
    };
*/
function Provisioner(cfg) {
  // This is the ID of the provisioner.  It is used to interogate the queue
  // for pending tasks
  this.provisionerId = cfg.provisionerId;
  if (!this.provisionerId || typeof this.provisionerId !== 'string') {
    throw new Error('Missing or invalid provisioner id');
  }

  // This is a prefix which we use in AWS to determine ownership
  // of a given instance.  If we could tag instances while they were
  // still spot requests, we wouldn't need to do this.
  this.awsKeyPrefix = cfg.awsKeyPrefix;
  if (!this.awsKeyPrefix || typeof this.awsKeyPrefix !== 'string') {
    throw new Error('AWS Key prefix is missing or invalid');
  }

  // This is the number of milliseconds to wait between completed provisioning runs
  this.provisionIterationInterval = cfg.provisionIterationInterval;
  if (!this.provisionIterationInterval || typeof this.provisionIterationInterval !== 'number' || isNaN(this.provisionIterationInterval)) {
    // I remember there being something funky about using isNaN in JS...
    throw new Error('Provision Iteration Interval is missing or not a number');
  }

  // This is the Queue object which we use for things like retreiving
  // the pending jobs.
  if (!cfg.taskcluster || typeof cfg.taskcluster !== 'object') {
    throw new Error('Taskcluster client configuration is invalid');
  }
  if (!cfg.taskcluster.credentials || typeof cfg.taskcluster.credentials !== 'object') {
    throw new Error('Taskcluster client credentials are misformed');
  }
  // We only grab the credentials for now, no need to store them in this object
  this.Queue = new taskcluster.Queue({credentials: cfg.taskcluster.credentials});

  if (!cfg.workerTypeTableName || typeof cfg.workerTypeTableName !== 'string') {
    throw new Error('Missing or invalid workerType table name');
  }
  if (!cfg.azure || typeof cfg.azure !== 'object') {
    throw new Error('Missing or invalid Azure configuration');
  }
  this.WorkerType = data.WorkerType.setup({
    table: cfg.workerTypeTableName,
    credentials: cfg.azure,
  });
  
  this.allowedAwsRegions = cfg.allowedAwsRegions;
  if (!this.allowedAwsRegions) {
    throw new Error('For now, you need to configure a specific AWS region.  hint: us-west-2');
  }

  this.ec2 = cfg.ec2;

  this.__provRunId = 0;
}

module.exports.Provisioner = Provisioner;


/**
 * Start running a provisioner.
 */
Provisioner.prototype.run = function () {
  var that = this;
  this.__keepRunning = true;

  function provisionIteration() {
    var p = that.runAllProvisionersOnce();
    p = p.then(function() {
      generalDebug('Finished a provision iteration');
      if (that.__keepRunning && !process.env.PROVISION_ONCE) {
        generalDebug('Scheduling another provisioning iteration');
        setTimeout(provisionIteration, that.provisionIterationInterval);
      } else {
        generalDebug('PROVISION_ONCE environment variable is set, ');
      }
    });
    p = p.catch(function(err) {
      generalDebug('Error running a provisioning iteration');
      generalDebug(err);
    });
    
    // Hmm, do I really need this?
    try {
      p.done();
    } catch(e) {
      console.error('Error during provisioning iteration', e, e.stack);
    }
  }

  provisionIteration();

};

/**
 * Stop launching new provisioner iterations
 */
Provisioner.prototype.stop = function () {
  this.__keepRunning = false;
};

/* This is the main entry point into the provisioning routines.  It will
 * return an array of promises with the outcome of provisioning */
Provisioner.prototype.runAllProvisionersOnce = function() {
  // We grab the pending task count here instead of in the provisionForType
  // method to avoid making a bunch of unneeded API calls

  var that = this;
  var debug = _debug(baseDbgStr + ':all:run_' + ++this.__provRunId);

  var workerTypes;
  var awsState;
  var pricing;
  debug('%s Beginning provisioning', this.provisionerId);
  var p = Promise.all([
    this.WorkerType.loadAll(),
    this.fetchAwsState(debug)
  ]);

  p = p.then(function(res) {
    workerTypes = res.shift();
    awsState = res.shift();

    debug('AWS has instances of workerTypes: %s', JSON.stringify(Object.keys(awsState)));
    // We could probably combine this with the .map of workerTypes below... meh...
    debug('WorkerType Definitions for %s', JSON.stringify(workerTypes.map(function(x) {
      return x.workerType;
    })));

    return res;
  });

  p = p.then(function() {
    return Promise.all([
        that.fetchSpotPricingHistory(debug, workerTypes),
        that.killOrphans(debug, awsState, workerTypes),
    ]);
  });

  p = p.then(function(res) {
    pricing = res[0];
    debug('Killed these orphaned instances: %s', res[1]);
    return; 
  });

  p = p.then(function() {
    return Promise.all(workerTypes.map(function(workerType) {
      var wtDebug = 
        _debug(baseDbgStr + ':' + workerType.workerType + ':run_' + that.__provRunId);
      return that.provisionType(wtDebug, workerType, awsState, pricing);
    }));
  });

  p = p.then(function(res) {
    debug('Provisioning run completed'); 
    return res;
  });

  return p;
}

/**
 * Fetch the state of all machines running in AWS
 */
Provisioner.prototype.fetchAwsState = function(debug) {
  var that = this;

  var p = Promise.all([
    this.ec2.describeInstances({
      Filters: [{
        Name: 'key-name',
        Values: [this.awsKeyPrefix + '*']
      },{
        Name: 'instance-state-name',
        Values: ['running', 'pending']
      }
    ]}),
    this.ec2.describeSpotInstanceRequests({
      Filters: [{
        Name: 'launch.key-name',
        Values: [this.awsKeyPrefix + '*']
      }, {
        Name: 'state',
        Values: ['open']
      }]
    }),
  ]);

  p = p.then(function(res) {
    return that._classifyAwsState(debug, res[0], res[1]);
  });

  return p;
}

/**
 * For easier testing, the logic to sort the AwsState into buckets
 * is in its own function
 */
Provisioner.prototype._classifyAwsState = function(debug, instanceState, spotRequestState) {
  var that = this;
  var allState = {};
  this.allowedAwsRegions.forEach(function(region) {
      allState[region] = {};
      instanceState[region].Reservations.forEach(function(reservation) {
        reservation.Instances.forEach(function(instance) {
          var workerType = instance.KeyName.substr(that.awsKeyPrefix.length);
          var instanceState = instance.State.Name;
          
          if (!allState[region][workerType]) {
            allState[region][workerType] = {};
          }
          if (!allState[region][workerType][instanceState]){
            allState[region][workerType][instanceState] = [];
          }

          allState[region][workerType][instanceState].push(instance);
        });
      });

      spotRequestState[region].SpotInstanceRequests.forEach(function(request) {
        var workerType = request.LaunchSpecification.KeyName.substr(that.awsKeyPrefix.length);

        if (!allState[region][workerType]) {
          allState[region][workerType] = {};
        }
        if (!allState[region][workerType]['requestedSpot']){
          allState[region][workerType]['requestedSpot'] = [];
        }
        allState[region][workerType]['requestedSpot'].push(request);

      });
    });

    return allState;
}

/* When we find an EC2 instance or spot request that is for a workerType that we
 * don't know anything about, we will kill it.  NOTE: We currently do this as soon
 * as the workerType definition is not found, but we should probably do something
 * like wait for it to be gone for X hours before deleting it. */
Provisioner.prototype.killOrphans = function(debug, awsState, workerTypes) {
  var that = this;

  var p = Promise.all(this.allowedAwsRegions.map(function(region) {
    return that.killOrphansInRegion(debug, region, awsState[region], workerTypes);
  }));
  
  return p;

}

/* Go through each region's state, find and kill orphans */
Provisioner.prototype.killOrphansInRegion = function(debug, awsRegion, awsRegionState, workerTypes) {
  var that = this;

  var extant = Object.keys(awsRegionState);
  var known = workerTypes.map(function(x) { return x.workerType });
  var orphans = extant.filter(function(x) { return known.indexOf(x) > 0 });
  var instances = [];
  var srs = [];

  orphans.forEach(function(name) {
    Array.prototype.push.apply(instances, awsRegionState[name].running.map(function(x) { return x.InstanceId; }));
    Array.prototype.push.apply(instances, awsRegionState[name].pending.map(function(x) { return x.InstanceId; }));
    Array.prototype.push.apply(srs, awsRegionState[name].requestedSpot.map(function(x) { return x.SpotInstanceRequestId; }));
  });

  var killinators = [];
 
  if (instances.length > 0) {
    killinators.push(this.ec2.terminateInstances.inRegion(awsRegion, {
      InstanceIds: instances,
    }));
  } 

  if (srs.length > 0) {
    killinators.push(this.ec2.cancelSpotInstanceRequests.inRegion(awsRegion, {
      SpotInstanceRequestIds: srs,
    }));
  }

  return Promise.all(killinators).then(function(res) {
    return orphans; 
  });
  
}



/* Provision a specific workerType.  This promise will have a value of true if
 * everything worked.  Another option is resolving to the name of the worker to
 * make it easier to see which failed, but I'd prefer that to be tracked in the
 * caller. Note that awsState as passed in should be specific to a workerType
 */
Provisioner.prototype.provisionType = function(debug, workerType, awsState, pricing) {
  var that = this;

  var capacity;
  var pending;

  var p = Promise.all([
    this.countRunningCapacity(
      debug,
      workerType,
      awsState,
      this.allowedAwsRegions,
      ['pending', 'running', 'requestedSpot']),
    this.Queue.pendingTasks(this.provisionerId, workerType.workerType),
  ]);

  p = p.then(function (res) {
    pending = res[1];
    if (typeof pending !== 'number') {
      pending = 0;
      debug('GRRR! Queue.pendingTasks(str, str) is returning garbage!  Assuming 0');
    }
    capacity = res[0]; 
    debug('%d existing capacity, %d pending tasks', capacity, pending);
    return res;
  });

  p = p.then(function () {
    var change = determineCapacityChange(workerType.scalingRatio, capacity, pending);
    if (capacity + change > workerType.maxCapacity) {
      debug('computed capacity change of %d exceeds max of %d', change, workerType.maxCapacity);
      change = workerType.maxCapacity - capacity;
    } else if (capacity + change < workerType.minCapacity) {
      debug('computed capacity change of %d lower than min of %d', change, workerType.minCapacity);
      change = workerType.minCapacity - capacity;
    } else {
      debug('computed capacity change of %d is within bounds', change);
    }
    return change;
  });

  p = p.then(function(change) {
    return that.determineSpotBids(debug, workerType, awsState, pricing, change);
  });

  p = p.then(function(spotBids) {
    if (spotBids.length === 0) {
      debug('no spot bids needed');
    } else {
      spotBids.forEach(function(spotBid) {
        var s = spotBid;
        debug('creating spot bid for %d in %s for $%d', s.spotPrice, s.instanceType, s.region);
      });
    }
    return Promise.all(spotBids.map(function(spotBid) {
      return that.spawnInstance(debug, workerType, spotBid.region, spotBid.instanceType, spotBid.spotPrice);
    }));
  });

  p = p.then(function() {
    return that.killExcess(debug, workerType, awsState);
  });
  
  return p;
}

/**
 * Fetch the last hour of EC2 pricing data.  For now, we'll
 * only fetch the first page of data, but in the future we will
 * make sure to use the nextToken to read the whole thing in
 */
Provisioner.prototype.fetchSpotPricingHistory = function(debug, workerTypes) {
  var that = this;

  // We wrap this instead of the raw ec2 method in a cache
  // because we need the start date to be updated
  function fetchSpotPricingHistory() {
    debug('fetching new cached value');
    var startDate = new Date();
    startDate.setHours(startDate.getHours() - 2);
    var requestObj = {
      StartTime: startDate,
      Filters: [{
        Name: 'product-description',
        Values: ['Linux/UNIX'],
      }],
      InstanceTypes: types,
    }
    return that.ec2.describeSpotPriceHistory(requestObj);
  }

  if (!this.pricingCache) {
    this.pricingCache = new Cache(20, fetchSpotPricingHistory); 
  }

  // We want to find every type of instanceType that we allow
  var types = [];
  workerTypes.forEach(function(workerType) {
    var newTypes = Object.keys(workerType.types).filter(function(type) {
      return types.indexOf(type) === -1;
    });
    Array.prototype.push.apply(types, newTypes);
  });

  var p = this.pricingCache.get();

  p = p.then(function(pricing) {
    var regions = Object.keys(pricing);
    var fixed = {};

    // Get rid of the key we don't care about
    regions.forEach(function(region) {
      fixed[region] = pricing[region].SpotPriceHistory;
    });

    return fixed;
  })

  return p;
};

/* Count the amount of capacity that's running or pending */
Provisioner.prototype.countRunningCapacity = function(debug, workerType, awsState, regions, states) {
  // For now, let's assume that an existing node is occupied
  var capacity = 0;
  var capacities = {};
  var instances = [];

  // Build mapping between instance type and capacity
  Object.keys(workerType.types).forEach(function(type) {
    capacities[type] = workerType.types[type].capacity;   
  });

  // Find all instances which are running in the requested regions
  this.allowedAwsRegions.forEach(function(region) {
    if (awsState[region][workerType.workerType]) {
      var wtsr = awsState[region][workerType.workerType];
      // We are including pending instances in this loop because we want to make
      // sure that they aren't ignored and duplicated
      if (states.indexOf('running') > 0 && wtsr.running) {
        Array.prototype.push.apply(instances, wtsr.running);
      }
      if (states.indexOf('pending') > 0 && wtsr.pending) {
        Array.prototype.push.apply(instances, wtsr.pending);
      }
      if (states.indexOf('requestedSpot') > 0 && wtsr.requestedSpot) {
        Array.prototype.push.apply(instances, wtsr.requestedSpot);
      }
    }
  });

  debug('found %d instances', instances.length);

  // For each instance we should add its capacity
  instances.forEach(function(instance, idx, arr) {
    var instanceType;

    // Instance type is stored differently for spot requests
    // and instances.  We should instead
    if (instance.InstanceType) {
      instanceType = instance.InstanceType;
    } else if (instance.LaunchSpecification) {
      instanceType = instance.LaunchSpecification.InstanceType;
    } else {
      throw new Error('Received something that is not a spot request or instance');
    }

    var potentialCapacity = capacities[instanceType];
    if (potentialCapacity) {
      capacity += capacities[instanceType];
    } else {
      /* Rather than assuming that an unknown instance type has no capacity, we'll
         assume the basic value (1) and move on.  Giving any other value would be
         a bad idea, 0 means that we would be scaling indefinately and >1 would be
         making assumptions which are not knowable */
      debug('NOTE! instance type %s does not have a stated capacity', instanceType);
      debugger;
      capacity++;
    }
  });

  return (capacity);
      
}

/* Create Machines! */
Provisioner.prototype.spawnInstance = function(debug, workerType, region, instanceType, spotPrice) {
  var that = this;
  var launchSpec = that.createLaunchSpec(debug, workerType, region, instanceType);

  debug('submitting spot request');

  var p = that.ec2.requestSpotInstances.inRegion(region, {
    InstanceCount: 1,
    Type: 'one-time',
    LaunchSpecification: launchSpec,
    SpotPrice: String(spotPrice).toString(),
  });

  p = p.then(function(spotRequest) {
    // We only do InstanceCount == 1, so we'll hard code only caring about the first sir
    debugger;
    var sir = spotRequest.SpotInstanceRequests[0].SpotInstanceRequestId;
    debug('submitted spot request %s', sir);
    return sir;
  });

  return p;
}

/* Select region, instance type and spot bids based on the amount of capacity units needed.
 * The region is picked randomly to distribute load but in future we could do smart things
 * like say no region can use more than X% of instances.  We use the utility factor to
 * determine which instance type to bid on.  Utility factor is a relative performance 
 * indicator.  If we say that a large is worth 2 and a small is worth 1, we'll bid on
 * smalls unless the price of a large is less than double that of a small.  Utility factors
 * are currently hardcoded, but in the future we could do smart things like compare runtimes
 * of things run on each instance type.  The spot bid is calcuated at the one in the price
 * history multiplied by 1.3 to give a 30% buffer. */
Provisioner.prototype.determineSpotBids = function(debug, workerType, awsState, pricing, change) {
  var that = this;
  var spotBids = [];
  
  while (change > 0) {

    // For now, let's randomly pick regions.  The assumption here is that over time
    // each datacenter will average the same number of nodes.  We should be smarter
    // and do things like monitor AWS State to see which regions have the most
    // capacity and assign new nodes to other regions
    var randomRegionIdx = Math.floor(Math.random() * that.allowedAwsRegions.length);
    var region = that.allowedAwsRegions[randomRegionIdx];

    var ait = workerType.types;

    var cheapestType;
    var cheapestPrice;
    var spotBid;
    var priceMap = {};

    Object.keys(ait).forEach(function(potentialType) {
      var potentialSpotBid = that.findPriceForType(debug, pricing, region, potentialType);
      // Like capacity we assume that if a utility factor is not available
      // that we consider it to be the base (1)
      var potentialPrice = (ait[potentialType].utility || 1) * potentialSpotBid;
      if (!cheapestPrice || (potentialPrice < cheapestPrice && potentialSpotBid > workerType.maxSpotBid)) {
        cheapestPrice = potentialPrice;
        cheapestType = potentialType;
        // We bid a little higher because we don't want the machine to end
        // too soon
        spotBid = Math.ceil(potentialSpotBid * 1.3 * 1000000) / 1000000;
      }
    });

    change -= ait[cheapestType].capacity;

    spotBids.push({
      region: region,
      spotPrice: spotBid,
      instanceType: cheapestType,
    });
  }

  return spotBids;
}

/* Given the pricing data, what's the average price for this instance type.
 * For now, we'll just pick the average of the most recent for each availability
 * zone.  In future we should do things like:
 *    - weight each AZ's price by how long it was the price
 *    - do other smart things
 */
Provisioner.prototype.findPriceForType = function(debug, pricing, region, type) {
  // This could probably be a single loop
  var onlyThisType = pricing[region].filter(function(x) {
    return x.InstanceType === type;
  });
  var azsSeen = [];
  var sum = 0;
  onlyThisType.forEach(function(histPoint) {
    if (azsSeen.indexOf(histPoint.AvailabilityZone) < 0) {
      sum += parseFloat(histPoint.SpotPrice);
      azsSeen.push(histPoint.AvailabilityZone);
    }
  });

  return sum / azsSeen.length;
}


/* Kill machines when we have more than the maximum allowed */
Provisioner.prototype.killExcess = function(debug, workerType, awsState) {
  var that = this;
  // We only want to kill running or pending instances when we're over capacity
  // because some of the oldest machines might end before spot requests are
  // fulfilled.  In that case, we don't want to cancel a spot request until
  // it's actually converted into an instance and is costing money
  // NOTE: This promise should be removed... it's not needed
  var p = Promise.resolve(this.countRunningCapacity(debug, workerType, awsState, this.allowedAwsRegions, ['running', 'pending']));

  p = p.then(function(capacity) {
    if (capacity < workerType.maxCapacity) {
      debug('no excess capacity');
      return 0;
    } else {
      capacityToRemove = capacity - workerType.maxCapacity;
      debug('%d too many capacity units', capacityToRemove);
      return capacityToRemove;
    }
  });

  p = p.then(function(capacityToRemove) {
    // Don't want to pollute the rest of the program's aws state
    var deathWarrants = {};
    var state = {};

    // Create data structures
    that.allowedAwsRegions.forEach(function(region) {
      // We want safely mutatable state but only the ID and InstanceType
      state[region] = {
        pending: (awsState[region].pending || []).map(function(instance) {
          return {
            InstanceType: instance.InstanceType,
            InstanceId: instance.InstanceId,
          };
        }),
        spotRequests: (awsState[region].requestedSpot || []).map(function(sr) {
          return {
            InstanceType: sr.LaunchSpecification.InstanceType,
            SpotInstanceRequestId: sr.SpotInstanceRequestId,
          };
        }),
      };

      deathWarrants[region] = {
        instances: [],
        spotRequests: [],
      };
    });

    var emptyRegions = [];
    while (capacityToRemove > 0 && emptyRegions.length == 0) {
      // Let's be smarter about this later
      var randomRegionIdx = Math.floor(Math.random() * that.allowedAwsRegions.length);
      var region = that.allowedAwsRegions[randomRegionIdx];

      if (state[region].spotRequests.length > 0) {
        var possibility = state[region].spotRequests.shift();
        var instanceType = possibility.InstanceType;
        var capacity = workerType.types[instanceType].capacity;
        capacityToRemove -= capacity;
        deathWarrants[region].spotRequests.push(possibility.SpotInstanceRequestId);
        debug('killing %s in %s to reduce %d capacity', instanceType, region, capacity);
      } else {
        emptyRegions.push(region);
        debug('nothing to kill in %s', region);
      }
    }

    return Promise.all(that.allowedAwsRegions.filter(function(region) {
      return deathWarrants[region].spotRequests.length > 0; 
    }).map(function(region) {
      return that.ec2.cancelSpotInstanceRequests.inRegion(region, {
        SpotInstanceRequestIds: deathWarrants[region].spotRequests,
      });
    }));

  });

  p = p.then(function(res) {
    debug('finished killing extra spot requests');
  });

  return p;
}

var validB64Regex = /^[A-Za-z0-9+/=]*$/;

/* Create a launch spec with values overwritten for a given aws instance type.
   the instanceTypeParam is the overwrites object from the allowedInstances
   workerType field */
Provisioner.prototype.createLaunchSpec = function(debug, workerType, region, instanceType) {
  // These are the keys which are only applicable to a given region.
  // We're going to make sure that none are set in the generic launchSpec
  var regionSpecificKeys = ['ImageId'];
  var that = this;
  if (!workerType.types[instanceType]) {
    var e = workerType.workerType + 'does not allow instance type ' + instanceType;
    throw new Error(e);
  }

  var actual = lodash.clone(workerType.types[instanceType].overwrites);
  var newSpec = lodash.defaults(actual, workerType.launchSpecification);
  if (!validB64Regex.exec(newSpec.UserData)) {
    throw new Error('Launch specification does not contain Base64: ' + newSpec.UserData);
  }
  newSpec.KeyName = that.awsKeyPrefix + workerType.workerType;
  newSpec.InstanceType = instanceType;
  regionSpecificKeys.forEach(function(key) {
    newSpec[key] = workerType.regions[region].overwrites[key];
  });

  return newSpec;
}

/* Figure out how many capacity units need to be created.  This number is
 * determined by calculating how much capacity is needed to maintain a given
 * scaling ratio and returns the number of capacity units which need to be
 * created or destroyed.  This will give an exact number of units, something
 * else will be required to decide what to do if the number of needed capacity
 * units does not fit nicely with the number of capacity units available per
 * instance type.  Positive value means add capacity, negative means destroy */
function determineCapacityChange(scalingRatio, capacity, pending) {
  // We need to know the current ratio of capacity to pending
  var percentPending = 1 + pending / capacity;

  var change = 0;

  // We only want to scale anything once we have a pending
  // percentage that exceeds the scalingRatio
  if (percentPending > scalingRatio) {
    // But when we do, let's submit enough requests that
    // we end up in an ideal state if all are fulfilled
    var ideal = (capacity + pending) / scalingRatio;
    var change = ideal - capacity;
  }

  return Math.round(change);

}
module.exports._determineCapacityChange = determineCapacityChange;
