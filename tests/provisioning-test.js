var spawn = require('child_process').spawn;
var app        = require('app');
var mock_queue = null;

/** Launch mock-queue */
exports.setUp = function(cb) {
  // Create mock-queue
  args = [
    'mock-queue.js'
  ];
  mock_queue = spawn('node', args);

  // Log output
  mock_queue.stdout.on('data', function (data) {
    console.log('mock-queue: ' + data);
  });
  mock_queue.stderr.on('data', function (data) {
    console.log('mock-queue: ' + data);
  });

  // Report that setup is done
  cb()
}

/** Terminate mock-queue */
exports.tearDown = function(cb) {
  // Kill the the mock-queue
  mock_queue.kill('SIGHUB');
  cb()
}

exports.provision = function(test){
    test.ok(true, "this assertion should fail");
    test.done();
};

