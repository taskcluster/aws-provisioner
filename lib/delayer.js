'use strict';

let Promise = require('bluebird');

let debug = require('debug')('aws-provisioner:delayer');

function delayer (t) {
  return function (resVal) {
    return new Promise(resolve => {
      debug('sleeping for %d ms', t);
      setTimeout(() => {
        debug('slept for %d ms', t);
        resolve(resVal);
      }, t);
    });
  };
}

module.exports = delayer;
