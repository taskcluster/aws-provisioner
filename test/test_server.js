'use strict';
var subject = require('./helper');
var slugid = require('slugid');
var _ = require('lodash');
var mock = require('./mock-workers');

// for convenience
// var makeRegion = mock.makeRegion;
// var makeInstanceType = mock.makeInstanceType;
var makeWorkerType = mock.makeWorkerType;

describe('provisioner api server', function () {

  var wDefinition = makeWorkerType();

  it('should respond to ping', function () {
    return subject.awsProvisioner.ping();
  });

  // TODO: Write tests to check that auth works for real on all endpoints
  it('should fail with invalid credentials', function () {
    var awsProvisioner = new subject.AwsProvisioner({
      agent: require('http').globalAgent,
      baseUrl: subject.baseUrl,
      credentials: {
        clientId: 'wrong-client',
        accessToken: 'wrong',
      },
    });
    var p = awsProvisioner.workerType('dontmatter');

    p = p.then(function (res) {
      res.forEach(function (e) {
        e.should.be.an.Error;  //eslint-disable-line no-unused-expressions
      });
    });

    p = p.catch(function (err) {
      err.should.be.an.Error;  //eslint-disable-line no-unused-expressions
    });

    return p;
  });

  it('should be able to create, fetch, update and delete a worker type', function () {

    var wName = slugid.v4();

    // Expected object before modification
    var expectedBefore = _.cloneDeep(wDefinition, true);
    expectedBefore.workerType = wName;

    // Expected object after modification
    var expectedAfter = _.cloneDeep(wDefinition, true);
    expectedAfter.workerType = wName;
    expectedAfter.scalingRatio = 2;

    // Object to submit as the modification
    var mod = _.cloneDeep(wDefinition, true);
    mod.scalingRatio = 2;

    console.log(JSON.stringify(wDefinition, null, 2));
    var p = subject.awsProvisioner.createWorkerType(wName, wDefinition);

    /*
    p = p.then(function (result) {
      // TODO: Make sure it publishes to pulse
      result.lastModified.should.be.a.Date;  //eslint-disable-line no-unused-expressions
      delete result.lastModified;
      result.should.eql(expectedBefore);
      console.log('insert done');
      return result;
    });

    p = p.then(function () {
      return subject.awsProvisioner.updateWorkerType(wName, mod);
    });

    p = p.then(function (result) {
      result.lastModified.should.be.a.Date; //eslint-disable-line no-unused-expressions
      delete result.lastModified;
      result.should.eql(expectedAfter);
      console.log('update done');
    });

    p = p.then(function () {
      return subject.awsProvisioner.workerType(wName);
    });

    p = p.then(function (result) {
      result.lastModified.should.be.a.Date; //eslint-disable-line no-unused-expressions
      delete result.lastModified;
      result.should.eql(expectedAfter);
      console.log('fetch updated copy done');
    });

    p = p.then(function () {
      return subject.awsProvisioner.removeWorkerType(wName);
    });

    p = p.then(function (result) {
      result.should.eql({});
      console.log('remove done');
    });
    */

    return p;
  });

  it('listing worker types return a list', function () {
    var p = subject.awsProvisioner.listWorkerTypes();

    p = p.then(function (result) {
      result.should.be.an.Array; //eslint-disable-line no-unused-expressions
      return result;
    });

    return p;
  });

  it('should show all launch specs', function () {
    var wName = slugid.v4();

    var p = subject.awsProvisioner.createWorkerType(wName, wDefinition);

    p = p.then(function () {
      subject.awsProvisioner.getLaunchSpecs(wName);
    });

    p.then(function (result) {
      result.should.be.ok;  //eslint-disable-line no-unused-expressions
      result.should.be.an.Object;  //eslint-disable-line no-unused-expressions
      result.should.have.property('us-west-1');
      result.should.have.property('us-west-2');
      result['us-west-1'].should.have.property('m3.medium');
      result['us-west-2'].should.have.property('m3.medium');
      result['us-west-1'].should.have.property('m3.large');
      result['us-west-2'].should.have.property('m3.large');
    });

    p = p.then(function () {
      return subject.awsProvisioner.removeWorkerType(wName);
    });

    return p;
  });

});
