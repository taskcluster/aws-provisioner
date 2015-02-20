'use strict';
var debug = require('debug')('cache');

/**
 * This object caches the return value of a function
 * for a number of minutes.  It takes the following
 * arguments:
 *   - maxAgeMinutes: number of minutes before a cache expires
 *   - that: the object on which to call the function
 *   - func: the function to call
 *   - args: the args (if any) to pass to the func
 * You must call .get() to retreive the cached value. 
 * Func in only run when the .get() function is called
 * and the cache is not valid.  NOTE: If your function
 * arguments contain callbacks, this might not be something
 * that you should be using.
 */
function Cache(maxAgeMinutes, that, func) {
  this.that = that;
  this.maxAgeMinutes = maxAgeMinutes;
  this.func = func;
  this.args = Array.prototype.slice.call(arguments, 3);
}

/**
 * Return true if there is a cached value and it has not expired
 * Return false if there is no cached value or the cached
 * value has already expired
 */
Cache.prototype.isValid = function() {
  var now = new Date();
  if (this.data && this.expiration && now < this.expiration) {
    debug('cache has not expired');
    return true;
  }
  debug('cache has expired');
  return false;
};

/**
 * If the cache is valid, return the value right away.  If the
 * cache is absent or expired, fetch a new cached value, store
 * it and return it
 */
Cache.prototype.get = function() {
  if (!this.isValid()) {
    this.expiration = new Date();
    this.expiration.setMinutes(this.expiration.getMinutes() + this.maxAgeMinutes);
    this.data = this.func.apply(this.thisVal, this.args); 
    debug('cache was expired, got new value');
  }
  return this.data;

};

module.exports = Cache;
