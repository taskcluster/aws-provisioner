let log = require('./log');
let debug = log.debugCompat('aws-provisioner:aws-manager');
let assert = require('assert');
//let objFilter = require('../lib/objFilter');
let shuffle = require('knuth-shuffle');
let taskcluster = require('taskcluster-client');
let series = require('./influx-series');
let keyPairs = require('./key-pairs');
let _ = require('lodash');
let delayer = require('./delayer');

const MAX_ITERATIONS_FOR_STATE_RESOLUTION = 20;

function dateForInflux(thingy) {
  if (typeof thingy === 'object' && thingy.getTime) {
    // assume this is a date object
    return thingy.getTime();
  } else if (typeof thingy === 'string') {
    return new Date(thingy).getTime();
  }
  throw new Error('dont know how to thing this thingy');
}

/**
 * The AWS Manager is an object which tracks the state of the EC2 nodes,
 * pricing and other aspects of interfacing with AWS's ec2 api.  Instances of
 * this defer to responses of the EC2 API where appropriate.  There are cases
 * where state sometimes needs to be maintained inside of the AWS Manager
 * itself.  This is related to the evenutally consistent design of the EC2 api.
 *
 * Key to understanding how this class works is understanding the different
 * states defined:
 *
 * running:
 *      These are instances which are doing work.  They are booted, they are
 *      configured and they have requested their provisioner secrets.
 * pending:
 *      These are fulfilled spot requests which are either in the process of
 *      being booted up or are doing their internal setup.  They have not yet
 *      fetched their provisioner secrets
 * requested:
 *      These are spot requests which have been made but have not yet been
 *      fulfilled by amazon and so are not even machines yet
 * internallyTracked:
 *      These are spot instances which have been made but have not yet shown up
 *      in the EC2 describeSpotRequests method.  The reason for this is that
 *      the EC2 API is eventually consistant.  We've seen requets live in this
 *      state for 20+ minutes sometimes, and even turn into running instances
 *      before the api returns them in the describe* api calls.  We track these
 *      ourselves because if we didn't, we could get into a state of constantly
 *      submitting requests, forgetting about those requests then over
 *      provisioning.
 *
 * Where possible, objects from the EC2 API are kept in as close shape and
 * meaning to the EC2 api.  This is done to make it easier to reason with the
 * objects and to allow for comparison to the EC2 API docs.
 *
 * Constructor arguments:
 * ec2:
 *      This is a object which maps EC2 regions (e.g. us-west-1) to instances
 *      of the aws-sdk-promise library for the corresponding region.
 * provisionerId:
 *      This is the id of this provisioner (e.g. aws-provisioner-v1').  This
 *      value is passed through to the Queue verbatim and is used to find the
 *      number of pending tasks for a given provisionerId/workerType combo
 * keyPrefix:
 *      We use a prefix on KeyPair.Name for a given instance to store metadata.
 *      The EC2 api provides for metadata to be stored in Tags, but tags are
 *      not able to be set at the time a spot request is requested.  We use
 *      this as a workaround.  This is currently the name of the worker type
 *      the instances/request is associated with as well as a hash of the ssh
 *      KeyPair key material so that we can upgrade ssh keys.
 * pubKey:
 *      public key data to be stored as the KeyPair data.  We use a single
 *      public key for all instances.  Ideally in the future we would actually
 *      use a public key that no one has the matching private key for so that
 *      we effectively disable ssh access to our machines.
 * maxInstanceLife:
 *      absolute upper bounds of instance life.  This should never be hit, but
 *      is rather a safety limit to ensure we don't have things living forever.
 * influx:
 *      Instance of a taskcluster-base.stats.Influx class which is used to
 *      submit data points to an influx instance
 */
class AwsManager {
  constructor(ec2, provisionerId, keyPrefix, pubKey, maxInstanceLife, influx) {
    assert(ec2);
    assert(provisionerId);
    assert(keyPrefix);
    assert(pubKey);
    assert(maxInstanceLife);
    assert(influx);

    this.ec2 = ec2;
    this.provisionerId = provisionerId;
    this.keyPrefix = keyPrefix;
    this.pubKey = pubKey;
    this.maxInstanceLife = maxInstanceLife;
    this.influx = influx;

    // Known keypairs are tracked so that we don't have to retreive the list of
    // all known key pairs on every iteration.
    this.__knownKeyPairs = [];

    // The responses of the EC2 Api's view of state
    this.__apiState = {
      instances: [],
      requests: [],
    };

    // We store the state of the previous iteration so that we can do
    // comparisons to see which instances have changed state
    this.__previousApiState = this.__apiState;

    // Internal state is state which we know exists but has not yet been
    // reflected in the EC2 api.  This list is used to track the spot requests
    // which we have submitted but which do not yet show up in the ec2 api
    // calls which list the spot requests
    this.__internalState = [];

    // This is used to store the list of instances we're awaiting state change
    // reasons for
    this.__awaitingStateReason = [];

    // This is used to store the spot requests which are pending their state
    // changing to fulfilled
    this.__awaitingSpotFulfilmentStatus = [];

    // Store the available availability zone
    this.__availableAZ = {};

    // Set up influxdb reporters
    this.reportEc2ApiLag = series.ec2ApiLag.reporter(influx);
    this.reportSpotRequestsSubmitted = series.spotRequestsSubmitted.reporter(influx);
    this.reportSpotRequestsFulfilled = series.spotRequestsFulfilled.reporter(influx);
    this.reportSpotRequestsDied = series.spotRequestsDied.reporter(influx);
    this.reportInstanceTerminated = series.instanceTerminated.reporter(influx);
    this.reportSpotPriceFloorFound = series.spotPriceFloorFound.reporter(influx);
    this.reportAmiUsage = series.amiUsage.reporter(influx);
  }

