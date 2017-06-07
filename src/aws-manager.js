let log = require('./log');
let assert = require('assert');
let shuffle = require('knuth-shuffle');
let taskcluster = require('taskcluster-client');
let series = require('./influx-series');
let keyPairs = require('./key-pairs');
let monitors = require('./monitors');
let _ = require('lodash');
let delayer = require('./delayer');
let amiExists = require('./check-for-ami');
let sgExists = require('./describe-security-group');
let slugid = require('slugid');

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
 * This method will run an EC2 operation.  Because the AWS-SDK client is so
 * much fun to work with, we need to do the following things above what it does
 * to get useful information out of it.
 *
 *   1. We want to have exceptions that always have region, method and service
 *      name if available
 *   2. Any requests which would have a requestId should include it in their
 *      exceptions
 *   3. Sometimes promises from AWS-SDK just magically never return and never
 *      timeout even though we've set those options.  We have our own timeout
 *   4. Useful logging that includes useful debugging information
 *   5. Because we're catching the exceptions here, there's a *chance* that
 *      we might get useful stack traces.  AWS-SDK exceptions which aren't
 *      caught seem to have the most utterly useless stacks, which only
 *      have frames in their own state machine and never include the call
 *      site
 *
 * I am halfway tempted to rewrite this file using aws4 because it is a more
 * sensible library.
 *
 */
