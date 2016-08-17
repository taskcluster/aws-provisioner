let log = require('./log');
let assert = require('assert');
let taskcluster = require('taskcluster-client');
let delayer = require('./delayer');
let shuffle = require('knuth-shuffle');
let Biaser = require('./biaser.js');
let rp = require('request-promise');
let _ = require('lodash');

let series = require('./influx-series');

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

    // We should have an influx object
    assert(cfg.influx);
    this.influx = cfg.influx;

    this.reportProvisioningIteration = series.provisionerIteration.reporter(this.influx);
    this.reportAllProvisioningIterationDuration = series.allProvisioningIterationDuration.reporter(this.influx);

    // This is the ID of the provisioner.  It is used to interogate the queue
    // for pending tasks
    assert(cfg.provisionerId);
    assert(typeof cfg.provisionerId === 'string');
    this.provisionerId = cfg.provisionerId;

    // We should have an influx instance
    assert(cfg.influx);
    this.influx = cfg.influx;

    // Let's create a biaser
    this.biaser = new Biaser({
      influx: this.influx,
      maxBiasAge: 20,
      statsAge: '24h',
      killRateMultiplier: 4,
      emptyComboBias: 0.95,
    });
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

    try {
      await this.biaser.fetchBiasInfo(this.awsManager.availableAZ(), []);
      log.info('obtained bias info');
    } catch (err) {
      log.warn(err, 'error updating bias info, ignoring');
    }

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

    log.info({
      workerTypes: workerNames,
    }, 'configured worker types');

    let forSpawning = [];

    await Promise.all(workerTypes.map(async worker => {
      let wtLog = log.child({workerType: worker.workerType});
      let change = await this.changeForType(worker);
      wtLog.info({change}, 'determined change');

      // This is a slightly modified version of the aws objects
      // which are made smaller to fit into azure storage entities

      try {
        // This does create a bunch of extra logs... darn!
        let state = this.awsManager.stateForStorage(worker.workerType);
        await this.stateContainer.write(worker.workerType, state);
        wtLog.info('wrote state to azure');
      } catch (err) {
        wtLog.error(err, 'error writing state to azure');
      }

      if (change > 0) {
        let bids = worker.determineSpotBids(
            _.keys(this.awsManager.ec2),
            this.awsManager.__pricing,
            change,
            this.biaser);
        for (let bid of bids) {
          forSpawning.push({workerType: worker, bid: bid});
        }
      } else if (change < 0) {
        let capToKill = -change;
        await this.awsManager.killCapacityOfWorkerType(worker, capToKill, ['pending', 'spotReq']);
      }
    }));

    // There's nothing to do if we have no bids
    if (forSpawning.length === 0) {
      return;
    }

    // We want to shuffle up the bids so that we don't prioritize
    // any particular worker type
    forSpawning = shuffle.knuthShuffle(forSpawning);

    // Let's find the unique worker types in the list of requests to make
    let toSpawnWorkerTypes = _.intersection(forSpawning.map(x => x.workerType.workerType));

    let disabled = [];
    for (let toTest of workerTypes.filter(x => toSpawnWorkerTypes.indexOf(x) !== -1)) {
      // Consider iterating over a list where we filter out those worker types
      // which don't have outstanding requests
      let canLaunch = await this.awsManager.workerTypeCanLaunch(toTest);
      if (!canLaunch) {
        disabled.push(toTest.workerType);
      }
    }

    if (disabled.length > 0) {
      log.warn({disabled}, 'found worker types which cannot launch, ignoring them');
    }

    forSpawning = forSpawning.filter(x => disabled.indexOf(x.workerType.workerType) === -1);

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

    await Promise.all(_.map(byRegion, async(toSpawn, region) => {
      let rLog = log.child({region});
      rLog.info('starting to submit spot requests in region');
      let inRegion = orderThingsInRegion(byRegion[region]);

      let endLoopAt = new Date();
      endLoopAt.setMinutes(endLoopAt.getMinutes() + 5);
      log.debug({inRegion: inRegion || 'empty, darn', endLoopAt}, 'about to do a loop');
      while (new Date() < endLoopAt && inRegion.length > 0) {
        log.info('asking to spawn instance');
        let toSpawn = inRegion.shift();

        try {
          await this.spawn(toSpawn.workerType, toSpawn.bid);
        } catch (err) {
          rLog.error({
            err, workerType: toSpawn.workerType.workerType, bid: toSpawn.bid,
          }, 'error submitting spot request');
        }
      }

      rLog.info('finished submiting spot requests in region');
    }));

    log.info('finished submiting spot requests');

    let duration = new Date() - allProvisionerStart;
    log.info({duration}, 'provisioning iteration complete');
    this.reportAllProvisioningIterationDuration({
      provisionerId: this.provisionerId,
      duration: duration,
    });
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
    let pendingCapacity = this.awsManager.capacityForType(workerType, ['pending', 'spotReq']);

    let change = workerType.determineCapacityChange(runningCapacity, pendingCapacity, pendingTasks);

    // Report on the stats for this iteration
    this.reportProvisioningIteration({
      provisionerId: this.provisionerId,
      workerType: workerType.workerType,
      pendingTasks: pendingTasks,
      runningCapacity: runningCapacity,
      pendingCapacity: pendingCapacity,
      change: change,
    });

    return change;
  }

}

module.exports.Provisioner = Provisioner;