  /**
   * Update the state from the AWS API
   */
  async update() {
    // We fetch the living instance and spot requests separate from the dead
    // ones to make things a little easier to work with as there's really very
    // little in the provisioner which requires info on dead instances and spot
    // requests
    //
    // The choice in which bucket each instance or request should belong in
    // comes down to whether or not the resource is awaiting or currently
    // working or needs to be tidied up after

    // We want to fetch the last 30 minutes of pricing data
    let pricingStartDate = new Date();
    pricingStartDate.setMinutes(pricingStartDate.getMinutes() - 30);

    // Remember that we keep the previous iteration's state for comparison
    // purposes
    this.__previousApiState = this.__apiState;

    // We always start with clean state because it's easier and safer than
    // trying to modify the existing state object to reflect the api responses
    let apiState = {
      instances: [],
      requests: [],
    };

    // We store the dead state on its own only to avoid having to rewrite a
    // bunch of functions which we use on both dead and live state
    let deadState = {
      instances: [],
      requests: [],
    };

    let stalledKills = [];
    let availableAZ = {};
    let allPricingHistory = {};

    // It would be better to do it by classification than by region for
    // better concurrency, but this is easier and not too slow considering
    // the 75s iteration frequency
    debug('updating aws state for all regions');
    // We had an issue where the EC2 api would freeze up on these api calls and
    // would never reject or resolve.  That's why we now race a 240s timeout
    // and reject this promise if the state calls take longer than 240s
    await Promise.race([
      delayer(240 * 1000)().then(() => {
        throw new Error('Timeout while updating AWS Api State');
      }),
      Promise.all(_.map(this.ec2, async (ec2, region) => {
        debug('running aws state promises in %s', region);
        let response = await Promise.all([
          // Living instances
          ec2.describeInstances({
            Filters: [
              {
                Name: 'key-name',
                Values: [this.keyPrefix + '*'],
              },
              {
                Name: 'instance-state-name',
                Values: ['running', 'pending'],
              },
            ],
          }).promise(),
          // Living spot requests
          ec2.describeSpotInstanceRequests({
            Filters: [
              {
                Name: 'launch.key-name',
                Values: [this.keyPrefix + '*'],
              }, {
                Name: 'state',
                Values: ['open'],
              },
            ],
          }).promise(),
          // Dead instances
          ec2.describeInstances({
            Filters: [
              {
                Name: 'key-name',
                Values: [this.keyPrefix + '*'],
              },
              {
                Name: 'instance-state-name',
                Values: ['shutting-down', 'terminated', 'stopping'],
              },
            ],
          }).promise(),
          // Dead spot requests
          ec2.describeSpotInstanceRequests({
            Filters: [
              {
                Name: 'launch.key-name',
                Values: [this.keyPrefix + '*'],
              }, {
                Name: 'state',
                Values: ['cancelled', 'failed', 'closed', 'active'],
              },
            ],
          }).promise(),
          // Available availability zones
          ec2.describeAvailabilityZones({
            Filters: [
              {
                Name: 'state',
                Values: ['available'],
              },
            ],
          }).promise(),
          // Raw pricing data
          ec2.describeSpotPriceHistory({
            StartTime: pricingStartDate,
            Filters: [
              {
                Name: 'product-description',
                Values: ['Linux/UNIX'],
              },
            ],
          }).promise(),
        ]);
        debug('ran aws state promises in %s', region);

        // Now let's classify them
        for (let reservation of response[0].data.Reservations) {
          for (let instance of reservation.Instances) {
            let workerType = this.parseKeyPairName(instance.KeyName).workerType;
            // Maybe use objFilter here
            let filtered = instance;
            filtered.Region = region;
            filtered.WorkerType = workerType;
            apiState.instances.push(filtered);
          }
        };

        // Stalled requests are those which have taken way too long to be
        // fulfilled.  We'll consider them dead after a certain amount of time
        // and make new requests for their pending tasks
        let stalledSRIds = [];
        for (let request of response[1].data.SpotInstanceRequests) {
          let workerType = this.parseKeyPairName(request.LaunchSpecification.KeyName).workerType;
          let filtered = request;
          filtered.Region = region;
          filtered.WorkerType = workerType;
          if (this._spotRequestStalled(filtered)) {
            stalledSRIds.push(filtered.SpotInstanceRequestId);
          } else {
            apiState.requests.push(filtered);
          }
        }

        // Submit request to kill stalled requests
        debug('killing stalled instances and spot requests in %s', region);
        await this.killCancel(region, [], stalledSRIds);
        debug('killed stalled instances and spot requests in %s', region);

        // Put the dead instances into the dead state object
        for (let reservation of response[2].data.Reservations) {
          for (let instance of reservation.Instances) {
            let workerType = this.parseKeyPairName(instance.KeyName).workerType;
            // Maybe use objFilter here
            let filtered = instance;
            filtered.Region = region;
            filtered.WorkerType = workerType;
            deadState.instances.push(filtered);
          }
        };
        debug('put dead state instances into deadState variable in %s', region);

        // Put the dead requests into the dead state object
        let deadSpotRequests = [];
        for (let request of response[3].data.SpotInstanceRequests) {
          let workerType = this.parseKeyPairName(request.LaunchSpecification.KeyName).workerType;
          // Maybe use objFilter here
          let filtered = request;
          filtered.Region = region;
          filtered.WorkerType = workerType;
          deadState.requests.push(filtered);
        }
        debug('put dead state requests into deadState variable in %s', region);

        // Find all the available availability zones
        debug('categorizing availability zones in %s', region);
        availableAZ[region] = response[4].data.AvailabilityZones.map(x => x.ZoneName);
        debug('categorized availability zones in %s', region);

        // Find the max prices
        debug('finding max prices in %s', region);
        allPricingHistory[region] = this._findMaxPrices(response[5].data, availableAZ[region]);
        debug('found max prices in %s', region);
      })),
    ]);
    debug('updated aws state for all regions');

    // Assign all of the new state objects to the properties of this aws manager
    this.__availableAZ = availableAZ;
    this.__pricing = allPricingHistory;
    this.__apiState = apiState;
    this.__deadState = deadState;

    // Figure out what's changed between this and the last iteration
    let stateDifferences = this._compareStates(this.__apiState, this.__previousApiState, this.__deadState);
    this._reconcileStateDifferences(stateDifferences, this.__deadState, this.__apiState);

    // We want to make sure that our internal state is always up to date when
    // we fetch the updated state
    this._reconcileInternalState();
  }

