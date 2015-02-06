var Promise = require('promise');
var assert = require('assert');
var debug = require('debug')('provisioner:test:provison');
var helper = require('./helper');
var slugid = require('slugid');
var should = require('should');
var lodash = require('lodash');
var data = require('../provisioner/data.js');
var sinon = require('sinon');

var provision = require('../provisioner/provision');

var sampleWorkerType = require('./sampleWorkerType.json');
var invalidUserDataWorkerType = require('./invalidUserDataWorkerType.json');

describe('determineCapacityChange', function() {
  var subject = provision._determineCapacityChange;

  describe('without scaling ratio', function() {
    it('should not change the number of nodes needed', function() {
      subject(1, 100, 0).should.equal(0);
    });

    it('should increase number of nodes needed by number of pending', function() {
      [1,2,3,4,5,6,100,10000].forEach(function(x) {
        subject(1, 100, x).should.equal(x);
      });
    });
  });

  describe('with scaling ratios', function() {
    it('should increase number of nodes only when there are enough pending tasks', function() {
      subject(1.1, 100, 0).should.equal(0);
      subject(1.1, 100, 9).should.equal(0);
      subject(1.1, 100, 10).should.equal(0);
      subject(1.1, 100, 11).should.equal(1);
      subject(1.1, 100, 12).should.equal(2);
      subject(1.1, 100, 100).should.equal(82);
    });

  });
});

/*
describe('countRunningCapacity', function() {
  var subject = provision._countRunningCapacity;

  var fakeWorkerType = {
    allowedInstanceTypes: {
      'small': {
        'capacity': 1,
      },
      'large': {
        'capacity': 2,
      }
    }
  };

  describe('should be able to count running instances', function() {
    it('should work with only instances', function(done) {
      var expected = 3;
      var fakeState = {
        running: [{InstanceType: 'small'},{InstanceType: 'large'}],
        pending: [],
        spotRequested: [],
      };
      subject(fakeWorkerType, fakeState).then(function(actual) {
        expected.should.equal(actual);
        done();
      }).done();
    });

    it('should count 0 instance when none are running', function(done) {
      var expected = 0;
      var fakeState = {
        running: [],
        pending: [],
        spotRequested: [],
      };
      subject(fakeWorkerType, fakeState).then(function(actual) {
        expected.should.equal(actual);
        done();
      }).done();

    });

    it('should assume capacity 1 for unknown InstanceTypes', function(done) {
      var expected = 1;
      var fakeState = {
        running: [{InstanceType: 'unknown'}],
        pending: [],
        spotRequested: [],
      };
      subject(fakeWorkerType, fakeState).then(function(actual) {
        expected.should.equal(actual);
        done();
      }).done();

    });
    
    it('should count pending instances', function(done) {
      var expected = 2;
      var fakeState = {
        running: [],
        pending: [{InstanceType: 'large'}],
        spotRequested: [],
      };
      subject(fakeWorkerType, fakeState).then(function(actual) {
        expected.should.equal(actual);
        done();
      }).done();
    });
  });
});
*/

describe('createLaunchSpec', function() {
  var subject = provision._createLaunchSpec;

  it('should overwrite values correctly', function() {
    subject(sampleWorkerType, 'r3.xlarge').then(function(actual) {
      actual.InstanceType.should.equal('r3.xlarge');
      return Promise.resolve();
    }).done();
  });

  it('should cause error when instance type is not found', function() {
    subject(sampleWorkerType, 'impossibly.large').catch(function(err) {
      err.should.be.an.Error; 
    }).done();
  });

  it('should cause error when user data is not base64', function() {
    subject(invalidUserDataWorkerType, 'r3.xlarge').catch(function(err) {
       
    }).done();
  });
});
