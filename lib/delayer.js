'use strict';

function delayer (t) {
  return function (resVal) {
    return new Promise(resolve => {
      setTimeout(() => {
        resolve(resVal);
      }, t);
    });
  };
}

module.exports = delayer;
