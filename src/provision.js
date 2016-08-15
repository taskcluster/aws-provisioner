let log = require('./log');
let debug = log.debugCompat('aws-provisioner:provision');
let assert = require('assert');
let WatchDog = require('./watchdog');
let taskcluster = require('taskcluster-client');
let delayer = require('./delayer');
let shuffle = require('knuth-shuffle');
let Biaser = require('./biaser.js');
let rp = require('request-promise');
let _ = require('lodash');

let series = require('./influx-series');

const MAX_PROVISION_ITERATION = 1000 * 60 * 10; // 10 minutes
const MAX_FAILURES = 15;

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

    // We need a deadman's snitch API key
    assert(cfg.dmsApiKey);
    this.dmsApiKey = cfg.dmsApiKey;

    // We need a URL to hit
    assert(cfg.iterationSnitch);
    this.iterationSnitch = cfg.iterationSnitch;

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

    // This is the number of milliseconds to wait between completed provisioning runs
    assert(cfg.provisionIterationInterval);
    assert(typeof cfg.provisionIterationInterval === 'number');
    assert(!isNaN(cfg.provisionIterationInterval));
    this.provisionIterationInterval = cfg.provisionIterationInterval;

    this.__provRunId = 0;

    this.__keepRunning = false;
    this.__watchDog = new WatchDog(MAX_PROVISION_ITERATION);
    this.__stats = {
      runs: 0,
      consecFail: 0,
    };
  }

  /**
   * Start running a provisioner.
   */
  async run() {
    this.__keepRunning = true;

    this.__watchDog.on('expired', () => {
      debug('[alert-operator] provisioning iteration exceeded max time');
      process.exit(1); //eslint-disable-line no-process-exit
    });

    this.__watchDog.start();

    const d = delayer(this.provisionIterationInterval);

    try {
      do {
        debug('starting iteration %d, consecutive failures %d',
              this.__stats.runs, this.__stats.consecFail);

        // If we don't do this, we'll have an uncaught exception
        this.__watchDog.touch();

        // We should make sure that we're not just permanently failing
        // We also don't want to
        if (this.__stats.consecFail > MAX_FAILURES) {
          debug('exiting because there have been too many failures');
          process.exit(1); //eslint-disable-line no-process-exit
        }

        let outcome;

        this.__stats.runs++;

        // Do the iterations
        try {
          debug('about to run provisioning for each worker type');
          await this.runAllProvisionersOnce();
          debug('about to run provisioning for each worker type');
          this.__stats.consecFail = 0;
          outcome = 'succeeded';

        } catch (err) {
          this.__stats.consecFail++;
          outcome = 'failed';
          debug('[alert-operator] provisioning iteration failure');
          if (err.stack) {
            debug(err.stack);
          }
        }

        // Report on the iteration
        debug('provisioning iteration %s', outcome);
        debug('scheduling next iteration in %sms',
            this.provisionIterationInterval);
        // Hit the deadmans snitch URL to say that the iteration worked
        debug('hitting deadmans snitch');
        try {
          let result = await rp.get(this.iterationSnitch, {
            auth: {
              username: this.dmsApiKey,
              password: '',
              sendImmediately: true,
            },
          });
        } catch (err) {
          console.log(err.stack || err);
        }
        debug('hit deadmans snitch');

        // And delay for the next one so we don't overwhelm EC2
        await d();

      } while (this.__keepRunning && !process.env.PROVISION_ONCE);
      this.__watchDog.stop();
    } catch (err) {
      debug('error trying to run all provisioners once, exiting');
      debug(err);
      if (err.stack) {
        debug(err.stack);
      }
      process.exit(1); //eslint-disable-line no-process-exit
    }
  }

  /**
   * Stop launching new provisioner iterations but don't
   * end the current one
   */
  stop() {
    this.__keepRunning = false;
    this.__watchDog.stop();
    this.__stats.runs = 0;
    this.__stats.consecFail = 0;
  }

  /**
   * Run provisioners for all known worker types once
   */
  async runAllProvisionersOnce() {
    let allProvisionerStart = new Date();
    let workerTypes;
    debug('loading worker types');
    workerTypes = await this.WorkerType.loadAll();
    debug('loaded worker types');

    debug('updating aws state');
    await this.awsManager.update();
    debug('updated aws state');

    try {
      debug('fetching biasing information');
      await this.biaser.fetchBiasInfo(this.awsManager.availableAZ(), []);
      debug('fetched biasing information');
    } catch (err) {
      debug('error fetching biasing information');
      debug(err);
      if (err.stack) {
        debug(err.stack);
      }
    }

    let workerNames = workerTypes.map(w => w.workerType);

    try {
      await this.awsManager.ensureTags();
      debug('ensured resource tagging');
      await this.awsManager.rogueKiller(workerNames);
      debug('ran rogue killer');
      await this.awsManager.zombieKiller();
      debug('ran zombie killer');
    } catch (err) {
      debug('failure running a housekeeping task');
      debug(err);
      if (err.stack) {
        debug(err.stack);
      }
    }

    debug('configured workers: %j', workerNames);
    debug('managed workers: %j', this.awsManager.knownWorkerTypes());

    let forSpawning = [];

    for (let worker of workerTypes) {
      debug('determining change for %s', worker.workerType);
      let change = await this.changeForType(worker);
      debug('determined change for %s to be %d', worker.workerType, change);

      // This is a slightly modified version of the aws objects
      // which are made smaller to fit into azure storage entities

      try {
        // This does create a bunch of extra logs... darn!
        let state = this.awsManager.stateForStorage(worker.workerType);

        await this.stateContainer.write(worker.workerType, state);
      } catch (stateWriteErr) {
        debug('[alert-operator] failed to update state for %s: %s',
            worker.workerType, stateWriteErr.stack || stateWriteErr);
      }

      if (change > 0) {
        debug('creating %d capacity for %s', change, worker.workerType);
        let bids = worker.determineSpotBids(
            _.keys(this.awsManager.ec2),
            this.awsManager.__pricing,
            change,
            this.biaser);
        // This could probably be done cleaner
        for (let bid of bids) {
          forSpawning.push({workerType: worker, bid: bid});
        }
      } else if (change < 0) {
        let capToKill = -change;
        debug('destroying %d for %s', capToKill, worker.workerType);
        try {
          await this.awsManager.killCapacityOfWorkerType(
                worker, capToKill, ['pending', 'spotReq']);
        } catch (killCapErr) {
          debug('[alert-operator] error running the capacity killer');
          debug(killCapErr.stack || killCapErr);
          throw killCapErr;
        }
      } else {
        debug('no changes needed for %s', worker.workerType);
      }
    }

    const d = delayer(500);
    const longD = delayer(2000);

    // We want to shuffle up the bids so that we don't prioritize
    // any particular worker type
    forSpawning = shuffle.knuthShuffle(forSpawning);

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

    log.info('submitting all spawn requests');

    await Promise.all(_.map(byRegion, async(toSpawn, region) => {
      let rLog = log.child({region});
      rLog.info('submitting spot requests in region');
      let inRegion = byRegion[region];
      inRegion = inRegion.slice(0, 400);

      for (let toSpawn of inRegion) {
        try {
          rLog.info({
            workerType: toSpawn.workerType.workerType, bid: toSpawn.bid
          }, 'submitting spot request');

          await this.spawn(toSpawn.workerType, toSpawn.bid);
          await d();
          rLog.info({
            workerType: toSpawn.workerType.workerType, bid: toSpawn.bid
          }, 'finished submitting spot request');
        } catch (err) {
          rLog.err({
            err, workerType: toSpawn.workerType.workerType, bid: toSpawn.bid
          }, 'finished submitting spot request');
        }
      }

      rLog.info('finished submitting spot requests in region');
    }));

    log.info('submitted all spawn requests');

    await this.awsManager.saveAwsManagerInternalState();

    let duration = new Date() - allProvisionerStart;
    debug('running all provisioning iterations took ' + duration + 'ms');
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

    debug('creating secret %s', launchInfo.securityToken);
    await this.Secret.create({
      token: launchInfo.securityToken,
      workerType: workerType.workerType,
      secrets: launchInfo.secrets,
      scopes: launchInfo.scopes,
      expiration: taskcluster.fromNow('40 minutes'),
    });
    debug('created secret %s', launchInfo.securityToken);

    debug('requestion spot instance with launch info %j and bid %j', launchInfo, bid);

    return this.awsManager.requestSpotInstance(launchInfo, bid);
  };

  /**
   * Determine the change for a given worker type
   */
  async changeForType(workerType) {
    let result;
    debug('getting pending tasks for %s', workerType.workerType);
    result = await this.queue.pendingTasks(this.provisionerId, workerType.workerType);
    let pendingTasks = result.pendingTasks;
    debug('got pending tasks for %s: %d', workerType.workerType, pendingTasks);

    let runningCapacity = this.awsManager.capacityForType(workerType, ['running']);
    let pendingCapacity = this.awsManager.capacityForType(workerType, ['pending', 'spotReq']);
    let change = workerType.determineCapacityChange(
        runningCapacity, pendingCapacity, pendingTasks);
    debug('stats for %s: %d running capacity, %d pending capacity and %d pending tasks',
        workerType.workerType, runningCapacity, pendingCapacity, pendingTasks);

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
