'use strict';

var Promise = require('promise');
var debug = require('debug')('aws-provisioner:provisioner:provision');
var base = require('taskcluster-base');
var aws = require('multi-region-promised-aws');
var taskcluster = require('taskcluster-client');
var lodash = require('lodash');
var uuid = require('node-uuid');
var util = require('util');
var data = require('./data');

// Docs for Ec2: http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/EC2.html

/* Influx DB
    - probably in queue
    - tests in base.
 */

/*
  TODO:

   2. sprinkle some uuids on debug messages for sanity's sake
   5. schema for allowedinstancetypes should ensure overwrites.instancetype exists
  12. pricing history should use the nextToken if present to
  13. store requests and instance data independently from AWS so that we don't have issues
      with the eventual consistency system.  This will also let us track when
      a spot request is rejected
  14. We should only kill orphans which have been orphaned for X hours in case of accidentally
      deleting the workerTypes
  17. provide metrics on how long it takes for spot request to be filled, etc
  21. rename pulse/pulseRate to provisioningInterval
  22. move data.WorkerType.configure to bin/provisioner
  23. store the list of known to exist keynames in the program state OR 24.
  24. move the keypair creation and deletion to the create/delete provisioner-api
  25. overwrite userdata with temporary taskcluster credentials as base64 encoded json
  26. move creating launch configuration to the WorkerType object
  27. use Queue.pendingTasks instead -- extra api hits...
  28. pulse msg for taskPending, has provisioner id in it.  could use to maintain
      state of pending jobs
  29. do ami copy when machine is inserted or updated in the azure table storage
      http://aws.amazon.com/about-aws/whats-new/2013/03/12/announcing-ami-copy-for-amazon-ec2/
  30. add influx timing to the multiaws
  31. find cheapest instance per region, then find the cheapest type
  32. testers don't change instance types
  33. api endpoint when the machine comes up to tell us how long it took to turn on
  
 */


/* Create a Provisioner object.  This object knows how to provision
 * AWS Instances.  The config object should be structured like this:
    cfg = {
      provisionerId: 'aws-provisioner2-dev',
      workerTypeTableName: 'AWSWorkerTypesDev',
      awsKeyPrefix: 'aws-provisioner2-dev:',
      awsInstancePubKey: 'ssh-rsa .....',
      taskcluster: { <taskcluster client library config object>},
      aws: { <aws config object> },
      azure: { <azure config object> },
      pulseRate: 10000,
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

  // For new types of workers, we need to know what public key data
  // to pass to the instance as the key data
  this.awsInstancePubKey = cfg.awsInstancePubKey;
  if (!this.awsInstancePubKey || typeof this.awsInstancePubKey !== 'string') {
    throw new Error('AWS Instance key is missing or invalid');
  }

  // This is the number of milliseconds to wait between completed provisioning runs
  this.pulseRate = cfg.pulseRate;
  if (!this.pulseRate || typeof this.pulseRate !== 'number' || isNaN(this.pulseRate)) {
    // I remember there being something funky about using isNaN in JS...
    throw new Error('Pulse rate is missing or not a number');
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
  this.WorkerType = data.WorkerType.configure({
    tableName: cfg.workerTypeTableName,
    credentials: cfg.azure,
  });
  

  if (!cfg.aws || typeof cfg.aws !== 'object') {
    throw new Error('Missing or invalid AWS configuration object');
  }
  this.allowedAwsRegions = cfg.allowedAwsRegions;
  if (!this.allowedAwsRegions) {
    throw new Error('For now, you need to configure a specific AWS region.  hint: us-west-2');
  }

  this.ec2 = new aws('EC2', cfg.aws, this.allowedAwsRegions);
}

module.exports.Provisioner = Provisioner;


Provisioner.prototype.run = function () {
  var that = this;

  // Hey Jonas, can you double check that I'm not leaking because of the timeouts?
  function pulse() {
    that.runAllProvisionersOnce().then(function(x) {
      debug('Finished a provision pulse');
      if (!process.env.PROVISION_ONCE) {
        debug('Not doing another cycle because of env PROVISION_ONCE being set');
        setTimeout(pulse, that.pulseRate);
      }
      return x;
    }).done();
  }

  pulse();

};

/* This is the main entry point into the provisioning routines.  It will
 * return an array of promises with the outcome of provisioning */
