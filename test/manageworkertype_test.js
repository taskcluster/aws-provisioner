var log = require('../lib/log');
var debug = log.debugCompat('test');
var slugid = require('slugid');
var assume = require('assume');
var _ = require('lodash');
var mock = require('./mock-workers');

// for convenience
var makeRegion = mock.makeRegion;
// var makeInstanceType = mock.makeInstanceType;
var makeWorkerType = mock.makeWorkerType;
var makeWorkerState = mock.makeWorkerState;

var main = require('../lib/main');
var helper = require('./helper');

describe('provisioner worker type api', () => {

  var id = slugid.nice();
  var workerTypeDefinition = makeWorkerType();
  var workerTypeChanged = _.clone(workerTypeDefinition);
  workerTypeChanged.maxCapacity = 15;

  let WorkerType;

  let client;

  let testWorkerType = makeWorkerType({
    lastModified: new Date(),
  });

  let testWorkerState = makeWorkerState({
    workerType: id,
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
  });

  before(async () => {
    WorkerType = await main('WorkerType', {process: 'WorkerType', profile: 'test'});

    client = helper.getClient();
  });

  beforeEach(async () => {
    await main('tableCleaner', {process: 'tableCleaner', profile: 'test'});
  });

  it('should refuse to create worker with missing ami', async () => {
    let missingAmi = makeWorkerType({
      regions: [makeRegion({launchSpec: {ImageId: 'ami-abcde'}})],
    });
    try {
      await client.createWorkerType(id, missingAmi);
      return Promise.reject();
    } catch (err) {
      return Promise.resolve();
    }
  });

  it('should refuse to create worker with missing security group', async () => {
    let missingAmi = makeWorkerType({
      launchSpec: {
        SecurityGroups: ['notthere'],
      },
    });
    try {
      await client.createWorkerType(id, missingAmi);
      return Promise.reject();
    } catch (err) {
      return Promise.resolve();
    }
  });

  it('should be able to create a worker (idempotent)', async () => {
    debug('### Create workerType');
    await client.createWorkerType(id, workerTypeDefinition);

    debug('### Create workerType (again)');
    await client.createWorkerType(id, workerTypeDefinition);
  });

  it('should be able to update a worker', async () => {
    debug('### Load workerType');
    await client.createWorkerType(id, workerTypeDefinition);

    var wType = await client.workerType(id);

    assume(wType.maxCapacity).equals(20);

    debug('### Update workerType');
    try {
      await client.updateWorkerType(id, workerTypeChanged);
    } catch (e) {
      console.log(JSON.stringify(e));
      throw e;
    }

    debug('### Load workerType (again)');
    wType = await client.workerType(id);
    assume(wType.maxCapacity).equals(15);
  });

  it('should be able to get lastModified from API', async () => {
    debug('### Load workerType (again)');
    await client.createWorkerType(id, workerTypeDefinition);
    let wType = await client.workerTypeLastModified(id);
    assume(wType.workerType).equals(id);
    assume(wType.lastModified).is.Date;
  });

  it('should be able to remove a worker (idempotent)', async () => {
    debug('### Remove workerType');
    await client.removeWorkerType(id);
    await client.removeWorkerType(id);

    debug('### Try to load workerType');
    try {
      await client.workerType(id);
      throw new Error('Expected and error');
    } catch (err) {
      assume(err.statusCode).equals(404);
    }
  });

  describe('listWorkerTypeSummaries()', () => {
    it.skip('should return calculated summary values for a defined workerType',
      async () => {
        await WorkerType.create(id, testWorkerType);

        let summaries = await client.listWorkerTypeSummaries();
        assume(summaries).to.deeply.equal([{
          workerType: id,
          minCapacity: 0,
          maxCapacity: 20,
          requestedCapacity: 6,
          pendingCapacity: 1,
          runningCapacity: 3,
        }]);
      });

    it('should return empty summary values for a workerType without state',
      async () => {
        await WorkerType.create(id, testWorkerType);

        let summaries = await client.listWorkerTypeSummaries();
        assume(summaries).to.deeply.equal([{
          workerType: id,
          minCapacity: 0,
          maxCapacity: 20,
          requestedCapacity: 0,
          pendingCapacity: 0,
          runningCapacity: 0,
        }]);
      });
  });

  describe('state()', () => {
    let stateClient;
    it('should return 404 for a nonexistent workerType', async () => {
      try {
        await client.state('no-such');
        assume(false);
      } catch (err) {
        assume(err.statusCode).equals(404);
      }
    });

    it.skip('should return a list of instances and a summary', async () => {
      await WorkerType.create(id, testWorkerType);

      assume(await client.state(id)).to.deeply.equal({
        workerType: id,
        instances: testWorkerState.instances,
        requests: testWorkerState.requests,
        internalTrackedRequests: testWorkerState.internalTrackedRequests,
        summary: {
          workerType: id,
          minCapacity: 0,
          maxCapacity: 20,
          requestedCapacity: 6,
          pendingCapacity: 1,
          runningCapacity: 3,
        },
      });
    });

    it('should return an empty (but not 404) response when no state is available', async () => {
      await WorkerType.create(id, testWorkerType);

      assume(await client.state(id)).to.deeply.equal({
        workerType: id,
        instances: [],
        requests: [],
        internalTrackedRequests: [],
        summary: {
          workerType: id,
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
