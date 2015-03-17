'use strict';

var debug = require('debug')('cache:test');
var sinon = require('sinon');

var subject = require('../lib/cache');

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

describe('cache function calling behaviour', function () {
  var clock;
  var sandbox;

  beforeEach(function() {
    clock = sinon.useFakeTimers();
    sandbox = new sinon.sandbox.create();
  });

  afterEach(function() {
    clock.restore();
    sandbox.restore();
  });

  it('should call a lone paramless func', function() {
    var a = new Date();
    var callCount = 0;
    var func = function() {
      callCount++;
      return a
    }; 
    var cache = new subject(20, func);
    cache.get().should.equal(a);
    callCount.should.eql(1);
  });

  it('should call a lone paramful func', function() {
    var a = new Date();
    var callCount = 0;
    var valuePassedToX;
    var func = function(x) {
      callCount++;
      valuePassedToX = x;
      return a
    }; 
    var cache = new subject(20, func, 'johnissupercool');
    cache.get().should.equal(a);
    callCount.should.eql(1);  
    valuePassedToX.should.eql('johnissupercool');
  });

  it('should call a paramless func on object', function() {
    var a = new Date();

    function B(val) {
      this.val = val;
      this.callCount = 0;
    }

    B.prototype.func = function() {
      this.callCount++;
      return this.val;
    };
    var inst = new B(a);
    var cache = new subject(20, inst, inst.func, 'johnissupercool');

    cache.get().should.equal(a);
    inst.callCount.should.eql(1);  
  });

  it('should call a paramful func on object', function() {
    var a = new Date();

    function C(val) {
      this.val = val;
      this.callCount = 0;
    }

    C.prototype.func = function(x) {
      this.callCount++;
      this.valuePassedToX = x;
      return this.val;
    };
    var inst = new C(a);
    var cache = new subject(20, inst, inst.func, 'johnissupercool');

    cache.get().should.equal(a);
    inst.callCount.should.eql(1);  
    inst.valuePassedToX.should.eql('johnissupercool');
  });

  it('should call a paramful func on object using string name', function() {
    var a = new Date();

    function D(val) {
      this.val = val;
      this.callCount = 0;
    }

    D.prototype.func = function(x) {
      this.callCount++;
      this.valuePassedToX = x;
      return this.val;
    };

    var inst = new D(a);
    var cache = new subject(20, inst, 'func', 'johnissupercool');

    cache.get().should.equal(a);
    inst.callCount.should.eql(1);  
    inst.valuePassedToX.should.eql('johnissupercool');
  });
});



