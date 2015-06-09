'use strict';
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

  var token = slugid.v4();
  var secretToAdd = {
    workerType: 'workerType',
    secrets: {
      key1: true,
      key2: 123,
      key3: "sample",
      key4: { a: 123},
    },
  };

  it('should be able to create a secret (idempotent)', async () => {
    await helper.awsProvisioner.createSecret(token, secretToAdd);
    await helper.awsProvisioner.createSecret(token, secretToAdd);
  });

  it('should be able to load a secret', async () => {
    var loadedSecret = await helper.awsProvisioner.getSecret(token);
    assume(loadedSecret).to.eql(secretToAdd.secrets);
  });

  it('should be able to remove a secret', async () => {
    await helper.awsProvisioner.removeSecret(token);

    try {
      await helper.awsProvisioner.getSecret(token);
      throw new Error('Expected and error');
    } catch(err) {
      assume(err.statusCode).equals(404);
    }
  });
});
