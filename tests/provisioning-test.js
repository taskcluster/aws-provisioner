var mock_queue  = require('./mock-queue');
var server      = require('../server');
var provisioner = require('../provisioner');
var nconf       = require('nconf')
var mock_server = null;

var port = 48394;

// Ensure that we read from the right queue
nconf.overrides({
  'dry-run':                        true,

  // Queue configuration
  'queue': {
    // Host name for the taskcluster-queue
    'host':                         'localhost:' + port,

    // API version of the taskcluster-queue
    'version':                      '0.1.0'
  },
});

/** Launch mock-queue */
exports.setUp = function(cb) {
  // Create mock queue
  mock_queue.run([], port).done(function() {
    cb();
  }, function (err) {
    console.log("Failed to start mock-queue!!!");
    console.log(err);
    cb();
  });
};

/** Terminate mock-queue */
exports.tearDown = function(cb) {
  cb();
};

/** Test the test setup */
exports.testSetup = function(test) {
  test.ok(nconf.get('dry-run') == true, "nconf is not configured for dry-run");
  test.done();
};

/** Test provisioning */
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

