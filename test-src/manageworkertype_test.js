let workerType = require('../lib/worker-type');
let workerState = require('../lib/worker-state');
var helper = require('./helper');
var slugid = require('slugid');
var assume = require('assume');
var debug = require('debug')('test');
var _ = require('lodash');
var mock = require('./mock-workers');

// for convenience
// var makeRegion = mock.makeRegion;
// var makeInstanceType = mock.makeInstanceType;
var makeWorkerType = mock.makeWorkerType;

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
  let WorkerType, WorkerState, wt, testWorkerType, testWorkerState;

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
    WorkerState = workerState.setup({
      table: helper.cfg.get('provisioner:workerStateTableName'),
      credentials: helper.cfg.get('azure'),
    });

    let keyPrefix = helper.cfg.get('provisioner:awsKeyPrefix');
    let pubKey = helper.cfg.get('provisioner:awsInstancePubkey');
    let provisionerId = helper.cfg.get('provisioner:id');
    let provisionerBaseUrl = helper.cfg.get('server:publicUrl') + '/v1';
    WorkerType = workerType.setup({
      table: helper.cfg.get('provisioner:workerTypeTableName'),
      credentials: helper.cfg.get('azure'),
      context: {keyPrefix, provisionerId, provisionerBaseUrl, pubKey},
    });

    await WorkerState.ensureTable();
    await WorkerType.ensureTable();
    await cleanTables();

    wt = slugid.nice();
    testWorkerType = {
      description: 'a worker type',
      owner: 'me',
      launchSpecification: {},
      minCapacity: 0,
      maxCapacity: 100,
      scalingRatio: 1.0,
      minPrice: 0.0,
      maxPrice: 1.0,
      canUseOndemand: true,
      canUseSpot: true,
      instanceTypes: [
        {instanceType: 'm1', capacity: 1},
        {instanceType: 'm2', capacity: 2},
      ],
      regions: [],
      lastModified: new Date(),
      userData: {},
      launchSpec: {},
      secrets: {},
      scopes: [],
    };
    testWorkerState = {
      workerType: wt,
      instances: [
        {
          id: 'i-1',
          srId: 'sir-1',
          ami: 'ami-123',
          region: 'us-north-7',
          zone: 'j',
          launchTime: '2016-04-11T20:55:47.987Z',
          type: 'm1',
          state: 'running',
        }, {
          id: 'i-2',
          srId: 'sir-2',
          ami: 'ami-123',
          region: 'us-north-7',
          zone: 'j',
          launchTime: '2016-04-11T20:55:47.987Z',
          type: 'm2',
          state: 'running',
        }, {
          id: 'i-3',
          srId: 'sir-3',
          ami: 'ami-123',
          region: 'us-north-7',
          zone: 'j',
          launchTime: '2016-04-11T20:55:47.987Z',
          type: 'm1',
          state: 'pending',
        }, {
          id: 'i-4',
          srId: 'sir-4',
          ami: 'ami-123',
          region: 'us-north-7',
          zone: 'j',
          launchTime: '2016-04-11T20:55:47.987Z',
          type: 'm1',
          state: 'error',
        },
      ],
      requests: [
        {
          id: 'sir-11',
          ami: 'ami-123',
          type: 'm1',
          region: 'us-north-8',
          zone: 'w',
          status: 'waiting',
          time: '2016-03-11T20:55:47.987Z',
        }, {
          id: 'sir-12',
          ami: 'ami-123',
          type: 'm2',
          region: 'us-north-8',
          zone: 'w',
          status: 'waiting',
          time: '2016-03-11T20:55:47.987Z',
        }, {
          id: 'sir-13',
          ami: 'ami-123',
          type: 'm2',
          region: 'us-north-8',
          zone: 'w',
          status: 'waiting',
          time: '2016-03-11T20:55:47.987Z',
        }, {
          id: 'sir-14',
          ami: 'ami-123',
          type: 'm1',
          region: 'us-north-8',
          zone: 'w',
          status: 'waiting',
          time: '2016-03-11T20:55:47.987Z',
        }, {
          id: 'sir-15',
          ami: 'ami-123',
          type: 'm9',
          region: 'us-north-8',
          zone: 'w',
          status: 'waiting',
          time: '2016-03-11T20:55:47.987Z',
        },
      ],
      internalTrackedRequests: [],
    };

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
          maxCapacity: 100,
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
          maxCapacity: 100,
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
          minCapacity: 0,
          maxCapacity: 100,
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
            minCapacity: 0,
            maxCapacity: 100,
            requestedCapacity: 0,
            pendingCapacity: 0,
            runningCapacity: 0,
          },
        });
      });
  });
});
