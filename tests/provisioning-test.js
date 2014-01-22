var mock_queue  = require('./mock-queue');
var server      = require('../server');
var provisioner = require('../provisioner');

var mock_server = null;

/** Launch mock-queue */
exports.setUp = function(cb) {
  // Create mock queue
  mock_queue.run([], 4242).done(function() {
    cb();
  }, function () {
    console.log("Failed to start mock-queue!!!");
    cb();
  });
}

/** Terminate mock-queue */
exports.tearDown = function(cb) {
  cb();
}

exports.provision = function(test) {
  // Provision and expect to get with success or fail
  test.expect(1);

  provisioner.provision().done(function() {
    test.ok(true, "Provision successful");
    test.done();
  }, function() {
    console.log(arguments);
    test.ok(false, "Provision failed!");
    test.done();
  });
};

