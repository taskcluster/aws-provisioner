// Load configuration
var config  = require('./config');

// Load default_only if server.js has a parent, hence, is being imported
config.load(module.parent);
var nconf       = require('nconf');
var WorkerType  = require('./provisioner/data').WorkerType;

WorkerType.loadAll().then(function(wTypes) {
  var data = wTypes.map(function(wType) {
    return {
      workerType:     wType.workerType,
      configuration:  wType.configuration
    };
  });
  console.log(JSON.stringify(data, null, 2));
});