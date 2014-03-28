var fork    = require('child_process').fork;
var path    = require('path');
var _       = require('lodash');
var Promise = require('promise');
var debug   = require('debug')('LocalProvisioner');

/** Wrapper for a process with a local provisioner, useful for testing */
var LocalProvisioner = function() {
  this.process    = null;
};

/** Launch the local provisioner instance as a subprocess */
LocalProvisioner.prototype.launch = function() {
  var that = this;
  return new Promise(function(accept, reject) {
    // Arguments for node.js
    var args = [];

    // Launch provisioner process
    that.process = fork('server.js', args, {
      env:      _.cloneDeep(process.env),
      silent:   false,
      cwd:      path.join(__dirname, '../')
    });

    // Reject on exit
    that.process.once('exit', reject);

    // Message handler
    var messageHandler = function(message) {
      if (message.ready == true) {
        // Stop listening messages
        that.process.removeListener('message', messageHandler);

        // Stop listening for rejection
        that.process.removeListener('exit', reject);

        // Listen for early exits, these are bad
        that.process.once('exit', that.onEarlyExit);

        // Accept that the server started correctly
        debug("----------- LocalProvisioner Running --------------");
        accept();
      }
    };

    // Listen for the started message
    that.process.on('message', messageHandler);
  });
};

/** Handle early exits */
LocalProvisioner.prototype.onEarlyExit = function() {
  debug("----------- LocalProvisioner Crashed --------------");
  throw new Error("Local provisioner process exited early");
};

/** Terminate local provisioner instance */
LocalProvisioner.prototype.terminate = function() {
  debug("----------- LocalProvisioner Terminated -----------");
  if (this.process) {
    this.process.removeListener('exit', this.onEarlyExit);
    this.process.kill();
    this.process = null;
  }
};

// Export LocalProvisioner
module.exports = LocalProvisioner;