  /**
   * Return an object that maps region names to a list of availability zones
   * which are able to be provisioned in
   */
  availableAZ() {
    return this.__availableAZ;
  }

  /**
   * Find the maximum price for each instance type in each availabilty zone.
   * We find the maximum, not average price intentionally as the average is a
   * poor metric in this case from experience
   */
  _findMaxPrices(res, zones) {
    // type -> zone
    let pricing = {};

    for (let pricePoint of res.SpotPriceHistory) {
      let type = pricePoint.InstanceType;
      let price = parseFloat(pricePoint.SpotPrice, 10);
      let zone = pricePoint.AvailabilityZone;

      // Remember that we only want to consider available zones
      if (_.includes(zones, zone)) {
        if (!pricing[type]) {
          pricing[type] = {};
        }
        if (!pricing[type][zone] || pricing[type][zone] < price) {
          pricing[type][zone] = price;
        }
      }
    }

    return pricing;
  }

  /**
   * We want to separate spot requests into two buckets:
   *   - those which are going to be fulfilled quickly
   *   - those which should be canceled because of AWS
   * This function returns an object with the spot requests sorted
   * into these buckets.
   */
  _spotRequestStalled(sr) {
    let now = new Date();

    // These are states which have a state of 'open' but which are likely not
    // to be fulfilled expeditiously
    // TODO: Ugh, this should not be redeclared each loop.
    let stalledStates = [
      'capacity-not-available',
      'capacity-oversubscribed',
      'price-too-low',
      'not-scheduled-yet',
      'launch-group-constraint',
      'az-group-constraint',
      'placement-group-constraint',
      'constraint-not-fulfillable ',
    ];

    let killWhen = new Date(sr.CreateTime);
    killWhen.setMinutes(killWhen.getMinutes() + 20);

    if (killWhen < now) {
      debug(`killing spot request ${sr.SpotInstanceRequestId}, not fulfilled in 20 minutes`);
      return true;
    }

    // We've found a spot price floor
    if (sr.Status.Code === 'price-too-low') {
      debug('found a canceled spot request, submitting pricing floor');
      this.reportSpotPriceFloorFound({
        region: sr.Region,
        az: sr.LaunchSpecification.Placement.AvailabilityZone,
        instanceType: sr.LaunchSpecification.InstanceType,
        time: dateForInflux(new Date()),
        price: parseFloat(sr.SpotPrice, 10),
        reason: 'spot-request-price-too-low',
      });
    }

    if (_.includes(stalledStates, sr.Status.Code)) {
      debug('spot request %s stalled, bad state %s', sr.SpotInstanceRequestId, sr.Status.Code);
      return true;
    } else {
      return false;
    }
  }

  /**
   * Compare two state objects to find the instances and requests which are no
   * longer in the new state object.  The assumption here is that the items
   * that are no longer in the state are those which have been terminated.
   * This method returns those instances and request which are no longer
   * present in state.  You'll need to have another data source to find the
   * resolution of the now missing resources, which is why the dead state is
   * provided
   */
  _compareStates(newState, previousState, deadState) {
    assert(newState);
    assert(previousState);
    assert(deadState);

    let missingIds = {
      instances: [],
      requests: [],
    };

    // to make comparison of states easier, we create a list of all the ids of
    // both spot requests and instances in each of the two compared states
    let allInstancesInPreviousState = previousState.instances.map(i => i.InstanceId);
    let allRequestsInPreviousState = previousState.requests.map(r => r.SpotInstanceRequestId);
    let allInstancesInNewState = newState.instances.map(i => i.InstanceId);
    let allRequestsInNewState = newState.requests.map(r => r.SpotInstanceRequestId);

    // find all the instances and request ids which were in the previous state
    // but not in the new state
    missingIds.instances = allInstancesInPreviousState.filter(id => {
      return !_.includes(allInstancesInNewState, id);
    });
    missingIds.requests = allRequestsInPreviousState.filter(id => {
      return !_.includes(allRequestsInNewState, id);
    });

    // Now let's grab those instances and requests which are absent, but instead
    // let's use their new state object instead of the old one.  This is to avoid
    // the problem of getting the stale state info in the later methods which
    // need information about why the state change occured
    return {
      instances: deadState.instances.filter(instance => {
        return _.includes(missingIds.instances, instance.InstanceId);
      }),
      requests: deadState.requests.filter(request => {
        return _.includes(missingIds.requests, request.SpotInstanceRequestId);
      }),
    };
  }

