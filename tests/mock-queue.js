// Dependencies
var express = require('express');
var http    = require('http');
var Promise = require('promise');
var fs      = require('fs');

/** Run much-queue server */
exports.run = function(tasks, port) {
  // Create expressjs application
  var app = express();

  // Middleware configuration
  app.set('port', port);
  app.use(express.logger('dev'));
  app.use(express.json());
  app.use(express.urlencoded());
  app.use(express.methodOverride());
  app.use(app.router);
  app.use(express.errorHandler());

  // API version implemented by this server
  var version = '0.1.0';

  // Implement listing of pending jobs
  app.get('/' + version + '/jobs/PENDING', function(req, res) {
    console.log("Serving " + tasks.length + " tasks");
    res.json(tasks);
  });

  // Run server
  return new Promise(function(accept, reject) {
    var server = http.createServer(app);
    server.once('listening', function() {
      console.log('mock-queue listening on port ' + app.get('port'));
      server.removeListener('error', reject);
      accept(server);
    });
    server.once('error', function() {
      server.removeListener('listening', accept);
      reject(server);
    });
    server.listen(app.get('port'));
  });
};

// If this is run as script, read commandline arguments and launch using those
if (!module.parent) {
  var nconf   = require('nconf')

  // Load configuration from commandline arguments
  nconf.argv();

  // Load configuration from hardcoded defaults
  nconf.defaults({
    // List of tasks pending, can be provided with commandline arguments like
    // node mock-queue.js --task task1.json --task task2.json --task3.json
    'task':                           [],

    // Port to run the mock server on
    'port':                           4242
  });

  // Load tasks
  var tasks = nconf.get('task');

  // If only a single task is provided by commandline argument
  if(!(tasks instanceof Array)) {
    tasks = [tasks];
  }

  // Load tasks from files
  tasks = tasks.map(function(file) {
    var data = fs.readFileSync(file, {encoding: 'utf-8'});
    return JSON.parse(data);
  });

  // Run mock-queue server
  exports.run(tasks, nconf.get('port'));
}
