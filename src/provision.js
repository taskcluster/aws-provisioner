let log = require('./log');
let assert = require('assert');
let taskcluster = require('taskcluster-client');
let delayer = require('./delayer');
let shuffle = require('knuth-shuffle');
let rp = require('request-promise');
let _ = require('lodash');
let slugid = require('slugid');

/**
 *
 * This is a function so that we can hack on the exact ordering of spot
 * requests that need to be submitted for each region.  The input is a list of
 * objects.  Each object has two properties, workerType which is an instance of
 * the WorkerType entity, the name of a workertype `wt` is
 * `wt.workerType.workerType`.  The second item is a bid.  The bids have
 * properties region, type (InstanceType), zone and some pricing information.
 *
 * Do not edit the items in the list, just copy them into a new list.  Treat
 * them as immutable.
 */
function orderThingsInRegion(input) {
  switch (process.env.REQUEST_ORDER) {
    case 'random':
      return randomizeRequests(input);
      break;
    case 'round-robin':
    default:
      return roundRobinRequests(input);
      break;
  }
}

// Just randomize the list of requests that we're making to give equal chances
// worker type spawning earlier.
function randomizeRequests(input) {
  return shuffle.knuthShuffle(input);
}

// If we have request for workerTypes A, B, B, C, C, C, D, D, D, D then we
// should submit them in the order    A, B, C, D, B, C, D, C, D, D
function roundRobinRequests(input) {
  // assemble things by workerType name
  var byName = _.reduce(input, (res, wt) => {
    var name = wt.workerType.workerType;
    (res[name] || (res[name] = [])).push(wt);
    return res;
  }, {});
  var names = _.keys(byName).sort();

  // pop items in a round-robin order
  var output = [];
  do {
    _.forEach(names, name => {
      var thing = byName[name].pop();
      if (thing) {
        output.push(thing);
      }
    });
  } while (output.length < input.length);

  return output;
}

// Docs for Ec2: http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/EC2.html

class Provisioner {
  /**
   * A Provisioner knows how to use an AWS Manager and WorkerType to do provisioning.
   * It does not understand itself how to do AWS things or Azure things, it just
   * knows how and when certain things need to occur for provisioning to happen
   */
  constructor(cfg) {
    assert(typeof cfg === 'object');
    assert(cfg.awsManager); //  eslint-disable-line no-alert, quotes, semi
    this.awsManager = cfg.awsManager;

    assert(cfg.ec2manager);
    this.ec2manager = cfg.ec2manager;

    // We should have a WorkerType Entity
    assert(cfg.WorkerType);
    this.WorkerType = cfg.WorkerType;

    // We should have a Secret Entity
    assert(cfg.Secret);
    this.Secret = cfg.Secret;

    // We should have a Queue
    assert(cfg.queue);
    this.queue = cfg.queue;

    // This is the ID of the provisioner.  It is used to interogate the queue
    // for pending tasks
    assert(cfg.provisionerId);
    assert(typeof cfg.provisionerId === 'string');
    this.provisionerId = cfg.provisionerId;

    assert(cfg.monitor);
    this.monitor = cfg.monitor;
  }

  async __filterBrokenWorkers(workerTypes, forSpawning) {
    assert(workerTypes);
    assert(Array.isArray(workerTypes));
    assert(forSpawning);
    assert(Array.isArray(forSpawning));
    // Let's find the unique worker types in the list of requests to make This
    // is to avoid wasting time checking on worker types which we aren't even
    // going to make an attempt on
    let toSpawnWorkerTypes = _.uniq(forSpawning.map(x => x.workerType.workerType));

    // These are the worker type names that we shouldn't even attempt
    let disabled = [];

    for (let toTest of workerTypes.filter(x => _.includes(toSpawnWorkerTypes, x.workerType))) {
      // Consider iterating over a list where we filter out those worker types
      // which don't have outstanding requests
      let launchInfo = await this.awsManager.workerTypeCanLaunch(toTest);
      if (!launchInfo.canLaunch) {
        disabled.push(toTest.workerType);
        log.trace({workerType: toTest.workerType}, 'worker type invalid, adding to disabled list');
      }
    }

    if (disabled.length > 0) {
      let err = new Error('Found invalid worker types');
      err.types = disabled;
      log.warn({disabled}, 'found worker types which cannot launch, ignoring them');
    }

    log.trace({forSpawning, disabled}, '__filterBrokenWorkers outcome');

    return forSpawning.filter(x => !_.includes(disabled, x.workerType.workerType));
  }