  /**
   * Take a list of instances which are now absent and figure out why they are gone.
   * This will submit Influx points.  Differences are those objects which no longer
   * show up in the 'live' set of ec2 queries, instead show
   *
   * Remember that we're only looking at the differences between iteration intervals.
   * This is how we ensure that we don't look the same spot request twice.
   */
  _reconcileStateDifferences(differences, deadState, apiState) {
    assert(differences);
    assert(deadState);
    assert(apiState);

    let plotSpotFulfilment = (request) => {
      // Once we go from open -> active with a status of fulfilled we can log this
      // spot request as successfully fulfilled.  This does not imply that
      this.reportSpotRequestsFulfilled({
        provisionerId: this.provisionerId,
        region: request.Region,
        az: request.LaunchSpecification.Placement.AvailabilityZone,
        instanceType: request.LaunchSpecification.InstanceType,
        workerType: request.WorkerType,
        id: request.SpotInstanceRequestId,
        instanceId: request.InstanceId,
        time: dateForInflux(request.Status.UpdateTime),
      });
      debug('spot request %j fulfilled!', request);
    };

    // We want to figure out what happened to each of the spot requests which are
    // no longer showing up as pending.  These can either be fulfilled or
    // rejected.  FOr those which are fulfilled we want to create a data point
    // which will let us trend how long spot request fulfilment takes.  For those
    // which fail we want stats on why they failed so we can later analyze this
    for (let request of differences.requests) {
      if (request.State === 'active' && request.Status.Code === 'fulfilled') {
        plotSpotFulfilment(request);
      } else if (request.State === 'open') {
        // Here we have those spot requests which are no longer unfulfilled but
        // do not have an api state which reflects that
        this.__awaitingSpotFulfilmentStatus.push({
          id: request.SpotInstanceRequestId,
          time: new Date(),
          iterationCount: 0,
        });
      } else {
        // I wonder if we should be reporting spot requests which failed because
        // of bid amount here in their own special series for use in trying to
        // figure out what to bid.  We could use refused spot bids as a lower
        // limit for bids
        this.reportSpotRequestsDied({
          provisionerId: this.provisionerId,
          region: request.Region,
          az: request.LaunchSpecification.Placement.AvailabilityZone,
          instanceType: request.LaunchSpecification.InstanceType,
          workerType: request.WorkerType,
          id: request.SpotInstanceRequestId,
          time: dateForInflux(request.Status.UpdateTime),
          bid: parseFloat(request.SpotPrice, 10),
          state: request.State,
          statusCode: request.Status.Code,
          statusMsg: request.Status.Message,
        });
        debug('spot request %j did something else', request);
      }
    }

    this.__awaitingSpotFulfilmentStatus = this.__awaitingSpotFulfilmentStatus.filter(requestAwaiting => {
      let keepInTheList = true;

      for (let requestMightHave of deadState.requests) {
        if (requestMightHave.SpotInstanceRequestId === requestAwaiting) {
          if (requestMightHave.State === 'active' && requestMightHave.Status.Code === 'fulfilled') {
            plotSpotFulfilment(requestMightHave);
            keepInTheList = false;
          }
        }
      }

      if (requestAwaiting.iterationCount++ > MAX_ITERATIONS_FOR_STATE_RESOLUTION) {
        debug('dropping spot request on the floor');
        keepInTheList = false;
      }

      return keepInTheList;
    });

    /*
      for instances we need to see if there's a transition reason already and if not,
      we need to store the instance metadata and check on the next iteration whether
      that instance has an associated state transition reason.  For when there is a
      spot price termination, we should also look for a spot request in the good and
      dead ones to see what we bid on the thing.  We should also track what the time
      was when we found the difference and we should only try for up to, say, 5 times
      before we give up on trying to figure out why the instance terminated.

      http://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_StateReason.html
    */

    let plotInstanceDeath = (instance, time) => {
      // Let's track when the instance is shut down
      this.reportInstanceTerminated({
        provisionerId: this.provisionerId,
        region: instance.Region,
        az: instance.Placement.AvailabilityZone,
        instanceType: instance.InstanceType,
        workerType: instance.WorkerType,
        id: instance.InstanceId,
        spotRequestId: instance.SpotInstanceRequestId,
        time: dateForInflux(time),
        launchTime: dateForInflux(instance.LaunchTime),
        stateCode: instance.State.Code,
        stateMsg: instance.State.Name,
        stateChangeCode: instance.StateReason.Code,
        stateChangeMsg: instance.StateReason.Message,
      });

      if (instance.StateReason.Code === 'Server.SpotInstanceTermination') {
        debug('We have a spot price floor!');
        // Let's figure out what we set the price to;
        let price;

        for (let request of deadState.requests) {
          if (!price && request.SpotInstanceRequestId === instance.SpotInstanceRequestId) {
            price = parseFloat(request.SpotPrice, 10);
          }
        }

        for (let request of apiState.requests) {
          if (!price && request.SpotInstanceRequestId === instance.SpotInstanceRequestId) {
            price = parseFloat(request.SpotPrice, 10);
          }
        }

        if (price) {
          this.reportSpotPriceFloorFound({
            region: instance.Region,
            az: instance.Placement.AvailabilityZone,
            instanceType: instance.InstanceType,
            time: dateForInflux(new Date()),
            price: price,
            reason: 'instance-spot-killed',
          });
        } else {
          debug('Could not find a price for a spot-price killed instance');
        }
      }
    };

    // Let's handle instance which already have a state reason, or
    // save them for a future iteration if not
    for (let instance of differences.instances) {
      // Using StateReason instead of StateTransitionReason
      if (instance.StateReason && instance.StateReason.Code) {
        debug('found a terminated instance which has a termination reason');
        plotInstanceDeath(instance, new Date().toISOString());
      } else {
        debug('found a terminated instance which awaits a termination reason');
        this.__awaitingStateReason.push({
          id: instance.InstanceId,
          time: new Date().toISOString(),
          iterationCount: 0,
        });
      }
    }

    // Now, let's try to account for those instance which are awaiting a state reason
    this.__awaitingStateReason = this.__awaitingStateReason.filter(instanceAwaiting => {
      let keepItInTheList = true;
      for (let instanceMightHave of deadState.instances) {
        if (instanceMightHave.InstanceId === instanceAwaiting.id) {
          if (instanceMightHave.StateReason && instanceMightHave.StateReason.Code) {
            keepItInTheList = false;
            // Notice how we're plotting the newly fetched instance since it's
            // the one that's going to have the StateReason
            debug('found an instance awaiting reason to plot');
            plotInstanceDeath(instanceMightHave, instanceAwaiting.time);
          }
        }
      }

      // We don't want to track this stuff forever!
      if (instanceAwaiting.iterationCount++ > MAX_ITERATIONS_FOR_STATE_RESOLUTION) {
        keepItInTheList = false;
        debug('exceeded the number of iterations awaiting reason');
      }

      return keepItInTheList;
    });
  }

