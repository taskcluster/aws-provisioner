let workerType = require('../lib/worker-type');
let workerState = require('../lib/worker-state');
var assume = require('assume');
var helper = require('./helper');
var slugid = require('slugid');
var assume = require('assume');
var taskcluster = require('taskcluster-client');
var _ = require('lodash');

describe('worker-type API methods', () => {
  let WorkerType, WorkerState, wt;

  let cleanTables = async () => {
    // remove all rows from either table
    await WorkerType.scan({} , {
      handler: async (item) => { await item.remove();  },
    });
    await WorkerState.scan({} , {
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
  });

  afterEach(async () => {
    await cleanTables();
  });

  let addTestWorkerType = async () => {
    await WorkerType.create(wt, {
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
    });
    await WorkerState.create({
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
    }, true);
  };

  describe('listWorkerTypeSummaries()', () => {
    it('should return correctly calculated summary values for a defined workerType', async () => {
      await addTestWorkerType();

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
  });
});
