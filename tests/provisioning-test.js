// Load nconf and override the default configuration
var nconf       = require('nconf')
var port = 48394;

// Ensure that we read from the right queue
nconf.overrides({
  'dry-run':                        true,

  'log-actions':                    true,

  // Queue configuration
  'queue': {
    // Host name for the taskcluster-queue
    'host':                         'localhost',
    'port':                         port
  },
});

// Load mock queue, server and provision module from provisioner
var mock_queue  = require('./mock-queue');
var server      = require('../server');
var provision   = require('../provisioner/provision');

// Keep to mock-server so we can close it again
var mock_server = null;

/** Launch mock-queue */
exports.setUp = function(cb) {
  // Create mock queue
  mock_queue.run([], port).done(function(server) {
    mock_server = server;
    cb();
  }, function (args) {
    console.log("Failed to start mock-queue!!!");
    console.log(args.err);
    mock_server = args.server;
    mock_server.close();
    cb();
  });
};

/** Terminate mock-queue */
exports.tearDown = function(cb) {
  if (mock_server) {
    mock_server.close(function() {
      cb();
    });
    mock_server = null;
  }
};

/** Test findAMIRequirements */
exports.findAMIRequirements = function(test) {
  // Provision and expect to get with success or fail
  test.expect(1);

  provision.findAMIRequirements().then(function() {
    test.ok(true, "Successfully found some requirements");
    test.done();
  }, function() {
    console.log(arguments);
    test.ok(false, "Collection of requirements failed!");
    test.done();
  });
};

