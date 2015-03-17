'use strict';

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
  var sliceFrom;
  if (typeof that === 'object') {
    this.that = that;
    if (typeof func === 'string') {
      this.func = that[func];
    } else {
      this.func = func;
    }
    sliceFrom = 3;
  } else if (typeof that === 'function') {
    this.that = undefined;
    this.func = that;
    sliceFrom = 2;
  }
  this.maxAgeMinutes = maxAgeMinutes;
  this.args = Array.prototype.slice.call(arguments, sliceFrom);
}

/**
 * Return true if there is a cached value and it has not expired
 * Return false if there is no cached value or the cached
 * value has already expired
 */
Cache.prototype.isValid = function() {
  var now = new Date();
  if (this.data && this.expiration && now < this.expiration) {
    return true;
  }
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
    this.data = this.func.apply(this.that, this.args); 
  } else {
  }
  return this.data;

};

module.exports = Cache;
