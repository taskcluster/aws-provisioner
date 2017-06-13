let log = require('./log');
let assert = require('assert');
let taskcluster = require('taskcluster-client');
let delayer = require('./delayer');
let shuffle = require('knuth-shuffle');
let rp = require('request-promise');
let _ = require('lodash');

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

    // We should have a WorkerType Entity
    assert(cfg.WorkerType);
    this.WorkerType = cfg.WorkerType;

    // We should have a Secret Entity
    assert(cfg.Secret);
    this.Secret = cfg.Secret;

    // We should have a Queue
    assert(cfg.queue);
    this.queue = cfg.queue;

    // We should have Azure Blob Storage info
    assert(cfg.stateContainer);
    this.stateContainer = cfg.stateContainer;

    // We should have Azure Blob Storage info
    assert(cfg.stateNewContainer);
    this.stateNewContainer = cfg.stateNewContainer;

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

    try {
      await this.awsManager.ensureTags();
      log.info('resources tagged');
      await this.awsManager.rogueKiller(workerNames);
      log.info('rogue resources killed');
      await this.awsManager.zombieKiller();
      log.info('zombie resources killed');
      for (let name of workerNames) {
        await this.awsManager.createKeyPair(name);
      }
    } catch (err) {
      log.error(err, 'error during housekeeping tasks');
    }

    if (workerTypes.length === 0) {
      log.info('no worker types, skipping iteration, but doing housekeeping');
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
      let wtLog = log.child({workerType: worker.workerType});
      try {
        let change = await this.changeForType(worker);
        wtLog.info({change}, 'determined change');

        // This is a slightly modified version of the aws objects
        // which are made smaller to fit into azure storage entities

        let state;
        try {
          // This does create a bunch of extra logs... darn!
          state = this.awsManager.stateForStorage(worker.workerType);
          await this.stateContainer.write(worker.workerType, state);
          wtLog.trace('wrote state to azure');
        } catch (err) {
          wtLog.error(err, 'error writing state to azure');
        }

        // write in azure using azure-blob-storage
        /*try {
          await this.stateNewContainer.createDataBlockBlob({name: worker.workerType}, state);
          wtLog.trace('wrote state to azure using azure-blob-storage');
        } catch (err) {
          wtLog.error(err, 'error writing state using azure-blob-storage');
        }*/

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
          await this.awsManager.killCapacityOfWorkerType(worker, capToKill, ['pending', 'spotReq']);
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

      let endLoopAt = new Date();
      endLoopAt.setMinutes(endLoopAt.getMinutes() + 5);
      log.debug({inRegion: inRegion || 'empty, darn', endLoopAt}, 'about to do a loop');
      while (new Date() < endLoopAt && inRegion.length > 0) {
        log.info('asking to spawn instance');
        let toSpawn = inRegion.shift();

        try {
          await this.spawn(toSpawn.workerType, toSpawn.bid);
          hadSuccess = true;
        } catch (err) {
          if (err.code === 'MaxSpotInstanceCountExceeded') {
            rLog.warn({
              err,
              workerType: toSpawn.workerType.workerType,
              instanceType: toSpawn.bid.type,
              region: toSpawn.bid.region,
              zone: toSpawn.bid.zone,
            }, 'too many spot requests of this type in region');
          } else {
            rLog.error({
              err, 
              workerType: toSpawn.workerType.workerType,
              instanceType: toSpawn.bid.type,
              region: toSpawn.bid.region,
              zone: toSpawn.bid.zone,
            }, 'error submitting spot request');
          }
        }
      }

      rLog.info('finished submiting spot requests in region');
    }));

    log.info('finished submiting spot requests');

    if (!hadSuccess) {
      throw new Error('Not a single spot request was submitted with success in an iteration');
    }

    let duration = new Date() - allProvisionerStart;
    log.info({duration}, 'provisioning iteration complete');
  }

  /**
   * Figure out how to create the launch information based on a bid then
   * insert the secrets into the secret storage
   */
  async spawn(workerType, bid) {
    assert(workerType);
    assert(bid);

    let launchInfo = workerType.createLaunchSpec(bid);

    await this.Secret.create({
      token: launchInfo.securityToken,
      workerType: workerType.workerType,
      secrets: launchInfo.secrets,
      scopes: launchInfo.scopes,
      expiration: taskcluster.fromNow('40 minutes'),
    });
    log.info({token: launchInfo.securityToken}, 'created secret');

    return this.awsManager.requestSpotInstance(launchInfo, bid);
  };

  /**
   * Determine the change for a given worker type
   */
  async changeForType(workerType) {
    let wtLog = log.child({workerType: workerType.workerType});
    let result;
    result = await this.queue.pendingTasks(this.provisionerId, workerType.workerType);
    let pendingTasks = result.pendingTasks;
    wtLog.info({pendingTasks}, 'got pending tasks count');

    let runningCapacity = this.awsManager.capacityForType(workerType, ['running']);
    let spotReqCap = this.awsManager.capacityForType(workerType, ['spotReq']);
    let pendingInstCapacity = this.awsManager.capacityForType(workerType, ['pending']);
    let pendingCapacity = pendingInstCapacity + spotReqCap;

    let change = workerType.determineCapacityChange(runningCapacity, pendingCapacity, pendingTasks);

    log.info({
      workerType: workerType.workerType,
      pendingTasks: pendingTasks,
      runningCapacity: runningCapacity,
      pendingCapacity: pendingCapacity,
      spotReqCap: spotReqCap,
      pendingInstCapacity: pendingInstCapacity,
      change: change,
            
    }, 'changeForType outcome');

    if (pendingTasks > 0 && -change > pendingTasks) {
      log.error('THIS IS A MARKER TO MAKE US LOOK INTO BUG1297811');
    }

    return change;
  }

}

module.exports.Provisioner = Provisioner;
