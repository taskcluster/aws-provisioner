let assert = require('assert');

/**
 * Run a promise with a timeout.  The timeout should be
 * in milliseconds
 */
function timeoutPromise (timeout, realPromise, timeoutMsg = '') {
  assert(typeof timeout === 'number');
  assert(typeof realPromise === 'object');
  assert(realPromise.then);
  assert(typeof realPromise.then === 'function');
  return Promise.race([
    realPromise,
    new Promise((res, rej) => {
      setTimeout(() => {
        rej(new Error(timeoutMsg ? timeoutMsg : 'Promise timed out'));
      }, timeout);
    }),
  ]);
}


function awsTimeoutPromise(timeout, ec2, method, request = {}) {
  assert(typeof timeout === 'number');
  assert(typeof ec2 === 'object');
  assert(typeof method === 'string');
  if (request) {
    assert(typeof request === 'object');
  }

  return new Promise((res, rej) => {

    setTimeout(() => {
      let region = ec2.config.region;
      let timeoutMsg = `AWS Promise Timeout calling ${method} in ${region}`;
      timeoutMsg += `\n${JSON.stringify(request)}`;
      let err = new Error(timeoutMsg);
      err.region = region;
      //err.ec2 = ec2;
      err.method = method;
      err.request = request;
      rej(err);
    }, timeout);

    ec2[method](request, (err, data) => {
      if (err) {
        return rej(err);
      }
      return res({data});
    });
  });
}

module.exports = timeoutPromise;
module.exports.aws = awsTimeoutPromise;
