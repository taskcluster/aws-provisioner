const fakeEC2Manager = require('./mock-ec2manager');
const AwsManager = require('../lib/aws-manager');
const taskcluster = require('taskcluster-client');
const mock = require('./mock-workers');
const request = require('request-promise');
const assert = require('assert');

// for convenience
const makeRegion = mock.makeRegion;
const makeInstanceType = mock.makeInstanceType;
const makeWorkerType = mock.makeWorkerType;

function describeAvailabilityZones() {
  return {
    promise: async () => {
      return {
        AvailabilityZones: [
          {
            ZoneName: 'us-east-1a',
            ZoneState: 'available',
            RegionName: 'us-east-1',
          },
          {
            ZoneName: 'us-east-1b',
            ZoneState: 'available',
            RegionName: 'us-east-1',
          },
          {
            ZoneName: 'us-east-1c',
            ZoneState: 'available',
            RegionName: 'us-east-1',
          },
          {
            ZoneName: 'us-east-1b',
            ZoneState: 'available',
            RegionName: 'us-east-1',
          },
        ],
      };
    },
  };
}

async function createEC2ManagerClient() {
  const ec2ManagerBaseUrl = 'https://ec2-manager.herokuapp.com/v1';

  let reference = await request.get(ec2ManagerBaseUrl + '/internal/api-reference');
  reference = JSON.parse(reference);

  const clientClass = taskcluster.createClient(reference);

  const client = new clientClass({
    agent: require('http').globalAgent,
    baseUrl: ec2ManagerBaseUrl,
    credentials: {
      clientId: process.env.TASKCLUSTER_CLIENT_ID,
      accessToken: process.env.TASKCLUSTER_ACCESS_TOKEN,
    },
    timeout: 2 * 1000,
  });

  return client;
}

describe('ec2manager', () => {
  let server;

  before(() => {
    // run our fake ec2-manager server
    server = fakeEC2Manager();
  });

  after(() => {
    server.close();
  });

  it('price update', async () => {
    const workerType = makeWorkerType({
      lastModified: new Date(),
      regions: [makeRegion({region: 'us-east-1'})],
      instanceTypes: [makeInstanceType()],
    });

    const manager = new AwsManager(
      {
        'us-east-1': {
          describeAvailabilityZones,
          config: {
            region: 'us-east-1',
          },
          serviceIdentifier: 'aws-provisioner-test',
        },
      },
      'aws-provisioner-v1',
      {},
      await createEC2ManagerClient(),
      'test',
      'mypubkey',
    );

    await manager.update();
    const bids = workerType.determineSpotBids(
      ['us-east-1'],
      manager.__pricing,
      1,
    );

    assert.deepEqual(
      bids[0],
      {
        price: 0.04,
        truePrice: 0.02,
        region: 'us-east-1',
        type: 't1.micro',
        zone: 'us-east-1e',
      },
    );
  });
});