async function runAWSRequest(service, method, body) {
  assert(typeof service === 'object');
  assert(typeof method === 'string');
  assert(typeof body === 'object');

  let region = service.config.region || 'unknown-region';
  let serviceId = service.serviceIdentifier || 'unknown-service';

  let request;

  try {
    // We have to have a reference to the AWS.Request object
    // because we'll later need to refer to its .response property
    // to find out the requestId. part 1/2 of the hack
    request = service[method](body);
    let response = await Promise.race([
      request.promise(),
      delayer(240 * 1000)().then(() => {
        let err = new Error(`Timeout in ${region} ${serviceId}.${method}`);
        err.region = region;
        err.service = serviceId;
        err.body = body;
        throw err;
      }),
    ]);
    return response;
  } catch (err) {
    let logObj = {
      //err,
      method,
    };

    // We want to have properties we think might be in the error and
    // are relevant right here
    for (let prop of ['code', 'region', 'service', 'requestId']) {
      if (err[prop]) { logObj[prop] = err[prop]; }
    }

    // Grab the request id if it's there. part 2/2 of the hack
    if (request.response && request.response.requestId) {
      if (logObj.requestId) {
        logObj.requestIdFromHack = request.response.requestId;
      } else {
        logObj.requestId = request.response.requestId;
      }
    }

    // For the region and service, if they don't already exist, we'll
    // set it to the values here.
    if (!logObj.region) {
      logObj.region = region;
    }
    if (!logObj.service) {
      logObj.service = serviceId;
    }

    // We're going to add these in because they're handy to have
    if (!err.region) {
      err.region = region;
    }
    if (!err.service) {
      err.service = serviceId;
    }
    if (!err.method) {
      err.method = method;
    }

    if (err.code !== 'DryRunOperation') {
      log.error(logObj, 'aws request failure');
    }

    // We're just logging here so rethrow
    throw err;
  }
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
 *      Instance of a taskcluster-lib-stats.stats.Influx class which is used to
 *      submit data points to an influx instance
 * monitor:
 *      Instance of a taskcluster-lib-stats.monitor which is used to
 *      submit data points to a statsum instance
 */
class AwsManager {
  constructor(ec2, provisionerId, keyPrefix, pubKey, maxInstanceLife, influx, monitor, ec2manager, describeInstanceDelay, describeSpotRequestDelay) {
    assert(ec2);
    assert(provisionerId);
    assert(keyPrefix);
    assert(pubKey);
    assert(maxInstanceLife);
    assert(influx);
    assert(monitor);
    assert(describeInstanceDelay);
    assert(describeSpotRequestDelay);

    this.ec2 = ec2;
    this.provisionerId = provisionerId;
    this.keyPrefix = keyPrefix;
    this.pubKey = pubKey;
    this.maxInstanceLife = maxInstanceLife;
    this.influx = influx;
    this.monitor = monitor;
    this.ec2manager = ec2manager;

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

    // Set up influxdb and lib-monitor reporters
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
    log.info('starting state update for all regions');
    // We had an issue where the EC2 api would freeze up on these api calls and
    // would never reject or resolve.  That's why we now race a 240s timeout
    // and reject this promise if the state calls take longer than 240s
    //
    // NOTE: Now that we're using lib-iterate, we probably don't *need* this
    // second Promise.race, but I'd like to keep it in because I'm paranoid

    await Promise.all(_.map(this.ec2, async (ec2, region) => {
      let rLog = log.child({region});

      // YES!  I know this is done sort of slowly and inefficiently.
      // We are bound not by speed but by the API, so we've removed
      // the concurrency and all that stuff so that we're less likely to burn
      // the API

      // Instances
      for (let state of ['running', 'pending', 'shutting-down', 'terminated', 'stopping']) {
        let instances = await runAWSRequest(ec2, 'describeInstances', {
          Filters: [
            {
              Name: 'key-name',
              Values: [this.keyPrefix + '*'],
            },
            {
              Name: 'instance-state-name',
              Values: [state],
            },
          ],
        });
        await delayer(describeInstanceDelay)();
        rLog.info({state}, 'fetched instances in state for region');
        for (let reservation of instances.Reservations) {
          for (let instance of reservation.Instances) {
            let workerType = this.parseKeyPairName(instance.KeyName).workerType;
            // Maybe use objFilter here
            let filtered = instance;
            filtered.Region = region;
            filtered.WorkerType = workerType;
            if (state === 'pending' || state === 'running') {
              apiState.instances.push(filtered);
            } else { 
              deadState.instances.push(filtered);
            }
          }
        };
      }

      // Living spot requests
      // In a list to keep the namespace clean
      for (let state of ['open', 'cancelled', 'failed', 'closed']) {
        let spotRequests = await runAWSRequest(ec2, 'describeSpotInstanceRequests', {
          Filters: [
            {
              Name: 'launch.key-name',
              Values: [this.keyPrefix + '*'],
            }, {
              Name: 'state',
              Values: [state],
            },
          ],
        });
        await delayer(describeSpotRequestDelay)();

        rLog.info({state}, 'fetched requests in state for region');

        let stalledSRIds = [];

        // Stalled requests are those which have taken way too long to be
        // fulfilled.  We'll consider them dead after a certain amount of time
        // and make new requests for their pending tasks
        for (let request of spotRequests.SpotInstanceRequests) {
          let workerType = this.parseKeyPairName(request.LaunchSpecification.KeyName).workerType;
          let filtered = request;
          filtered.Region = region;
          filtered.WorkerType = workerType;
          if (state === 'open') {
            if (this._spotRequestStalled(filtered)) {
              stalledSRIds.push(filtered.SpotInstanceRequestId);
            } else {
              apiState.requests.push(filtered);
            }
          } else {
            deadState.requests.push(filtered);
          }
        }

        // Request that stalled spot requests be cancelled
        if (stalledSRIds.length > 0) {
          await this.killCancel(region, [], stalledSRIds);
          rLog.info({stalledSpotRequests: stalledSRIds}, 'killed stalled spot requests');
        }
      }

      // Find all the available availability zones
      let rawAZData = await runAWSRequest(ec2, 'describeAvailabilityZones', {
        Filters: [
          {
            Name: 'state',
            Values: ['available'],
          },
        ],
      });
      availableAZ[region] = rawAZData.AvailabilityZones.map(x => x.ZoneName);

      // Raw pricing data
      let rawPricingData = await runAWSRequest(ec2, 'describeSpotPriceHistory', {
        StartTime: pricingStartDate,
        Filters: [
          {
            Name: 'product-description',
            Values: ['Linux/UNIX'],
          },
        ],
      });

      allPricingHistory[region] = this._findMaxPrices(rawPricingData, availableAZ[region]);

      rLog.info('ran all state promises for region');
    }));
    log.info('finished state update for all regions');

    // Assign all of the new state objects to the properties of this aws manager
    this.__availableAZ = availableAZ;
    this.__pricing = allPricingHistory;
    this.__apiState = apiState;
    this.__deadState = deadState;

    let allZones = [];
    for (let r of _.keys(availableAZ)) {
      Array.prototype.push.apply(allZones, availableAZ[r]);
    }
    allZones.sort();
    log.info({
      zones: allZones,
    }, 'available availability zones');

    // Figure out what's changed between this and the last iteration
    let stateDifferences = this._compareStates(this.__apiState, this.__previousApiState, this.__deadState);
    this._reconcileStateDifferences(stateDifferences, this.__deadState, this.__apiState);

    // We want to make sure that our internal state is always up to date when
    // we fetch the updated state
    this._reconcileInternalState();
    log.info('finished all aws state update operations');
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
      return true;
    }

    // We've found a spot price floor
    if (sr.Status.Code === 'price-too-low') {
      monitors.spotFloorFound(
        this.monitor,
        this.reportSpotPriceFloorFound,
        sr.Region,
        sr.LaunchSpecification.Placement.AvailabilityZone,
        sr.LaunchSpecification.InstanceType,
        dateForInflux(new Date()),
        parseFloat(sr.SpotPrice, 10),
        'spot-request-price-too-low'
      );
    }

    if (_.includes(stalledStates, sr.Status.Code)) {
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
      monitors.spotRequestFulfilled(
        this.monitor,
        this.reportSpotRequestsFulfilled,
        this.provisionerId,
        request.Region,
        request.LaunchSpecification.Placement.AvailabilityZone,
        request.LaunchSpecification.InstanceType,
        request.WorkerType,
        request.SpotInstanceRequestId,
        request.InstanceId,
        dateForInflux(request.Status.UpdateTime)
      );
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
        monitors.spotRequestDied(
          this.monitor,
          this.reportSpotRequestsDied,
          this.provisionerId,
          request.Region,
          request.LaunchSpecification.Placement.AvailabilityZone,
          request.LaunchSpecification.InstanceType,
          request.WorkerType,
          request.SpotInstanceRequestId,
          dateForInflux(request.Status.UpdateTime),
          parseFloat(request.SpotPrice, 10),
          request.State,
          request.Status.Code,
          request.Status.Message
        );
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
      monitors.instanceTerminated(
        this.monitor,
        this.reportInstanceTerminated,
        this.provisionerId,
        instance.Region,
        instance.Placement.AvailabilityZone,
        instance.InstanceType,
        instance.WorkerType,
        instance.InstanceId,
        instance.SpotInstanceRequestId,
        dateForInflux(time),
        dateForInflux(instance.LaunchTime),
        instance.State.Code,
        instance.State.Name,
        instance.StateReason.Code,
        instance.StateReason.Message
      );

      if (instance.StateReason.Code === 'Server.SpotInstanceTermination') {
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
          monitors.spotFloorFound(
            this.monitor,
            this.reportSpotPriceFloorFound,
            instance.Region,
            instance.Placement.AvailabilityZone,
            instance.InstanceType,
            dateForInflux(new Date()),
            price,
            'instance-spot-killed'
          );
        }
      }
    };

    // Let's handle instance which already have a state reason, or
    // save them for a future iteration if not
    for (let instance of differences.instances) {
      // Using StateReason instead of StateTransitionReason
      if (instance.StateReason && instance.StateReason.Code) {
        plotInstanceDeath(instance, new Date().toISOString());
      } else {
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
            plotInstanceDeath(instanceMightHave, instanceAwaiting.time);
          }
        }
      }

      // We don't want to track this stuff forever!
      if (instanceAwaiting.iterationCount++ > MAX_ITERATIONS_FOR_STATE_RESOLUTION) {
        keepItInTheList = false;
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
   * Decide whether the passed-in worker type is able to run
   */
  async workerTypeCanLaunch(worker, WorkerType) {
    assert(typeof worker);
    if (WorkerType) {
      assert(typeof WorkerType.testLaunchSpecs === 'function');
    }

    let returnValue = {
      canLaunch: true,
      reasons: [],
    };

    let launchSpecs;

    // We return early here because if we can't even test launch specs,
    // then there's no point in continuing
    try {
      // For the yet-to-be-created case in the API, we want to use the static
      // method rather than the non-existing instance method
      if (WorkerType) {
        launchSpecs = WorkerType.testLaunchSpecs(
            worker,
            this.keyPrefix,
            this.provisionerId,
            'http://taskcluster.net/fake-provisioner-base-url',
            this.pubKey,
            worker.workerType
        );
      } else {
        launchSpecs = worker.testLaunchSpecs();
      }
    } catch (err) {
      returnValue.canLaunch = false;
      returnValue.reasons.push(err);
      return returnValue;
    }

    await Promise.all(worker.regions.map(async r => {
      await Promise.all(worker.instanceTypes.map(async t => {
        let launchSpec = launchSpecs[r.region][t.instanceType].launchSpec;

        // Let's make sure that the AMI exists
        let exists = await amiExists(this.ec2[r.region], launchSpec.ImageId);
        if (!exists) {
          returnValue.canLaunch = false;
          returnValue.reasons.push(new Error(`${launchSpec.ImageId} not found in ${r.region}`));
        }

        // Now, let's do a DryRun on all the launch specs
        try {
          await runAWSRequest(this.ec2[r.region], 'requestSpotInstances', {
            InstanceCount: 1,
            DryRun: true,
            Type: 'one-time',
            LaunchSpecification: launchSpec,
            SpotPrice: '0.1',
            ClientToken: slugid.nice(),
          });
        } catch (err) {
          if (err.code !== 'DryRunOperation') {
            returnValue.canLaunch = false;
            returnValue.reasons.push(err);
          }
        }
      }));

      let launchSpecsRegion = worker.instanceTypes.map(t => launchSpecs[r.region][t.instanceType].launchSpec);
      let allSGForRegion = _.uniq(_.flatten(launchSpecsRegion.map(spec => spec.SecurityGroups)));

      let hasAllRequiredSG = await sgExists(this.ec2[r.region], allSGForRegion);
      log.debug({allSGForRegion, hasAllRequiredSG}, 'security group check outcome');
      if (!hasAllRequiredSG) {
        returnValue.canLaunch = false;
        let err = new Error('Missing one or more security groups');
        err.requested = allSGForRegion;
        returnValue.reasons.push(err);
        log.warn({
          region: r.region,
          neededGroups: allSGForRegion,
        }, 'missing security groups');
      }
    }));

    if (returnValue.canLaunch) {
      log.debug({workerType: worker.workerType}, 'worker type can launch');
    } else {
      log.error({workerType: worker.workerType}, 'worker type cannot launch');
      for (let x = 0; x < returnValue.reasons.length; x++) {
        log.error({
          workerType: worker.workerType,
          err: returnValue.reasons[x],
        }, 'cannot launch reason ' + x);
      }
    }

    return returnValue;
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

    let capacityTrace = [];

    for (let instance of instances) {
      if (_.includes(states, instance.State.Name)) {
        try {
          capacity += workerType.capacityOfType(instance.InstanceType);

          capacityTrace.push({
            newCapacity: capacity,
            capacityOfType: workerType.capacityOfType(instance.InstanceType),
            instanceType: instance.InstanceType,
            region: instance.Region,
            state: instance.State.Name,
            type: 'instance',
          });
        } catch (err) {
          capacity++;

          capacityTrace.push({
            newCapacity: capacity,
            capacityOfType: 1,
            instanceType: instance.InstanceType,
            region: instance.Region,
            state: instance.State.Name,
            type: 'instance',
          });
        }
      }
    }

    for (let request of requests) {
      if (_.includes(states, 'spotReq')) {
        try {
          capacity += workerType.capacityOfType(request.InstanceType);

          capacityTrace.push({
            newCapacity: capacity,
            capacityOfType: workerType.capacityOfType(request.InstanceType),
            instanceType: request.InstanceType,
            region: request.Region,
            state: 'spotReq',
            apiState: request.State,
            status: request.Status.Code,
            internal: false,
            type: 'request',
          });
        } catch (err) {
          capacity++;

          capacityTrace.push({
            newCapacity: capacity,
            capacityOfType: 1,
            instanceType: request.InstanceType,
            region: request.Region,
            state: 'spotReq',
            apiState: request.State,
            status: request.Status.Code,
            internal: false,
            type: 'request',
          });
        }
      }
    }

    for (let sr of this.__internalState) {
      if (_.includes(states, 'spotReq')) {
        try {
          capacity += workerType.capacityOfType(sr.request.InstanceType);

          capacityTrace.push({
            newCapacity: capacity,
            capacityOfType: workerType.capacityOfType(sr.request.InstanceType),
            instanceType: sr.request.InstanceType,
            region: sr.request.Region,
            state: 'spotReq',
            apiState: sr.request.State,
            status: sr.request.Status.Code,
            internal: true,
            type: 'request',
          });
        } catch (err) {
          capacity++;

          capacityTrace.push({
            newCapacity: capacity,
            capacityOfType: 1,
            instanceType: sr.request.InstanceType,
            region: sr.request.Region,
            state: 'spotReq',
            apiState: sr.request.State,
            status: sr.request.Status.Code,
            internal: true,
            type: 'request',
          });
        }
      }
    }

    if (workerType.workerType === 'gecko-decision') {
      log.info({
        answer: capacity,
        states: states,
        workerType: workerType.workerType,
        trace: capacityTrace,
      }, 'capacityForType trace');
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

    let x = (resource, id) => {
      if (!tags[resource.Region]) {
        tags[resource.Region] = {};
      }

      if (!tags[resource.Region][resource.WorkerType]) {
        tags[resource.Region][resource.WorkerType] = {
          data: [
            {Key: 'Name', Value: resource.WorkerType},
            {Key: 'Owner', Value: this.provisionerId},
            {Key: 'WorkerType', Value: this.provisionerId + '/' + resource.WorkerType},
          ],
          ids: [id],
        };
      } else {
        tags[resource.Region][resource.WorkerType].ids.push(id);
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
        tagPromises.push(runAWSRequest(this.ec2[region], 'createTags', {
          Tags: tags[region][workerType].data,
          Resources: tags[region][workerType].ids,
        }));
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
        monitors.lag(
          this.monitor,
          this.reportEc2ApiLag,
          this.provisionerId,
          request.request.Region,
          request.request.LaunchSpecification.Placement.AvailabilityZone,
          request.request.LaunchSpecification.InstanceType,
          request.request.WorkerType,
          request.request.SpotInstanceRequestId,
          0,
          (now - request.submitted) / 1000
        );
        return false;
      } else if (now - request.submitted >= 15 * 60 * 1000) {
        // We want to track spot requests which aren't in the API yet for a
        // maximum of 15 minutes.  Any longer and we'd risk tracking these
        // forever, which could bog down the system
        monitors.lag(
          this.monitor,
          this.reportEc2ApiLag,
          this.provisionerId,
          request.request.Region,
          request.request.LaunchSpecification.Placement.AvailabilityZone,
          request.request.LaunchSpecification.InstanceType,
          request.request.WorkerType,
          request.request.SpotInstanceRequestId,
          1,
          (now - request.submitted) / 1000
        );
        return false;
      } else {
        return true;
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
    let clientToken = slugid.nice();
    log.trace({
      ClientToken: clientToken,
      bid,
      workerType: launchInfo.workerType,
    }, 'aws api client token');

    let spotRequest;
    try {
      spotRequest = await runAWSRequest(this.ec2[bid.region], 'requestSpotInstances', {
        InstanceCount: 1,
        Type: 'one-time',
        LaunchSpecification: launchInfo.launchSpec,
        SpotPrice: bid.price.toString(),
        ClientToken: clientToken,
      });
    } catch (err) {
      if (err.code && err.code !== 'RequestResourceCountExceeded') {
        throw err;
      } else if (err.code && err.code === 'MaxSpotInstanceCountExceeded') {
        log.info({
          region: bid.region,
          instanceType: bid.type,
          zone: bid.zone,
          workerType: launchInfo.workerType},
          'Too many spot instances in this region'); 
      } else {
        await new Promise((resolve, reject) => {
          setTimeout(resolve, 10000);
        });
      }
    }

    let spotReq = spotRequest.SpotInstanceRequests[0];

    try {
      await this.ec2manager.importSpotRequest(bid.region, spotRequest);
      log.info({
        srid: spotReq.SpotInstanceRequestId,
        workerType: launchInfo.workerType,
        region: bid.region,
        instanceType: bid.type,
      }, 'Submitted spot request to ec2-manager');

    } catch (err) {
      log.info({err}, 'Problem reporting this spot request to the ec2-manager');
    }

    log.info({
      srid: spotReq.SpotInstanceRequestId,
      price: bid.price,
      workerType: launchInfo.workerType,
      region: bid.region,
      zone: bid.zone,
      instanceType: bid.type,
    }, 'submitted spot request');

    let info = {
      workerType: launchInfo.workerType,
      request: spotReq,
      bid: bid,
      submitted: new Date(),
    };

    monitors.spotRequestSubmitted(
      this.monitor,
      this.reportSpotRequestsSubmitted,
      this.provisionerId,
      info.bid.region,
      info.bid.zone,
      info.bid.type,
      info.workerType,
      info.request.SpotInstanceRequestId,
      bid
    );

    monitors.amiUsage(
      this.monitor,
      this.reportAmiUsage,
      this.provisionerId,
      info.bid.region,
      info.bid.zone,
      info.bid.type,
      info.workerType,
      launchInfo.launchSpec.ImageId
    );

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
      let keyPairs = await runAWSRequest(ec2, 'describeKeyPairs', {
        Filters: [
          {
            Name: 'key-name',
            Values: [keyName],
          },
        ],
      });

      // Since we're using a filter to look for *only* this
      // key pair, the only possibility is 0 or 1 results
      if (!keyPairs.KeyPairs[0]) {
        await runAWSRequest(ec2, 'importKeyPair', {
          KeyName: keyName,
          PublicKeyMaterial: this.pubKey,
        });
        log.info({region, keyName}, 'created key pair');
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

    await Promise.all(_.map(this.ec2, async (ec2, region) => {
      let keyPairs = await runAWSRequest(ec2, 'describeKeyPairs', {
        Filters: [
          {
            Name: 'key-name',
            Values: [keyName],
          },
        ],
      });

      // Since we're using a filter to look for *only* this
      // key pair, the only possibility is 0 or 1 results
      if (keyPairs.KeyPairs[0]) {
        await runAWSRequest(ec2, 'deleteKeyPair', {
          KeyName: keyName,
        });
        log.info({region, keyName}, 'deleted key pair');
      }
    }));

    this.__knownKeyPairs = this.__knownKeyPairs.filter(k => k !== keyName);
  }

  /**
   * Rogue Killer.  A rogue is an instance that has a KeyPair name that belongs
   * to this provisioner but is not present in the list of workerNames
   * provided.  We can also use this to shut down all instances of everything
   * if we just pass an empty list of workers which will say to this function
   * that all workerTypes are rogue.  Sneaky, huh?
   */
  async rogueKiller(configuredWorkers) {
    assert(configuredWorkers);
    let workersKnowByAws = this.knownWorkerTypes();

    let unconfiguredWorkerNames = workersKnowByAws.filter(n => !_.includes(configuredWorkers, n));

    for (let name of unconfiguredWorkerNames) {
      await this.deleteKeyPair(name);
      await this.killByName(name);
    }
    if (unconfiguredWorkerNames.length > 0) {
      log.info({rogueWorkerTypes: unconfiguredWorkerNames}, 'killed rogues');
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

      await this.killCancel(region, instances, requests);
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
      promises.push(runAWSRequest(this.ec2[region], 'terminateInstances', {
        InstanceIds: i,
      }));
    }
    if (r.length > 0) {
      promises.push(runAWSRequest(this.ec2[region], 'cancelSpotInstanceRequests', {
        SpotInstanceRequestIds: r,
      }));
    }

    await Promise.all(promises);

    if (i.length + r.length > 0) {
      log.info({
        instances: i,
        requests: r,
        region: region,
      }, 'killed instances and cancelled spot requests in region');
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

    log.info({
      workerType: workerType.workerType,
      states,
      countRequested: count,
      countAbleToKill: capToKill,
    }, 'trying to kill capacity');

    for (let region of Object.keys(toKill)) {
      let i = toKill[region].instances;
      let r = toKill[region].requests;
      if (i.length + r.length > 0) {
        await this.killCancel(region, i, r);
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
      await this.killCancel(region, zombies[region]);
      log.info('killed zombies');
    }
  }

  /**
   * Create a thing which has the stuff to insert into a worker state blob
   */
  stateForStorage(workerName) {
    let instances = [];
    let requests = [];

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
          visibleToEC2Api: true,
          status: request.Status.Code,
        });
      }
    }

    for (let request of this.__internalState) {
      if (request.WorkerType === workerName) {
        requests.push({
          id: request.SpotInstanceRequestId,
          ami: request.LaunchSpecification.ImageId,
          type: request.LaunchSpecification.InstanceType,
          region: request.Region,
          zone: request.LaunchSpecification.Placement.AvailabilityZone,
          time: request.CreateTime,
          visibleToEC2Api: false,
          status: request.Status.Code,
        });
      }
    }

    return {
      workerType: workerName,
      instances,
      requests,
    };
  }
}

AwsManager.runAWSRequest = runAWSRequest;

module.exports = AwsManager;