  /**
   * Run provisioners for all known worker types once
   */
  async provision() {
    let allProvisionerStart = new Date();
    let workerTypes;
    workerTypes = await this.WorkerType.loadAll();
    log.info('loaded worker types');
    await this.awsManager.update();
    log.info('updated aws state');

    let workerNames = workerTypes.map(w => w.workerType);

    // Kill anything which is a rogue
    try {
      let extantWorkerTypes = await this.ec2manager.listWorkerTypes();
      let rogues = extantWorkerTypes.filter(x => !workerNames.includes(x));
      await Promise.all(rogues.map(x => this.ec2manager.terminateWorkerType(x)));
      await Promise.all(rogues.map(x => this.ec2manager.removeKeyPair(x)));
      log.info({rogues}, 'killed rogue worker types');
    } catch (err) {
      log.error({err}, 'Rogue killer error');
    }

    if (workerTypes.length === 0) {
      log.info('no worker types');
      return;
    }

    log.info({
      workerTypes: workerNames,
    }, 'configured worker types');

    let forSpawning = [];

    // We want to make sure that at least a single worker type worked.  If
    // that's the case, then we'll assume that other failures are related to
    // worker type configuration and give up on them
    let hadSuccess = false;
    for (let worker of workerTypes) {
      await this.ec2manager.ensureKeyPair(worker.workerType);
      let wtLog = log.child({workerType: worker.workerType});
      try {
        let change = await this.changeForType(worker);
        wtLog.info({change}, 'determined change');

        if (change > 0) {
          let bids = worker.determineSpotBids(
              _.keys(this.awsManager.ec2),
              this.awsManager.__pricing,
              change);
          for (let bid of bids) {
            forSpawning.push({workerType: worker, bid: bid});
          }

        } else if (change < 0) {
          let capToKill = -change;
          wtLog.info({count: capToKill}, 'Have too much capacity');
        }
        hadSuccess = true;
      } catch (err) {
        wtLog.error({err, workerType: worker.workerType}, 'error provisioning this worker type, skipping');
        this.monitor.reportError(err, 'warning', {workerType: worker.workerType});
      }
    }

    if (!hadSuccess) {
      throw new Error('Not a single worker type was able to run the provisioning change computation logic');
    }

    // Reset the variable back to false for use to see if .spawn() calls work
    hadSuccess = false;

    // There's nothing to do if we have no bids
    if (forSpawning.length === 0) {
      return;
    }

    // Ignore all worker types which we are sure won't be launchable
    forSpawning = await this.__filterBrokenWorkers(workerTypes, forSpawning);
    log.trace({forSpawning}, 'forSpawning');

    // Bucket requests by region
    let byRegion = {};
    for (let x of forSpawning) {
      assert(x.bid && x.bid.region);
      let r = x.bid.region;
      if (!byRegion[r]) {
        byRegion[r] = [x];
      } else {
        byRegion[r].push(x);
      }
    }

    log.info('starting to submit spot requests');
    log.trace({byRegion}, 'byRegion');

    await Promise.all(_.map(byRegion, async(toSpawn, region) => {
      let rLog = log.child({region});
      rLog.info('starting to submit spot requests in region');
      let beforeOrderingLength = byRegion[region].length;
      let inRegion = orderThingsInRegion(byRegion[region]);
      assert(beforeOrderingLength === inRegion.length);

      // Since we're having very small intervals between iterations now that
      // we're using EC2-Manager we should limit the max iteration duration
      inRegion = inRegion.slice(0, 200);

      while (inRegion.length) {
        log.info('asking to spawn instance');
        let toSpawn = inRegion.shift();

        try {
          await this.spawn(toSpawn.workerType, toSpawn.bid);
          hadSuccess = true;
        } catch (err) {
          rLog.error({
            err, 
            workerType: toSpawn.workerType.workerType,
            instanceType: toSpawn.bid.type,
            region: toSpawn.bid.region,
            zone: toSpawn.bid.zone,
          }, 'error submitting spot request');
        }
      }

      rLog.info('finished submiting spot requests in region');
    }));

    log.info('finished submiting all spot requests');

    if (!hadSuccess) {
      throw new Error('Not a single spot request was submitted with success in an iteration');
    }

    let duration = new Date() - allProvisionerStart;
    log.info({duration}, 'provisioning iteration completed');
  }

  /**
   * Figure out how to create the launch information based on a bid then
   * insert the secrets into the secret storage
   */
  async spawn(workerType, bid) {
    assert(workerType);
    assert(bid);

    let launchInfo = workerType.createLaunchSpec(bid);

    let spawnLog = log.child({
      price: bid.price,
      workerType: launchInfo.workerType,
      region: bid.region,
      zone: bid.zone,
      instanceType: bid.type,
    });

    await this.Secret.create({
      token: launchInfo.securityToken,
      workerType: workerType.workerType,
      secrets: launchInfo.secrets,
      scopes: launchInfo.scopes,
      expiration: taskcluster.fromNow('40 minutes'),
    });
    log.info({token: launchInfo.securityToken}, 'created secret');

    let clientToken = slugid.nice();
    
    try {
      let spotRequest = await this.ec2manager.requestSpotInstance(workerType.workerType, {
        ClientToken: clientToken,
        Region: bid.region,
        SpotPrice: bid.price,
        LaunchSpecification: launchInfo.launchSpec,
      });
      spawnLog.info('submitted spot request'); 
    } catch (err) {
      spawnLog.error({err}, 'failed to submit spot request');
      throw err;
    }
  };

  /**
   * Determine the change for a given worker type
   */
  async changeForType(workerType) {
    let wtLog = log.child({workerType: workerType.workerType});
    let result = await this.queue.pendingTasks(this.provisionerId, workerType.workerType);

    let pendingTasks = result.pendingTasks;
    wtLog.info({pendingTasks}, 'determined number of pending tasks');

    let capacityStats = await this.ec2manager.workerTypeStats(workerType.workerType);

    let runningCapacity = 0;
    let pendingCapacity = 0;

    for (let {instanceType, count, type} of capacityStats.pending) {
      pendingCapacity += count * workerType.capacityOfType(instanceType);
    }

    for (let {instanceType, count, type} of capacityStats.running) {
      runningCapacity += count * workerType.capacityOfType(instanceType);
    }

    let change = workerType.determineCapacityChange(runningCapacity, pendingCapacity, pendingTasks);

    log.info({
      workerType: workerType.workerType,
      pendingTasks: pendingTasks,
      runningCapacity: runningCapacity,
      pendingCapacity: pendingCapacity,
      change: change,
    }, 'changeForType outcome');

    return change;
  }

}

module.exports.Provisioner = Provisioner;
