'use strict';

var util = require('util');
var events = require('events');

/**
 * This is a watch dog timer.  Think of it as a ticking
 * timebomb which will throw an explosion when it hasn't
 * been stopped or touched in `maxTime` seconds.  The
 * `WatchDog` will throw an `Error` with `msg` if the
 * timer is allowed to expire
 */
function WatchDog (maxTime) {
  var that = this;
  this.maxTime = maxTime;
  events.EventEmitter.call(this);
  this.action = function () {
    var error = new Error('Watchdog expired!');
    // A better way to make this mandatory?
    if (that.listeners('expired').length > 0) {
      that.emit('expired', error);
    } else {
      throw error;
    }
  };
}

util.inherits(WatchDog, events.EventEmitter);

/**
 * Start the timers
 */
WatchDog.prototype.start = function () {
  this.__watchDog = setTimeout(this.action, this.maxTime * 1000);
  this.emit('started');
};

/**
 * Stop the timer
 */
WatchDog.prototype.stop = function () {
  if (this.__watchDog) {
    clearTimeout(this.__watchDog);
  }
  this.emit('stopped');
};

/**
 * Like the posix touch command, this function
 * resets the time on this watchdog, but the watchdog
 * keeps running
 */
WatchDog.prototype.touch = function () {
  var oldWD = this.__watchDog;
  this.__watchDog = setTimeout(this.action, this.maxTime * 1000);
  clearTimeout(oldWD);
  this.emit('touched');
};

module.exports = WatchDog;
