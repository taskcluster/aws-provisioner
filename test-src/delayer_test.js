var subject = require('../lib/delayer');
var assume = require('assume');

describe('delayer', function () {
  it('should resolve with the correct value', function (done) {
    var d = subject(1000);
    Promise.resolve(123).then(d).then(x => {
      assume(x).equals(123);
      done();
    }, err => {
      done(err);
    });
  });

  // This should use sinon fake timers, but I had a lot
  // of trouble getting it to work properly
  it('should resolve after the delay', function (done) {
    var start = new Date().getTime();
    var d = subject(1000);
    Promise.resolve(123).then(d).then(() => {
      var timediff = new Date().getTime() - start;
      // Because we're using real timers, we allow for
      // some clock fuzz
      if (timediff > 900 && timediff < 1500) {
        done();
      } else {
        done(new Error('delay was wrong, expected ~1000, got ' + timediff));
      }
    }, err => {
      done(err);
    });
  });

});
