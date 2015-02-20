'use strict';

var debug = require('debug')('cache:test');
var subject = require('../cache');

describe('Cache', function() {
  function A() { }

  A.prototype.testFunc = function() {
    return rv;
  }

  var cache;
  var rv;

  beforeEach(function() {
    var inst = new A();
    rv = new Date();  // Just any object will do
    cache = new subject(20, inst, inst.testFunc); 
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
    var now = new Date();
    cache.get();
    var actual= cache.expiration.getMinutes();
    var expected = now.getMinutes() + 20;
    // Grr.  timing in tests suck...
    if (expected !== actual) {
      debug('Test failure might be a timing issue not a brokeness thing');
    }
    expected.should.equal(actual);
  });

});
