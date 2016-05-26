var workerType = require('../lib/worker-type');
var workerState = require('../lib/worker-state');
var helper = require('./helper');
var slugid = require('slugid');
var assume = require('assume');
var debug = require('debug')('test');
var _ = require('lodash');
var mock = require('./mock-workers');
var config = require('typed-env-config')();

// for convenience
// var makeRegion = mock.makeRegion;
// var makeInstanceType = mock.makeInstanceType;
var makeWorkerType = mock.makeWorkerType;
var makeWorkerState = mock.makeWorkerState;

describe('provisioner worker type api', () => {

  var id = slugid.v4();
  var workerTypeDefinition = makeWorkerType();
  var workerTypeChanged = _.clone(workerTypeDefinition);
  workerTypeChanged.maxCapacity = 15;

  it('should be able to create a worker (idempotent)', async () => {
    debug('### Create workerType');
    await helper.awsProvisioner.createWorkerType(id, workerTypeDefinition);

    debug('### Create workerType (again)');
    await helper.awsProvisioner.createWorkerType(id, workerTypeDefinition);
  });

  it('should be able to update a worker', async () => {
    debug('### Load workerType');
    var wType = await helper.awsProvisioner.workerType(id);
    assume(wType.maxCapacity).equals(20);

    debug('### Update workerType');
    try {
      await helper.awsProvisioner.updateWorkerType(id, workerTypeChanged);
    } catch (e) {
      console.log(JSON.stringify(e));
      throw e;
    }

    debug('### Load workerType (again)');
    wType = await helper.awsProvisioner.workerType(id);
    assume(wType.maxCapacity).equals(15);
  });

  it('should be able to remove a worker (idempotent)', async () => {
    debug('### Remove workerType');
    await helper.awsProvisioner.removeWorkerType(id);
    await helper.awsProvisioner.removeWorkerType(id);

    debug('### Try to load workerType');
    try {
      await helper.awsProvisioner.workerType(id);
      throw new Error('Expected and error');
    } catch (err) {
      assume(err.statusCode).equals(404);
    }
  });
});

describe('worker-type API methods', () => {
  let WorkerType;
  let WorkerState;
  let wt;
  let testWorkerType;
  let testWorkerState;

  let cleanTables = async () => {
    // remove all rows from either table
    await WorkerType.scan({}, {
      handler: async (item) => { await item.remove();  },
    });
    await WorkerState.scan({}, {
      handler: async (item) => { await item.remove();  },
    });
  };

  before(async () => {
    let allowedRegions = config.app.allowedRegions.split(',');
    let keyPrefix = config.app.awsKeyPrefix;
    let pubKey = config.app.awsInstancePubkey;
    let provisionerId = config.app.id;
    let provisionerBaseUrl = config.server.publicUrl + '/v1';
    let maxInstanceLife = config.app.maxInstanceLife;

    WorkerType = workerType.setup({
      table: config.app.workerTypeTableName,
      credentials: config.azure,
      context: {
        keyPrefix: keyPrefix,
        provisionerId: provisionerId,
        provisionerBaseUrl: provisionerBaseUrl,
        pubKey: pubKey,
      },
    });

    WorkerState = workerState.setup({
      table: config.app.workerStateTableName,
      credentials: config.azure,
    });

    await Promise.all([
      WorkerType.ensureTable(),
      WorkerState.ensureTable(),
    ]);

    await cleanTables();

    wt = slugid.nice();
    testWorkerType = makeWorkerType({
      lastModified: new Date(),
    });
    testWorkerState = makeWorkerState({
      workerType: wt,
      instances: [
        {type: 'c3.xlarge', state: 'running'},
        {type: 'c3.2xlarge', state: 'running'},
        {type: 'c3.xlarge', state: 'pending'},
        {type: 'c3.xlarge', state: 'error'},
      ],
      requests: [
        {type: 'c3.xlarge', status: 'waiting'},
        {type: 'c3.2xlarge', status: 'waiting'},
        {type: 'c3.2xlarge', status: 'waiting'},
        {type: 'c3.xlarge', status: 'waiting'},
        {type: 'c9.yuuuge', status: 'waiting'},
      ],
      internalTrackedRequests: [],
    });

  });

  afterEach(async () => {
    await cleanTables();
  });

  describe('listWorkerTypeSummaries()', () => {
    it('should return correctly calculated summary values for a defined workerType',
      async () => {
        await WorkerType.create(wt, testWorkerType);
        await WorkerState.create(testWorkerState);

        let summaries = await helper.awsProvisioner.listWorkerTypeSummaries();
        assume(summaries).to.deeply.equal([{
          workerType: wt,
          minCapacity: 0,
          maxCapacity: 20,
          requestedCapacity: 6,
          pendingCapacity: 1,
          runningCapacity: 3,
        }]);
      });

    it('should return empty summary values for a workerType without state',
      async () => {
        await WorkerType.create(wt, testWorkerType);

        let summaries = await helper.awsProvisioner.listWorkerTypeSummaries();
        assume(summaries).to.deeply.equal([{
          workerType: wt,
          minCapacity: 0,
          maxCapacity: 20,
          requestedCapacity: 0,
          pendingCapacity: 0,
          runningCapacity: 0,
        }]);
      });
  });

  describe('state()', () => {
    it('should return 404 for a nonexistent workerType', async () => {
      try {
        await helper.awsProvisioner.state('no-such');
        assume(false);
      } catch (err) {
        assume(err.statusCode).equals(404);
      }
    });

    it('should return a list of instances and a summary', async () => {
      await WorkerType.create(wt, testWorkerType);
      await WorkerState.create(testWorkerState);

      assume(await helper.awsProvisioner.state(wt)).to.deeply.equal({
        workerType: wt,
        instances: testWorkerState.instances,
        requests: testWorkerState.requests,
        internalTrackedRequests: testWorkerState.internalTrackedRequests,
        summary: {
          workerType: wt,
          minCapacity: 0,
          maxCapacity: 20,
          requestedCapacity: 6,
          pendingCapacity: 1,
          runningCapacity: 3,
        },
      });
    });

    it('should return an empty (but not 404) response when no state is available',
      async () => {
        await WorkerType.create(wt, testWorkerType);

        assume(await helper.awsProvisioner.state(wt)).to.deeply.equal({
          workerType: wt,
          instances: [],
          requests: [],
          internalTrackedRequests: [],
          summary: {
            workerType: wt,
            minCapacity: 0,
            maxCapacity: 20,
            requestedCapacity: 0,
            pendingCapacity: 0,
            runningCapacity: 0,
          },
        });
      });
  });
});
