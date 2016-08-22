let assert = require('assert');
/**
 * Run a promise with a timeout.  The timeout should be
 * in milliseconds
 */
module.exports = function(timeout, realPromise, timeoutMsg = '') {
  assert(typeof timeout === 'number');
  assert(typeof realPromise === 'object');
  assert(realPromise.then);
  assert(typeof realPromise.then === 'function');
  return Promise.race([
    realPromise,
    new Promise((res, rej) => {
      setTimeout(() => {
        rej(new Error('Promise Timed Out' + timeoutMsg ? ': ' + timeoutMsg : ''));
      }, timeout);
    }),
  ]);
}
