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

describe('awsState', function() {
  var sandbox = sinon.sandbox.create();
  var aws = require('aws-sdk-promise');
  beforeEach(function() {
    sandbox.restore();
  });

  var describeInstances = sandbox.stub(provision.ec2, 'describeInstances');
  var describeSpotInstanceRequests = sandbox.stub(provision.ec2, 'describeSpotInstanceRequests');
  var subject = provision._awsState;

  describe('fetching state', function () {

    it('should only find related instances', function(done) {
      // Wow, this is awful but I'm not sure how to stub it
      // in a more intelligent way...
      var describeInstances = sandbox.stub(provision.ec2, 'describeInstances');
      describeInstances.returns({promise: function() { return Promise.resolve({
        data: {
          Reservations: [{
            Instances: [{
              KeyName: 'taskcluster-aws-provisioner-managed:test',
              State: { Name: 'running'},
              InstanceId: 'i-1234'
            },{
              KeyName: 'taskcluster-aws-provisioner-managed:test',
              State: { Name: 'pending'},
              InstanceId: 'i-1235'
            }]
          }]
        }
      })}});
      
      describeSpotInstanceRequests.returns({promise: function() {
        return Promise.resolve({data: {SpotInstanceRequests: []}});
      }})

      subject().then(function(state) {
        done()
        state['test']['pending'][0].should.equal('i-1235');
        state['test']['running'][0].should.equal('i-1234');
      }, done).done();
    });

    it('should only find related spot requests', function(done) {
      done();
    });

    it('should create state correctly', function(done) {
      done();
    });
  });
});