  /** Return a list of all Instances for a region */
  instancesInRegion(region) {
    if (typeof region === 'string') {
      region = [region];
    }
    return this.__apiState.instances.filter(instance => {
      return _.includes(region, instance.Region);
    });
  }

  /** Return a list of all SpotRequests for a region */
  requestsInRegion(region) {
    if (typeof region === 'string') {
      region = [region];
    }
    return this.__apiState.requests.filter(request => {
      return _.includes(region, request.Region);
    });
  }

  /** Return a list of all Instances for a workerType */
  instancesOfType(workerType) {
    if (typeof workerType === 'string') {
      workerType = [workerType];
    }
    return this.__apiState.instances.filter(instance => {
      return _.includes(workerType, instance.WorkerType);
    });
  }

  /** Return a list of all SpotRequests for a workerType */
  requestsOfType(workerType) {
    if (typeof workerType === 'string') {
      workerType = [workerType];
    }
    return this.__apiState.requests.filter(request => {
      return _.includes(workerType, request.WorkerType);
    });
  }

  instancesOfTypeInRegion(region, workerType) {
    if (typeof workerType === 'string') {
      workerType = [workerType];
    }
    if (typeof region === 'string') {
      region = [region];
    }
    return this.__apiState.instances.filter(instance => {
      return _.includes(region, instance.Region) && _.includes(workerType, instance.WorkerType);
    });

  }

  requestsOfTypeInRegion(region, workerType) {
    if (typeof workerType === 'string') {
      workerType = [workerType];
    }
    if (typeof region === 'string') {
      region = [region];
    }
    return this.__apiState.requests.filter(request => {
      return _.includes(region, request.Region) && _.includes(workerType, request.WorkerType);
    });

  }

  /**
   * List all the workerTypes known in EC2 state
   */
  knownWorkerTypes() {
    let workerTypes = [];

    for (let instance of this.__apiState.instances) {
      if (!_.includes(workerTypes, instance.WorkerType)) {
        workerTypes.push(instance.WorkerType);
      }
    }

    for (let request of this.__apiState.requests) {
      if (!_.includes(workerTypes, request.WorkerType)) {
        workerTypes.push(request.WorkerType);
      }
    }

    for (let sr of this.__internalState) {
      if (!_.includes(workerTypes, sr.request.WorkerType)) {
        workerTypes.push(sr.request.WorkerType);
      }
    }

    return workerTypes;
  }

  /**
   * Count the capacity of this workerType that are in the states specified
   * by `states`.  Doing this uses the Capacity key from the workerType's
   * types dictionary.  Remember that capacity is the number of tasks
   * that this instance/request will be able to service.
   * If specified, `extraSpotRequests` is a dictionary which contains a region
   * and worker type categorized list of outstanding spot requests
   */
  capacityForType(workerType, states) {
    assert(workerType);
    if (!states) {
      states = ['running', 'pending', 'spotReq'];
    }
    let capacity = 0;
    let instances = this.instancesOfType(workerType.workerType);
    let requests = this.requestsOfType(workerType.workerType);

    for (let instance of instances) {
      if (_.includes(states, instance.State.Name)) {
        try {
          capacity += workerType.capacityOfType(instance.InstanceType);
        } catch (err) {
          capacity++;
        }
      }
    }

    for (let request of requests) {
      if (_.includes(states, 'spotReq')) {
        try {
          capacity += workerType.capacityOfType(request.InstanceType);
        } catch (err) {
          capacity++;
        }
      }
    }

    for (let sr of this.__internalState) {
      if (_.includes(states, 'spotReq')) {
        try {
          capacity += workerType.capacityOfType(sr.request.InstanceType);
        } catch (err) {
          capacity++;
        }
      }
    }

    return capacity;

  }

  /**
   * Ensure (but only at best effort) that all provisioner owned resources
   * are tagged with appropriate tags.  These can be used by others to
   * get detailed pricing data, but they are not, nor should be, used by
   * the provisioner internally
   */
  async ensureTags() {
    let missingTags = (obj) => {
      let hasTag = false;
      if (obj.Tags) {
        for (let tag of obj.Tags) {
          if (tag.Key === 'Owner' && tag.Value === this.provisionerId) {
            hasTag = true;
          }
        }
      }
      return !hasTag;
    };

    let instanceWithoutTags = this.__apiState.instances.filter(missingTags);
    let requestsWithoutTags = this.__apiState.requests.filter(missingTags);

    let tags = {};

    let x = (y, id) => {
      if (!tags[y.Region]) {
        tags[y.Region] = {};
      }

      if (!tags[y.Region][y.WorkerType]) {
        tags[y.Region][y.WorkerType] = {
          data: [
            {Key: 'Name', Value: y.WorkerType},
            {Key: 'Owner', Value: this.provisionerId},
            {Key: 'WorkerType', Value: this.provisionerId + '/' + y.WorkerType},
          ],
          ids: [id],
        };
      } else {
        tags[y.Region][y.WorkerType].ids.push(id);
      }
    };

    for (let i of instanceWithoutTags) {
      x(i, i.InstanceId);
    }

    for (let r of requestsWithoutTags) {
      x(r, r.SpotInstanceRequestId);
    }

    let tagPromises = [];
    for (let region of Object.keys(tags)) {
      for (let workerType of Object.keys(tags[region])) {
        tagPromises.push(this.ec2[region].createTags({
          Tags: tags[region][workerType].data,
          Resources: tags[region][workerType].ids,
        }).promise());
      }
    }

    await Promise.all(tagPromises);
  }

