'use strict';

var debug = require('debug')('cache:test');
var sinon = require('sinon');

var subject = require('../cache');

describe('basic cache functionality', function() {
  function A() { }

  A.prototype.testFunc = function() {
    return rv;
  }

  var clock;
  var cache;
  var rv;
  var sandbox = new sinon.sandbox.create();
  var inst;

  beforeEach(function() {
    inst = new A();
    rv = new Date();  // Just any object will do
    cache = new subject(20, inst, inst.testFunc); 
    clock = sinon.useFakeTimers();
  });

  afterEach(function() {
    clock.restore();
    sandbox.restore();
  });

  it('should not be valid before running .get()', function() {
    cache.isValid().should.be.False;
  });

  it('should return the correct value on first .get()', function() {
    var result = cache.get()
    result.should.equal(rv);
  });

  it('should be valid immediately after running .get()', function () {
    cache.get();
    cache.isValid().should.be.True;
  });

  it('should calculate the expiration correctly', function() {
    var expected = 20;
    cache.get();
    var actual = cache.expiration.getMinutes();
    expected.should.equal(actual);
  });

  it('should not expire before it expires', function() {
    cache.get();
    cache.isValid().should.be.True;
    clock.tick((1000 * 60 * 20) - 1);
    cache.isValid().should.be.True;
    clock.tick(1);
    cache.isValid().should.be.False;
  });

  it('should call the cache function once to fetch initial value', function() {
    var spy = sandbox.spy(cache, 'func');
    cache.get();
    spy.calledOnce.should.be.True;
  });

  it('should not call the cache function on second .get()', function() {
    var spy = sandbox.spy(cache, 'func');
    cache.get();
    cache.get();
    spy.calledOnce.should.be.True;
    spy.calledTwice.should.be.False;
  });

  it('should call the cache function when cache expires', function() {
    var spy = sandbox.spy(cache, 'func');
    cache.get();
    spy.calledOnce.should.be.True;
    cache.get();
    spy.calledOnce.should.be.True;
    clock.tick(60 * 1000 * 20);
    cache.get();
    spy.calledTwice.should.be.True;
  });

});