Provisioner.prototype.runAllProvisionersOnce = function() {
  // We grab the pending task count here instead of in the provisionForType
  // method to avoid making a bunch of unneeded API calls

  var that = this;

  var pendingTasks;
  var workerTypes;
  var awsState;
  var runId = uuid.v4();
  var pricing;
  var wtRunIds = [];

  debug('%s Beginning provisioning run %s', this.provisionerId, runId);
  var p = Promise.all([
    this.Queue.pendingTaskCount(this.provisionerId),
    this.WorkerType.loadAll(),
    this.fetchAwsState()
  ]);

  p = p.then(function(res) {
    pendingTasks = res.shift();
    workerTypes = res.shift();
    awsState = res.shift();

    debug('%s AWS has instances of workerTypes: %s', runId, JSON.stringify(Object.keys(awsState)));
    // We could probably combine this with the .map of workerTypes below... meh...
    debug('%s WorkerType Definitions for %s', runId, JSON.stringify(workerTypes.map(function(x) {
      return x.workerType;
    })));

    return res;
  });

  p = p.then(function() {
    return Promise.all([
        that.fetchSpotPricingHistory(workerTypes),
        that.killOrphans(awsState, workerTypes),
    ]);
  });

  p = p.then(function(res) {
    pricing = res[0];
    debug('%s Fetched EC2 Pricing data', runId);
    debug('%s Killed these orphaned instances: %s', runId, res[1]);
    return; 
  });

  p = p.then(function() {
    return Promise.all(workerTypes.map(function(workerType) {
      var wtRunId = uuid.v4();
      wtRunIds.push(wtRunId);
      debug('%s[%s] == %s worker', runId, workerType.workerType, wtRunId);
      var pendingForWorker = pendingTasks[workerType.workerType] || 0;
      return that.provisionType(wtRunId, workerType, awsState, pricing, pendingForWorker);
    }));
  });

  p = p.then(function(res) {
    workerTypes.forEach(function(workerType, idx) {
      debug('%s Completed provisioning for worker type %s', wtRunIds[idx], workerType.workerType);
    });
    debug('%s Provisioning run completed', runId); 
    return res;
  });

  return p;
}