  /**
   * List every known spot instance request id known to the AWS
   * state.
   */
  knownSpotInstanceRequestIds() {
    // We need to know all the SpotInstanceRequestIds which are known
    // to aws state.  This is mostly just the id from the requests
    let allKnownSrIds = this.__apiState.requests.map(r => r.SpotInstanceRequestId);

    // We also want to make sure that the Spot Request isn't in any
    // instance's object
    for (let instance of this.__apiState.instances) {
      let sird = instance.SpotInstanceRequestId;
      if (sird && !_.includes(allKnownSrIds, sird)) {
        allKnownSrIds.push(sird);
      }
    }

    return allKnownSrIds;
  }

  /**
   * Because the AWS is eventually consistent, it will sometimes take time for
   * spot requests to show up in the describeSpotInstanceRequests calls for AWS
   * state.  We will maintain an internal table of these submitted but not yet
   * visible spot requests so that we can offset the count of a given instance
   * type for figuring out running capacity.  If the provisioning process is
   * restarted before the spot request shows up in the api's state we will lose
   * track of it until it turns into an instance.
   */
  _trackNewSpotRequest(sr) {
    // sr is a SpotRequest object which we get back from the
    // AWS Api when we submit the SpotRequest
    assert(sr);

    let allKnownSrIds = this.knownSpotInstanceRequestIds();

    if (!_.includes(allKnownSrIds, sr.request.SpotInstanceRequestId)) {
      // XXX let filtered = objFilter(sr.request, this.filters.spotReq);
      let filtered = sr.request;
      sr.request = filtered;
      sr.request.Region = sr.bid.region;
      sr.request.WorkerType = sr.workerType;
      this.__internalState.push(sr);
    }

  }

  /**
   * Once a SpotRequest shows up in the state returned from the AWS api we
   * should remove it from the internal state of spot requests that is needed.
   * We do this before running the provisioner of each workerType to avoid
   * double counting a newly discovered spot request
   */
  _reconcileInternalState() {
    // Remove the SRs which AWS now tracks from internal state

    // TODO: This stuff is broken right now
    let now = new Date();

    // We need to know all the SpotInstanceRequestIds which are known
    // to aws state.  This is mostly just the id from the requests
    let allKnownSrIds = this.knownSpotInstanceRequestIds();

    this.__internalState = this.__internalState.filter(request => {
      // We want to print out some info!
      if (_.includes(allKnownSrIds, request.request.SpotInstanceRequestId)) {
        // Now that it's shown up, we'll remove it from the internal state
        debug('Spot request %s for %s/%s/%s took %d seconds to show up in API',
              request.request.SpotInstanceRequestId, request.request.Region,
              request.request.LaunchSpecification.Placement.AvailabilityZone,
              request.request.LaunchSpecification.InstanceType,
              (now - request.submitted) / 1000);
        this.reportEc2ApiLag({
          provisionerId: this.provisionerId,
          region: request.request.Region,
          az: request.request.LaunchSpecification.Placement.AvailabilityZone,
          instanceType: request.request.LaunchSpecification.InstanceType,
          workerType: request.request.WorkerType,
          id: request.request.SpotInstanceRequestId,
          didShow: 0,
          lag: (now - request.submitted) / 1000,
        });
        return false;
      } else {
        debug('Spot request %s for %s/%s/%s still not in api after %d seconds',
              request.request.SpotInstanceRequestId, request.request.Region,
              request.request.LaunchSpecification.Placement.AvailabilityZone,
              request.request.LaunchSpecification.InstanceType,
              (now - request.submitted) / 1000);
        // We want to track spot requests which aren't in the API yet for a
        // maximum of 15 minutes.  Any longer and we'd risk tracking these
        // forever, which could bog down the system

        if (now - request.submitted >= 15 * 60 * 1000) {
          this.reportEc2ApiLag({
            provisionerId: this.provisionerId,
            region: request.request.Region,
            az: request.request.LaunchSpecification.Placement.AvailabilityZone,
            instanceType: request.request.LaunchSpecification.InstanceType,
            workerType: request.request.WorkerType,
            id: request.request.SpotInstanceRequestId,
            didShow: 1,
            lag: (now - request.submitted) / 1000,
          });
          return false;
        } else {
          return true;
        }
      }
    });
  }

  /**
   * Create an instance of a WorkerType and track it.  Internally, we will
   * track the outstanding spot requests until they are seen in the EC2 API.
   * This makes sure that we don't ignroe spot requests that we've made but not
   * yet seen.  This avoids run-away provisioning
   */
  async requestSpotInstance(launchInfo, bid) {
    assert(bid, 'Must specify a spot bid');
    assert(typeof bid.price === 'number', 'Spot Price must be number');

    assert(_.includes(_.keys(this.ec2), bid.region),
        'will not submit spot request in unconfigured region');

    assert(_.includes(this.__availableAZ[bid.region], bid.zone),
        'will not submit spot request in an unavailable az');

    // We should monitor logs for something like this pattern:
    // "The image id '[ami-33333333]' does not exist"
    let spotRequest;

    debug('requesting spot instance');
    spotRequest = await this.ec2[bid.region].requestSpotInstances({
      InstanceCount: 1,
      Type: 'one-time',
      LaunchSpecification: launchInfo.launchSpec,
      SpotPrice: bid.price.toString(),
    }).promise();
    debug('requested spot instance');

    let spotReq = spotRequest.data.SpotInstanceRequests[0];

    debug('submitted spot request %s for $%d for %s in %s/%s for %s',
      spotReq.SpotInstanceRequestId, bid.price, launchInfo.workerType, bid.region, bid.zone, bid.type);
    debug('Used this userdata: %j', launchInfo.userData);

    let info = {
      workerType: launchInfo.workerType,
      request: spotReq,
      bid: bid,
      submitted: new Date(),
    };

    this.reportSpotRequestsSubmitted({
      provisionerId: this.provisionerId,
      region: info.bid.region,
      az: info.bid.zone,
      instanceType: info.bid.type,
      workerType: info.workerType,
      id: info.request.SpotInstanceRequestId,
      bid: bid.price,
      price: bid.truePrice,  // ugh, naming!
      bias: bid.bias,
    });

    this.reportAmiUsage({
      provisionerId: this.provisionerId,
      ami: launchInfo.launchSpec.ImageId,
      region: info.bid.region,
      az: info.bid.zone,
      instanceType: info.bid.type,
      workerType: info.workerType,
    });

    this._trackNewSpotRequest(info);
    return info;
  }

