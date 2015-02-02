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

describe('determineCapacityChange', function() {
  var subject = provision._determineCapacityChange;

  describe('without scaling ratio', function() {
    it('should not change the number of nodes needed', function() {
      var expected = 0;
      var actual = subject(1, 10, 0);
      actual.should.equal(expected);
    });

    it('should increase number of nodes needed', function() {
      var expected = 1;
      var actual = subject(1, 10, 1);
      actual.should.equal(expected);
      var expected = 2;
      var actual = subject(1, 10, 2);
      actual.should.equal(expected);
      var expected = 3;
      var actual = subject(1, 10, 3);
      actual.should.equal(expected);
    });
  });

  describe('with scaling ratios', function() {
    it('should not increase number of nodes when there are no pending tasks', function() {
      var expected = 0;
      var actual = subject(0.8, 10, 0);
      actual.should.equal(expected);
    });

    it('should increase number of nodes when there are enough pending tasks', function() {
      var expected = 2;
      var actual = subject(0.8, 10, 4);
      actual.should.equal(expected);
    });

    it('should not increase the number of nodes when there are too few pending tasks', function() {
      var expected = 0;
      var actual = subject(0.5, 20, 10);
      actual.should.equal(expected);
    });

    it('should increase the number of nodes when there are enough pending tasks', function() {
      var expected = 1;
      var actual = subject(0.5, 20, 11);
      actual.should.equal(expected);
    });

  });
});

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
