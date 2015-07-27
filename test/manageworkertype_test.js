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
    } catch(err) {
      assume(err.statusCode).equals(404);
    }
  });
});