  /**
   * wrapper for brevity
   */
  createPubKeyHash() {
    return keyPairs.createPubKeyHash(this.pubKey);
  }

  /**
   * wrapper for brevity
   */
  createKeyPairName(workerName) {
    return keyPairs.createKeyPairName(this.keyPrefix, this.pubKey, workerName);
  }

  /**
   * wrapper for brevity
   */
  parseKeyPairName(name) {
    return keyPairs.parseKeyPairName(name);
  }

  /**
   * We use KeyPair names to determine ownership and workerType in the EC2
   * world because we can't tag SpotRequests until they've mutated into
   * Instances.  This sucks and all, but hey, what else can we do?  This method
   * checks which regions have the required KeyPair already and creates the
   * KeyPair in regions which do not already have it.  Note that the
   * __knownKeyPair cache should never become shared, since we rely on it not
   * surviving restarts in the case that we start running this manager in
   * another region.  If we didn't dump the cache, we could create the key in
   * one region but not the new one that we add.  TODO: Look into what happens
   * when we add a region to the list of allowed regions... I suspect that
   * we'll end up having to track which regions the workerName is enabled in.
   */
  async createKeyPair(workerName) {
    assert(workerName);

    let keyName = this.createKeyPairName(workerName);

    if (_.includes(this.__knownKeyPairs, keyName)) {
      // Short circuit checking for a key but return
      // a promise so this cache is invisible to the
      // calling function from a non-cached instance
      return;
    }

    await Promise.all(_.map(this.ec2, async (ec2, region) => {
      let keyPairs = await ec2.describeKeyPairs({
        Filters: [
          {
            Name: 'key-name',
            Values: [keyName],
          },
        ],
      }).promise();

      // Since we're using a filter to look for *only* this
      // key pair, the only possibility is 0 or 1 results
      if (!keyPairs.data.KeyPairs[0]) {
        debug('creating key pair %s', keyName);
        await ec2.importKeyPair({
          KeyName: keyName,
          PublicKeyMaterial: this.pubKey,
        }).promise();
        debug('created key pair %s', keyName);
      }
    }));

    this.__knownKeyPairs.push(keyName);
  }

  /**
   * Delete a KeyPair when it's no longer needed.  This method does nothing
   * more and you shouldn't run it until you've turned everything off.
   */
  async deleteKeyPair(workerName) {
    assert(workerName);

    let keyName = this.createKeyPairName(workerName);

    debug('deleting %s', keyName);
    await Promise.all(_.map(this.ec2, async (ec2, region) => {
      let keyPairs = await ec2.describeKeyPairs({
        Filters: [
          {
            Name: 'key-name',
            Values: [keyName],
          },
        ],
      }).promise();

      // Since we're using a filter to look for *only* this
      // key pair, the only possibility is 0 or 1 results
      if (keyPairs.data.KeyPairs[0]) {
        await ec2.deleteKeyPair({
          KeyName: keyName,
        });
      }
    }));
    debug('deleted %s', keyName);

    this.__knownKeyPairs = this.__knownKeyPairs.filter(k => k !== keyName);
  }

  /**
   * Rouge Killer.  A rouge is an instance that has a KeyPair name that belongs
   * to this provisioner but is not present in the list of workerNames
   * provided.  We can also use this to shut down all instances of everything
   * if we just pass an empty list of workers which will say to this function
   * that all workerTypes are rouge.  Sneaky, huh?
   */
  async rougeKiller(configuredWorkers) {
    assert(configuredWorkers);
    let workersKnowByAws = this.knownWorkerTypes();

    let unconfiguredWorkerNames = workersKnowByAws.filter(n => !_.includes(configuredWorkers, n));

    for (let name of unconfiguredWorkerNames) {
      debug('killing rouge %s', name);
      await this.deleteKeyPair(name);
      await this.killByName(name);
      debug('killed rouge %s', name);
    }
  }

  /**
   * Kill all instances in all regions of a given workerName.
   */
  async killByName(name, states) {
    assert(name);
    assert(typeof name === 'string');
    if (!states) {
      states = ['running', 'pending', 'spotReq'];
    } else {
      assert(Array.isArray(states));
    }

    await Promise.all(_.map(this.ec2, async (ec2, region) => {
      let instances = this.__apiState.instances.filter(x => x.Region === region).filter(instance => {
        return instance.WorkerType === name && _.includes(states, instance.State.Name); 
      });

      // _.concat just doesn't seem to work, so I'm doing this a slightly
      // different way.  _.concat is showing as undefined :/
      let apiRequests = this.__apiState.requests.filter(x => x.Region === region).filter(request => {
        return request.WorkerType === name && _.includes(states, 'spotReq');
      });

      let intRequests = this.__internalState.filter(x => x.Region === region).filter(request => {
        return request.request.WorkerType && _.includes(states, 'spotReq');
      });

      let requests = apiRequests.slice().concat(intRequests);

      debug('killing %s in region %s by name in states %j', name, region, states);
      await this.killCancel(region, instances, requests);
      debug('killed %s in region %s by name in states %j', name, region, states);

    }));
  }

