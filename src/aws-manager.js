let log = require('./log');
let assert = require('assert');
let shuffle = require('knuth-shuffle');
let taskcluster = require('taskcluster-client');
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
 * monitor:
 *      Instance of a taskcluster-lib-stats.monitor which is used to
 *      submit data points to a statsum instance
 */
class AwsManager {

  constructor(
    ec2,
    provisionerId,
    monitor,
    ec2manager,
    keyPrefix,
    pubKey,
  ) {
    
    assert(ec2);
    assert(provisionerId);
    assert(monitor);
    assert(keyPrefix);
    assert(pubKey);

    this.ec2 = ec2;
    this.provisionerId = provisionerId;
    this.monitor = monitor;
    this.ec2manager = ec2manager;
    this.keyPrefix = keyPrefix;
    this.pubKey = pubKey;

    this.__availableAZ = {};
  }

  /**
   * Update the state from the AWS API
   */
  async update() {
    // We want to fetch the last 30 minutes of pricing data
    let pricingStartDate = new Date();
    pricingStartDate.setMinutes(pricingStartDate.getMinutes() - 30);

    let availableAZ = {};
    let allPricingHistory = {};

    await Promise.all(_.map(this.ec2, async (ec2, region) => {
      let rLog = log.child({region});
      
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
    }));
    log.info('finished pricing update for all regions');

    // Assign all of the new state objects to the properties of this aws manager
    this.__availableAZ = availableAZ;
    this.__pricing = allPricingHistory;

    let allZones = [];
    for (let r of _.keys(availableAZ)) {
      Array.prototype.push.apply(allZones, availableAZ[r]);
    }
    allZones.sort();
    log.info({
      zones: allZones,
    }, 'available availability zones');
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
      if (err.code === 'InvalidLaunchSpecifications') {
        returnValue.reasons = err.reasons;
      } else {
        returnValue.reasons.push(err.toString());
      }
      return returnValue;
    }

    await Promise.all(worker.regions.map(async r => {
      if (!this.ec2[r.region]) {
        // this region is not in cfg.app.allowedRegions
        return;
      }
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
   * Kill spot requests to change negatively by a capacity unit change.  We use
   * this function to do things like canceling spot requests that exceed the
   * number we require.
   */
  async killCapacityOfWorkerType(workerType, count, states) {
    throw new Error('This function is semi-deprecated');
  }
}

AwsManager.runAWSRequest = runAWSRequest;

module.exports = AwsManager;
