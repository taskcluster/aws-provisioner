var Promise = require('promise');
var assert = require('assert');
var debug = require('debug')('provisioner:test:provison');
var helper = require('./helper');
var slugid = require('slugid');
var should = require('should');
var _ = require('lodash');
var data = require('../provisioner/data.js');

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
