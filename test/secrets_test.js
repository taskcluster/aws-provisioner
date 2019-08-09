var main = require('../lib/main');
var slugid = require('slugid');
var assume = require('assume');
var taskcluster = require('taskcluster-client');
var helper = require('./helper');

describe('secrets api', () => {
  let client;

  var token = slugid.v4();
  var secretToAdd = {
    workerType: 'workerType',
    secrets: {
      key1: true,
      key2: 123,
      key3: 'sample',
      key4: {a: 123},
    },
    scopes: ['ascope'],
    token: token,
    expiration: taskcluster.fromNow('1 day'),
  };

  before(async () => {
    client = helper.getClient();
  });

  beforeEach(async () => {
    await main('tableCleaner', {process: 'tableCleaner', profile: 'test'});
  });

  it('should be able to create a secret (idempotent)', async () => {
    await client.createSecret(token, secretToAdd);
    await client.createSecret(token, secretToAdd);
  });

  it('should be able to load a secret', async () => {
    await client.createSecret(token, secretToAdd);
    var loadedSecret = await client.getSecret(token);
    assume(loadedSecret.data).to.eql(secretToAdd.secrets);
  });

  it('should not be able to load a secret that does not exist', async () => {
    try {
      await client.getSecret(token);
    } catch (err) {
      if (err.statusCode !== 404) {
        throw err;
      }
      return;
    }
    throw new Error('should have failed');
  });

  it('should not be able to load an expired secret', async () => {
    const Secret = await main('Secret', {process: 'test', profile: 'test'});
    await Secret.create({
      token,
      workerType: 'workerType',
      availabilityZones: [],
      secrets: {},
      scopes: [],
      expiration: taskcluster.fromNow('-1 minute'), // expired
    });

    try {
      var loadedSecret = await client.getSecret(token);
    } catch (err) {
      if (err.statusCode !== 404) {
        throw err;
      }
      return;
    }
    throw new Error('should have failed');
  });

  it('should not be able to load a secret twice', async () => {
    await client.createSecret(token, secretToAdd);
    await client.getSecret(token);

    try {
      await client.getSecret(token);
    } catch (err) {
      if (err.statusCode !== 404) {
        throw err;
      }
      return;
    }
    throw new Error('should have failed');
  });

  it('should be able to remove a secret (idempotent)', async () => {
    await client.createSecret(token, secretToAdd);

    await client.getSecret(token);

    await client.removeSecret(token);
    await client.removeSecret(token);

    try {
      await client.getSecret(token);
    } catch (err) {
      if (err.statusCode !== 404) {
        throw err;
      }
      return;
    }
    throw new Error('should have failed');
  });
});
