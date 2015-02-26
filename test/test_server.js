describe('provisioner api server', function() {
  var Promise = require('promise');
  var assert = require('assert');
  var debug = require('debug')('auth:test:api');
  var helper = require('./helper');
  var slugid = require('slugid');
  var should = require('should');
  var _ = require('lodash');
  var data = require('../provisioner/data.js');
  var fs = require('fs');

  var subject = helper.setup({title: "api-tests"});


  var wDefinition = JSON.parse(fs.readFileSync(__dirname + '/sampleWorkerType.json'));
  var invalidLaunchSpecs =
    JSON.parse(fs.readFileSync(__dirname + '/invalidLaunchSpecOptions.json'));

  var wDefinitionForCreate = _.clone(wDefinition);
  delete wDefinitionForCreate['workerType'];

  it('should respond to ping', function() {
    return subject.awsProvisioner.ping();
  });

  describe('bad input', function() {
    it('should cause failure when creating', function () {
      var wName = 'createBadInput';

      var p = subject.awsProvisioner.createWorkerType(wName, {bad: 'worker'});

      p = p.then(function(result) {
        throw new Error('should have failed here');
      });

      p = p.catch(function(error) {
        error.should.be.an.Error;
      });

      return p;
    });

    it('should cause failure when updating', function () {
      var wName = 'createBadInput';

      var p = subject.awsProvisioner.updateWorkerType(wName, {bad: 'worker'});

      p = p.then(function(result) {
        throw new Error('should have failed here');
      });

      p = p.catch(function(error) {
        error.should.be.an.Error;
      });

      return p;
    });

    it('should fail when launch specs cannot be generated on create', function() {
      var p = subject.awsProvisioner.createWorkerType('invalid', invalidLaunchSpecs);

      p = p.then(function(result) {
        throw new Error('should have failed here'); 
      });

      p = p.catch(function(err) {
        err.should.be.an.Error; 
        err.body.reason.should.be.an.Array;
        err.body.reason.length.should.equal(4);
      });

      return p;
    });

    it('should fail when workertype is not found', function() {
      var p = subject.awsProvisioner.workerType('akdsfjlaksdjfl');

      p = p.then(function() {
        throw new Error('should have failed');
      });

      p = p.catch(function(err) {
        err.should.be.an.Error;
      });

      return p;
    });
  });

  // TODO: Write tests to check that auth works for real on all endpoints
  it('should fail with invalid credentials', function() {
    var p = Promise.all([
      subject.badCred.workerType('dontmatter'),
    ]);

    p = p.then(function(res) {
      res.forEach(function(e) {
        e.should.be.an.Error;
      });
    });

    p = p.catch(function(err) {
      err.should.be.an.Error;
    })
    
    return p;;
  })
    
  describe('be able to create, fetch, update and delete a worker type', function() {
    it('should work', function () {

      var wName = slugid.v4();

      // Expected object before modification
      var expectedBefore = _.clone(wDefinitionForCreate, true);
      expectedBefore.workerType = wName;

      // Expected object after modification
      var expectedAfter = _.clone(wDefinitionForCreate, true);
      expectedAfter.workerType = wName;
      expectedAfter.scalingRatio = 2;

      // Object to submit as the modification
      var mod = _.clone(wDefinitionForCreate, true);
      mod.scalingRatio = 2;
        
      var p = subject.awsProvisioner.createWorkerType(wName, wDefinitionForCreate);

      p = p.then(function(result) {
        // TODO: Make sure it publishes to pulse
        result.should.eql(expectedBefore);
        console.log('insert done');
        return result;
      });

      p = p.then(function() {
        return subject.awsProvisioner.updateWorkerType(wName, mod);
      });

      p = p.then(function(result) {
        result.should.eql(expectedAfter);
        console.log('update done');
      });

      p = p.then(function() {
        return subject.awsProvisioner.workerType(wName);
      });

      p = p.then(function(result) {
        result.should.eql(expectedAfter);
        console.log('fetch updated copy done');
      });

      p = p.then(function() {
        return subject.awsProvisioner.removeWorkerType(wName);
      });

      p = p.then(function(result) {
        result.should.eql({});
        console.log('remove done');
      });

      return p;
    }); 
  });

  describe('listing worker types', function() {
    it('should return a list', function() {
      var p = subject.awsProvisioner.listWorkerTypes();

      p = p.then(function(result) {
        result.should.be.an.Array;  
        return result;
      });

      return p;
    });
  });

  describe('showing all launch specs', function() {
    it('should show all launch specs', function() {
      var wName = slugid.v4();
        
      var p = subject.awsProvisioner.createWorkerType(wName, wDefinitionForCreate);

      p = p.then(function() {
        subject.awsProvisioner.getLaunchSpecs(wName);
      });

      p.then(function(result) {
        result.should.be.an.Object;
        result.should.have.property('us-west-1');
        result.should.have.property('us-west-2');
        result['us-west-1'].should.have.property('m3.medium');
        result['us-west-2'].should.have.property('m3.medium');
        result['us-west-1'].should.have.property('m3.large');
        result['us-west-2'].should.have.property('m3.large');
      });

      p = p.then(function() {
        return subject.awsProvisioner.removeWorkerType(wName);
      });

      return p;
    });
  });

})
