'use strict';
/**
 * This is a watch dog timer.  Think of it as a ticking
 * timebomb which will throw an explosion when it hasn't
 * been stopped or touched in `maxTime` seconds.  The
 * `WatchDog` will throw an `Error` with `msg` if the
 * timer is allowed to expire
 */
function WatchDog(maxTime, action) {
  this.maxTime = maxTime;
  if (typeof action === 'function') {
    this.action = action;
  } else {
    this.action = function() {
      throw new Error(action);
    };
  }
}


/**
 * Start the timers
 */
WatchDog.prototype.start = function() {
  this.__watchDog = setTimeout(this.action, this.maxTime * 1000);
};


/**
 * Stop the timer
 */
WatchDog.prototype.stop = function() {
  if (this.__watchDog) {
    clearTimeout(this.__watchDog);
  }
};


/**
 * Like the posix touch command, this function
 * resets the time on this watchdog, but the watchdog
 * keeps running
 */
WatchDog.prototype.touch = function() {
  var oldWD = this.__watchDog;
  this.__watchDog = setTimeout(this.action, this.maxTime * 1000);
  clearTimeout(oldWD);
};

module.exports = WatchDog;