  /**
   * Kill instances and cancel spot requests
   */
  async killCancel(region, instances, requests) {
    assert(instances || requests);

    let i = instances || [];
    let r = requests || [];

    i = i.map(x => {
      if (typeof x === 'string') {
        return x;
      } else {
        return x.InstanceId;
      }
    });
    r = r.map(x => {
      if (typeof x === 'string') {
        return x;
      } else {
        return x.SpotInstanceRequestId;
      }
    });

    let promises = [];

    if (i.length > 0) {
      debug('terminating instances: %j', i);
      await this.ec2[region].terminateInstances({
        InstanceIds: i,
      }).promise();
      debug('terminated instances: %j', i);
    }
    if (r.length > 0) {
      debug('cancelling spot instance requests: %j', r);
      await this.ec2[region].cancelSpotInstanceRequests({
        SpotInstanceRequestIds: r,
      }).promise();
      debug('cancelled spot instance requests: %j', r);
    }
  }

  /**
   * Kill spot requests to change negatively by a capacity unit change.  We use
   * this function to do things like canceling spot requests that exceed the
   * number we require.
   */
  async killCapacityOfWorkerType(workerType, count, states) {
    assert(workerType);
    assert(typeof count === 'number');
    assert(states);

    // Capacities, by instance type
    let caps = {};

    // Build the mapping of capacity to instance type string
    for (let t of workerType.instanceTypes) {
      caps[t.instanceType] = workerType.capacityOfType(t.instanceType);
    }

    let capacity = this.capacityForType(workerType, states);
    debug('trying to find %d to kill out of %d capacity', count, capacity);
    let capToKill = 0;

    // Set up the storage for storing instance and sr ids by
    // region so we can cancel them easily later
    let toKill = {};
    for (let region of _.keys(this.ec2)) {
      toKill[region] = {
        instances: [],
        requests: [],
      };
    }

    function cont() {
      return count <= capToKill && capacity - capToKill >= workerType.minCapacity;
    }

    // Now, let's go through the states starting with spot requests.
    if (_.includes(states, 'spotReq')) {
      // Let's shuffle things!
      let shuffledRequests = shuffle.knuthShuffle(this.requestsOfType(workerType.workerType));

      for (let request of shuffledRequests) {
        if (cont()) {
          capToKill += caps[request.LaunchSpecification.InstanceType] || 1;
          toKill[request.Region].requests.push(request.SpotInstanceRequestId);
        }
      }

      // Remember that we do internal state a little differently
      for (let sr of this.__internalState) {
        if (cont() && sr.request.WorkerType === workerType.workerType) {
          capToKill += caps[sr.request.LaunchSpecification.InstanceType] || 1;
          toKill[sr.request.Region].requests.push(sr.request.SpotInstanceRequestId);
        }
      }
    }

    let shuffledApiInstances = shuffle.knuthShuffle(this.instancesOfType(workerType.workerType));
    for (let instance of shuffledApiInstances) {
      if (cont() && _.includes(states, instance.State.Name)) {
        capToKill += caps[instance.InstanceType] || 1;
        toKill[instance.Region].instances.push(instance.InstanceId);
      }
    }

    for (let region of Object.keys(toKill)) {
      let i = toKill[region].instances;
      let r = toKill[region].requests;
      if (i.length + r.length > 0) {
        debug('asking to kill up to %d capacity of %s in states %j in %s\nInstances: %j\nRequests: %j',
            capToKill, workerType.workerType, states, region, i, r);
        await this.killCancel(region, i, r);
        debug('request to kill %d of %s submitted', capToKill, workerType.workerType);
      }
    }
  }

  /**
   * Hard kill instances which have lived too long.  This is a safe guard to
   * protect against zombie attacks.  Workers should self impose a limit of 72
   * hours.
   */
  async zombieKiller() {
    let zombies = {};

    let killIfOlderThan = taskcluster.fromNow(this.maxInstanceLife);

    let tooOldInstances = this.__apiState.instances.filter(instance => {
      if (instance.LaunchTime) {
        let launchedAt = new Date(instance.LaunchTime);
        return launchedAt < killIfOlderThan;
      } else {
        return false;  // Since we can't know when it started, ignore it
      }
    });

    for (let instance of tooOldInstances) {
      if (!zombies[instance.Region]) {
        zombies[instance.Region] = [];
      }
      zombies[instance.Region].push(instance.InstanceId);
    }

    for (let region of Object.keys(zombies)) {
      debug('killing zombie instances in %s: %j', region, zombies[region]);
      await this.killCancel(region, zombies[region]);
      debug('killed zombie instances in %s: %j', region, zombies[region]);
    }
  }

  /**
   * Create a thing which has the stuff to insert into a worker state blob
   */
  stateForStorage(workerName) {
    let instances = [];
    let requests = [];
    let internalTrackedRequests = [];

    for (let instance of this.__apiState.instances) {
      if (instance.WorkerType === workerName) {
        instances.push({
          id: instance.InstanceId,
          srId: instance.SpotInstanceRequestId || '',
          ami: instance.ImageId,
          type: instance.InstanceType,
          region: instance.Region,
          zone: instance.Placement.AvailabilityZone,
          state: instance.State.Name,
          launch: instance.LaunchTime,
        });
      }
    }

    for (let request of this.__apiState.requests) {
      if (request.WorkerType === workerName) {
        requests.push({
          id: request.SpotInstanceRequestId,
          ami: request.LaunchSpecification.ImageId,
          type: request.LaunchSpecification.InstanceType,
          region: request.Region,
          zone: request.LaunchSpecification.Placement.AvailabilityZone,
          time: request.CreateTime,
          status: request.Status.Code,
        });
      }
    }

    for (let request of this.__internalState) {
      if (request.WorkerType === workerName) {
        internalTrackedRequests.push({
          id: request.SpotInstanceRequestId,
          ami: request.LaunchSpecification.ImageId,
          type: request.LaunchSpecification.InstanceType,
          region: request.Region,
          zone: request.LaunchSpecification.Placement.AvailabilityZone,
          time: request.CreateTime,
          status: request.Status.Code,
        });
      }
    }

    return {
      workerType: workerName,
      instances,
      requests,
      internalTrackedRequests,
    };
  }
}

module.exports = AwsManager;
