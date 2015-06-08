'use strict';

describe('provisioner api server', function () {
  var subject = require('./helper');
  var slugid = require('slugid');
  var _ = require('lodash');
  var fs = require('fs');
  var path = require('path');

  var wDefinition = JSON.parse(fs.readFileSync(path.join(__dirname, 'sampleWorkerType.json')));

  var wDefinitionForCreate = _.cloneDeep(wDefinition);
  delete wDefinitionForCreate.workerType;

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

  describe('be able to create, fetch, update and delete a worker type', function () {
    it('should work', function () {

      var wName = slugid.v4();

      // Expected object before modification
      var expectedBefore = _.cloneDeep(wDefinitionForCreate, true);
      expectedBefore.workerType = wName;

      // Expected object after modification
      var expectedAfter = _.cloneDeep(wDefinitionForCreate, true);
      expectedAfter.workerType = wName;
      expectedAfter.scalingRatio = 2;

      // Object to submit as the modification
      var mod = _.cloneDeep(wDefinitionForCreate, true);
      mod.scalingRatio = 2;

      var p = subject.awsProvisioner.createWorkerType(wName, wDefinitionForCreate);

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

      return p;
    });
  });

  describe('listing worker types', function () {
    it('should return a list', function () {
      var p = subject.awsProvisioner.listWorkerTypes();

      p = p.then(function (result) {
        result.should.be.an.Array; //eslint-disable-line no-unused-expressions
        return result;
      });

      return p;
    });
  });

  describe('showing all launch specs', function () {
    it('should show all launch specs', function () {
      var wName = slugid.v4();

      var p = subject.awsProvisioner.createWorkerType(wName, wDefinitionForCreate);

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

});