/* Figure out what the current state is for AWS ec2 for
   managed image types.  This returns an object in the form:
  {
    workerType1: {
      running: [<instance>, <instance>],
      pending: [<instance>],
      requested: [<spotrequeset>],
    }
    workerType2: ...
  }
*/
Provisioner.prototype.fetchAwsState = function() {
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
    var allState = {};
    that.allowedAwsRegions.forEach(function(region) {
      allState[region] = {};
      res[0][region].Reservations.forEach(function(reservation) {
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

      res[1][region].SpotInstanceRequests.forEach(function(request) {
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
  });

  return p;
}

/* When we find an EC2 instance or spot request that is for a workerType that we
 * don't know anything about, we will kill it.  NOTE: We currently do this as soon
 * as the workerType definition is not found, but we should probably do something
 * like wait for it to be gone for X hours before deleting it. */
Provisioner.prototype.killOrphans = function(awsState, workerTypes) {
  var that = this;

  var p = Promise.all(this.allowedAwsRegions.map(function(region) {
    return that.killOrphansInRegion(region, awsState[region], workerTypes);
  }));
  
  return p;

}

/* Go through each region's state, find and kill orphans */
Provisioner.prototype.killOrphansInRegion = function(awsRegion, awsRegionState, workerTypes) {
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
Provisioner.prototype.provisionType = function(wtRunId, workerType, awsState, pricing, pending) {
  var that = this;

  var capacity;
  var change;
  var spotBids;

  var p = Promise.all([
    this.countRunningCapacity(
      workerType,
      awsState,
      this.allowedAwsRegions,
      ['pending', 'running', 'requestedSpot']),
    this.assertKeyPair(workerType.workerType),
  ]);

  p = p.then(function (res) {
    debug('%s %s has %d existing capacity units and %d pending tasks',
      wtRunId, workerType.workerType, res[0], pending);
    capacity = res[0]; 
    return res;
  });

  p = p.then(function () {
    change = determineCapacityChange(workerType.scalingRatio, capacity, pending);
    if (capacity + change > workerType.maxCapacity) {
      debug('%s %s a change of %d would exceed max of %d', wtRunId,
          workerType.workerType, change, workerType.maxCapacity);
      change = capacity - workerType.maxCapacity;
    } else if (capacity + change < workerType.minCapacity) {
      debug('%s %s a change of %d would be less than min of %d', wtRunId,
          workerType.workerType, change, workerType.minCapacity);
      change = workerType.minCapacity - capacity;
    }
    debug('%s %s submitting request for %d more capacity units',
        wtRunId, workerType.workerType, change);
    return change;
  });

  p = p.then(function() {
    return that.determineSpotBids(workerType, awsState, pricing, change);  
  });

  p = p.then(function(_spotBids) {
    spotBids = _spotBids;
    return _spotBids;
  });

  p = p.then(function() {
    if (spotBids.length === 0) {
      debug('%s %s does not need more capacity', wtRunId, workerType.workerType);
    } else {
      spotBids.forEach(function(spotBid) {
        debug('%s %s submitting spot request at %d for type %s in region %s',
              wtRunId, workerType.workerType,
              spotBid.spotPrice, spotBid.instanceType, spotBid.region);
      });
    }
    return Promise.all(spotBids.map(function(spotBid) {
      return that.spawnInstance(wtRunId, workerType, spotBid.region, spotBid.instanceType, spotBid.spotPrice);
    }));
  });
  
  return p;
}

/* Check that we have a public key and create it if we don't */
Provisioner.prototype.assertKeyPair = function(workerTypeName) {
  /* This might be better to do in the provisionAll step once the 
     workertypes are loaded, then we can do a single key check per
     provisioning run */
  var that = this;
  var keyName = this.awsKeyPrefix + workerTypeName;

  var p = this.ec2.describeKeyPairs({
    Filters: [{
      Name: 'key-name',
      Values: [keyName]
    }] 
  });

  p = p.then(function(res) {
    var toCreate = [];

    that.allowedAwsRegions.forEach(function(region) {
      var matchingKey = res[region].KeyPairs[0];
      if (!matchingKey) {
        toCreate.push(that.ec2.importKeyPair.inRegion(region, {
          KeyName: keyName,
          PublicKeyMaterial: that.awsInstancePubKey,
        }));
      } 
    });
    return Promise.all(toCreate);
  });

  return p;
}


/* Fetch the last hour of EC2 pricing data.  For now, we'll
 * only fetch the first page of data, but in the future we will
 * make sure to use the nextToken to read the whole thing in
 */
Provisioner.prototype.fetchSpotPricingHistory = function(workerTypes) {
/*
   This promise is an object with a SpotInstances key that's a list of these:
   {
      InstanceType: 'r3.xlarge', 
      ProductDescription: 'Linux/UNIX', 
      SpotPrice: '0.042300', 
      Timestamp: Thu Feb 05 2015 14:23:31 GMT+0100 (CET), 
      AvailabilityZone: 'us-west-2c'
    }
*/
  var types = [];
  workerTypes.forEach(function(workerType) {
    var newTypes = Object.keys(workerType.types).filter(function(type) {
      return types.indexOf(type) === -1;
    });
    Array.prototype.push.apply(types, newTypes);
  });

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

  var p = this.ec2.describeSpotPriceHistory(requestObj); 

  p = p.then(function(pricing) {
    var regions = Object.keys(pricing);
    var fixed = {};
    // Get rid of the key we don't care about
    regions.forEach(function(region) {
      fixed[region] = pricing[region].SpotPriceHistory;
      if (fixed[region].length === 0) {
        throw new Error('Could not fetch pricing data for ' + region);
      }
    });

    return fixed;
  })

  return p;
};

/* Count the amount of capacity that's running or pending */
Provisioner.prototype.countRunningCapacity = function(workerType, awsState, regions, states) {
  var that = this;
  // For now, let's assume that an existing node is occupied
  return new Promise(function(resolve, reject) {
    var capacity = 0;

    /* Remember that the workerType.types is like this:
       { 
        'instance-type': {
          'capacity': 3,
          'utility': 4,
          'overwrites': {}
        }
       } */

    var capacities = {};
    var instances = [];

    Object.keys(workerType.types).forEach(function(type) {
      capacities[type] = workerType.types[type].capacity;   
    });

    that.allowedAwsRegions.forEach(function(region) {
      if (awsState[region][workerType.workerType]) {
        var wtsr = awsState[region][workerType.workerType];
        // We are including pending instances in this loop because we want to make
        // sure that they aren't ignored and duplicated
        if (states.indexOf('running') > 0 && wtsr.running) {
          Array.prototype.push.apply(instances, wtsr.running);
        }
        if (states.indexOf('pending') > 0 && awsState[region].pending) {
          Array.prototype.push.apply(instances, wtsr.pending);
        }
        if (states.indexOf('requestedSpot') > 0 && wtsr.requestedSpot) {
          Array.prototype.push.apply(instances, wtsr.requestedSpot);
        }
      }
    });

    instances.forEach(function(instance, idx, arr) {
      var potentialCapacity = capacities[instance.InstanceType];
      if (potentialCapacity) {
        capacity += capacities[instance.InstanceType];
      } else {
        /* Rather than assuming that an unknown instance type has no capacity, we'll
           assume the basic value (1) and move on.  Giving any other value would be
           a bad idea, 0 means that we would be scaling indefinately and >1 would be
           making assumptions which are not knowable */
        capacity++;
      }
    });

    resolve(capacity);
      
  });
}

/* Create Machines! */
Provisioner.prototype.spawnInstance = function(wtRunId, workerType, region, instanceType, spotPrice) {
  var that = this;
  var launchSpec;

  var p = that.createLaunchSpec(workerType, region, instanceType);

  p = p.then(function(_launchSpec) {
    debug('%s %s has a launch specification', wtRunId, workerType.workerType);
    //debug('Launch Spec: ' + JSON.stringify(_launchSpec));
    launchSpec = _launchSpec;
    return _launchSpec;
  });

  p = p.then(function() {
    debug('%s %s is creating spot request', wtRunId, workerType.workerType)
    return that.ec2.requestSpotInstances.inRegion(region, {
      InstanceCount: 1,
      Type: 'one-time',
      LaunchSpecification: launchSpec,
      SpotPrice: String(spotPrice).toString(),
    });
  });

  p = p.then(function(spotRequest) {
    // We only do InstanceCount == 1, so we'll hard code only caring about the first sir
    var sir = spotRequest.SpotInstanceRequests[0].SpotInstanceRequestId;
    debug('%s %s spot request %s submitted', wtRunId, workerType.workerType, sir);
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
Provisioner.prototype.determineSpotBids = function(workerType, awsState, pricing, change) {
  var that = this;
  return new Promise(function(resolve, reject) {

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
        var potentialSpotBid = that.findPriceForType(pricing, region, potentialType);
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

    resolve(spotBids);

  });
}

/* Given the pricing data, what's the average price for this instance type.
 * For now, we'll just pick the average of the most recent for each availability
 * zone.  In future we should do things like:
 *    - weight each AZ's price by how long it was the price
 *    - do other smart things
 */
Provisioner.prototype.findPriceForType = function(pricing, region, type) {
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
Provisioner.prototype.killExcess = function(workerType, awsState) {

  // We only want to kill running or pending instances when we're over capacity
  // because some of the oldest machines might end before spot requests are
  // fulfilled.  In that case, we don't want to cancel a spot request until
  // it's actually converted into an instance and is costing money
  var p = this.countRunningCapacity(workerType, awsState, this.allowedAwsRegions, ['running', 'pending']);

  p = p.then(function(capacity) {
    if (capacity < workerType.maxCapacity) {
      return 0;
    } else {
      return capacity - workerType.maxCapacity;
    }
  });

  p = p.then(function(deaths) {
    return destroyInstances(workerType, awsState, deaths); 
  });
  
  return p;
}

/* Destroy Machines! */
Provisioner.prototype.destroyInstances = function(workerType, awsState, capacityToKill) {
  var promises = [];
  var srToCancel = 0;
  if (awsState.requestedSpot && awsState.requestedSpot.length > 0) {
    srToCancel = capacityToKill - awsState.requestedSpot.length;
    srToCancel = srToCancel > 0 ? srToCancel : 0;
  }

  promises.push(this.ec2.CancelSpotInstanceRequests({
    SpotInstanceRequestId: awsState.requestedSpot.slice(0, srToCancel).map(function(x) {
      return x.SpotInstanceRequestId
    })
  }));

  var instancesToKill = capacityToKill - srToCancel;

  var instancesToKill = [].concat(awsState.pending).concat(awsState.running).slice(0, instancesToKill)

  promises.push(this.ec2.terminateInstances({
    InstanceIds: instancesToKill.map(function(x) {
      x.InstanceId;
    })
  }));

  return Promise.all(promises);
}

var validB64Regex = /^[A-Za-z0-9+/=]*$/;

/* Create a launch spec with values overwritten for a given aws instance type.
   the instanceTypeParam is the overwrites object from the allowedInstances
   workerType field */
Provisioner.prototype.createLaunchSpec = function(workerType, region, instanceType) {
  // These are the keys which are only applicable to a given region.
  // We're going to make sure that none are set in the generic launchSpec
  var regionSpecificKeys = ['ImageId'];
  var that = this;
  return new Promise(function(resolve, reject) {
    if (!workerType.types[instanceType]) {
      reject(new Error(util.format('%s only allows [%s] instances, not %s',
            workerType.workerType,
            Object.keys(workerType.types).join(', '),
            instanceType)));
    }
    var actual = lodash.clone(workerType.types[instanceType].overwrites);
    var newSpec = lodash.defaults(actual, workerType.launchSpecification);
    if (!validB64Regex.exec(newSpec.UserData)) {
      reject(new Error(util.format('Launch specification does not contain Base64: %s', newSpec.UserData)));
    }
    newSpec.KeyName = that.awsKeyPrefix + workerType.workerType;
    newSpec.InstanceType = instanceType;
    regionSpecificKeys.forEach(function(key) {
      newSpec[key] = workerType.regions[region].overwrites[key];
    });

    debug(newSpec);
    resolve(newSpec);
  });
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
