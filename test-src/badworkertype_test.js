suite('Bad WorkerType definitions', () => {
  var main = require('../lib/main');
  var helper = require('./helper');
  var slugid = require('slugid');
  var assume = require('assume');

  // Worker type with invalid launchspecification
  var invalidLaunchSpecWorkerType = {
    launchSpecification: {
      ImageId: 'ami-shouldntbehere',
      InstanceType: 'shouldntbehere',
      SecurityGroups: [
        'default',
      ],
      UserData: 'am9obg==',
    },
    minCapacity: 4,
    maxCapacity: 30,
    scalingRatio: 1.1,
    minPrice: 0.2,
    maxPrice: 1,
    canUseOndemand: false,
    canUseSpot: true,
    instanceTypes: [
      {
        instanceType: 'm3.medium',
        capacity: 1,
        utility: 1,
        overwrites: {
          ImageId: 'shouldntbehere',
          UserData: 'am8obh==',
        },
      },
    ],
  };

  let client;

  before(async () => {
    client = helper.getClient();
  });

  beforeEach(async () => {
    await main('tableCleaner', {process: 'tableCleaner', profile: 'test'});
  });

  test('Should cause failure when creating', async () => {
    try {
      await client.createWorkerType('createBadInput', {
        bad: 'input',
      });
      throw new Error('Expected and error');
    } catch (err) {
      assume(err.statusCode).is.between(400, 499);
    }
  });

  test('should cause failure when updating', async () => {
    try {
      await client.updateWorkerType('createBadInput', {
        bad: 'input',
      });
      throw new Error('Expected and error');
    } catch (err) {
      assume(err.statusCode).is.between(400, 499);
    }
  });

  test('Fail when launch specs cannot be generated on create', async () => {
    try {
      await client.createWorkerType(
        'invalid', invalidLaunchSpecWorkerType
      );
      throw new Error('Expected and error');
    } catch (err) {
      assume(err.statusCode).is.between(400, 499);
    }
  });

  test('should fail when workertype is not found', async () => {
    try {
      await client.workerType(slugid.v4());
      throw new Error('Expected and error');
    } catch (err) {
      assume(err.statusCode).is.between(400, 499);
    }
  });
});
