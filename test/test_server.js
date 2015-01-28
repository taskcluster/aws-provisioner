describe('provisioner api server', function() {
  var Promise = require('promise');
  var assert = require('assert');
  var debug = require('debug')('auth:test:api');
  var helper = require('./helper');
  var slugid = require('slugid');
  var should = require('should');
  var _ = require('lodash');
  var data = require('../provisioner/data.js');

  var subject = helper.setup({title: "api-tests"});

  var wDefinition = {
    "launchSpecification": {
      "ImageId": "ami-fd2b60cd",
      "InstanceType": "r3.xlarge",
      "SecurityGroups": [
        "docker-worker"
      ],
      "UserData": "eyJjYXBhY2l0eSI6NSwid29ya2VyVHlwZSI6ImdhaWEiLCJwcm92aXNpb25lcklkIjoiYXdzLXByb3Zpc2lvbmVyIiwicmVnaXN0cmllcyI6eyJxdWF5LmlvL3Rhc2tjbHVzdGVyX3Rlc3QiOnsidXNlcm5hbWUiOiJ0YXNrY2x1c3Rlcl90ZXN0K2psYWwiLCJwYXNzd29yZCI6IldGTDUzS1U2S1NCODNRVUFDMVdET1Q0UzhUT1NGTDdWMU9WUFNPVkJUVVdTRElCMDdUMDlWMFEzUkJDTURBNTIifX0sInBhcGVydHJhaWwiOnsiZGVzaW50YXRpb24iOnsicG9ydCI6MjIzOTV9fX0="
    },
    "scalingRatio": 1,
    "maxInstances": 100,
    "minSpotBid": 2,
    "maxSpotBid": 2200,
    "minInstances": 1,
    "canUseOndemand": true,
    "canUseSpot": true,
    "allowedInstanceTypes": ["john"],
    "allowedRegions": ["us-west-2"]
  } 

  it('should respond to ping', function() {
    return subject.awsProvisioner.ping();
  });

  describe('bad input', function() {
    it('should cause failure when creating', function () {
      var wName = 'createBadInput';
      return subject.awsProvisioner
        .createWorkerType(wName, {bad: 'worker'})
        .then(function(result) {
          throw new Error('should have failed here');
        },
        function(error) {
          error.should.be.an.Error;
        }
      );
    });
    it('should cause failure when creating', function () {
      var wName = 'createBadInput';
      return subject.awsProvisioner
        .updateWorkerType(wName, {bad: 'worker'})
        .then(function(result) {
          throw new Error('should have failed here');
        },
        function(error) {
          error.should.be.an.Error;
        }
      );
    });

    it('should fail when workertype is not found', function() {
      return subject.awsProvisioner.workerType('akdsfjlaksdjfl')
        .then(function() { throw new Error('should have failed'); },
          function(err) { err.should.be.an.Error; });
    });
  });

  // TODO: Write tests to check that auth works for real on all endpoints
  it('should fail with invalid credentials', function() {
    Promise.all([
      subject.badCred.workerType('dontmatter'),
    ]).then(function(res) {
      res.forEach(function(e) {
        e.should.be.an.Error;
      });
    }, function(err) {
      console.error(err); 
    }).done();
  })
    
  describe('be able to create, fetch, update and delete a worker type', function() {
    it('should update the worker', function () {

      var wName = slugid.v4();

      // Expected object before modification
      var expectedBefore = _.clone(wDefinition, true);
      expectedBefore.workerType = wName;

      // Expected object after modification
      var expectedAfter = _.clone(wDefinition, true);
      expectedAfter.workerType = wName;
      expectedAfter.scalingRatio = 2;

      // Object to submit as the modification
      var mod = _.clone(wDefinition, true);
      mod.scalingRatio = 2;
        
      return subject.awsProvisioner.createWorkerType(wName, wDefinition)
        .then(function(result) {
          // TODO: Make sure it publishes to pulse
          result.should.eql(expectedBefore);
          return result;

        }).then(function() {
          return subject.awsProvisioner.updateWorkerType(wName, mod)
            .then(function(result) {
              // TODO: Make sure it publishes to pulse
              result.should.eql(expectedAfter);
              return result;
            });
        }).then(function() {
          return subject.awsProvisioner.workerType(wName)
            .then(function(result) {
              result.should.eql(expectedAfter);
            });
        }).then(function() {
          return subject.awsProvisioner.removeWorkerType(wName)
            .then(function(result) {
              result.should.eql({});
            })
        });
    }); 
  });

  describe('listing worker types', function() {
    it('should return a list', function() {
      return subject.awsProvisioner.listWorkerTypes()
        .then(function(result) {
          result.should.be.an.Array;  
          return result;
        });
    });
  });

});
