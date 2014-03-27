var debug       = require('debug')('provisioner:state');
var assert      = require('assert');
var Promise     = require('promise');
var nconf       = require('nconf');
var aws         = require('aws-sdk');
var _           = require('lodash');
var request     = require('superagent-promise');
var WorkerType  = require('./data').WorkerType;


// Create ec2 service object
var ec2 = exports.ec2 = new aws.EC2();

// List of WorkerType objects currently tracked
var _wTypes = [];
// Mapping from workerType (name) to WorkerType object
var _nameToWType = {};

/** Add WorkerType instance to state currently tracked */
exports.addWorkerType = function(wType) {
  // Check if the worker type already is defined
  if (_nameToWType[wType.workerType]) {
    throw new Error(
      "Can't adding " + wType.workerType + " as one with the " +
      "name already is tracked"
    );
  }
  _wTypes.push(wType);
  _nameToWType[wType.workerType] = wType;
};

/** Remove worker type from state currently tracked */
exports.removeWorkerType = function(wType) {
  _wTypes = _.without(_wTypes, wType);
  delete _nameToWType[wType.workerType];
};

/** Load WorkerTypes from azure */
exports.load = function() {
  return WorkerType.loadAll().then(function(wTypes) {
    wTypes.forEach(function(wType) {
      exports.addWorkerType(wType);
    });
  });
};

/** Get state currently tracked */
exports.get = function() {
  return _wTypes;
};

/** Update number of spot requests
 * Returns a promise for spotRequests prefixed with keyNamePrefix, but for which
 * no workerType exists.
 */
exports.updateSpotRequests = function() {
  debug("Get spot requests");
  // First get pending spot instance requests
  return ec2.describeSpotInstanceRequests({
    Filters: [{
      Name:               'state',
      Values:             ['open']
    }, {
      Name:               'launch.key-name',
      Values:             [nconf.get('provisioner:keyNamePrefix') + '*']
    }]
  }).promise().then(function(response) {
    var spotRequests = response.data.SpotInstanceRequests;
    debug("Got %s spot requests", spotRequests.length);
    // Clear pending spot requests for all WorkerTypes
    _wTypes.forEach(function(wType) {
      wType.pendingSpotRequests = [];
    });
    // Added spot requests to list of pending requests
    var nPrefix = nconf.get('provisioner:keyNamePrefix').length;
    return spotRequests.filter(function(request) {
      var workerType = request.LaunchSpecification.KeyName.substr(nPrefix);
      var wType = _nameToWType[workerType];
      if (wType) {
        wType.pendingSpotRequests.push(request);
        return false;
      }
      return true;
    });
  });
};

/** Update pending tasks, returns a promise for all tasks */
exports.updatePendingTasks = function() {
  // Find number of pending tasks
  debug("Get pending tasks");
  var provisionerId = nconf.get('provisioner:provisionerId');
  var got_pending_tasks = request.get(
      nconf.get('queue:baseUrl') + '/v1/pending-tasks/' + provisionerId
    ).end();

  // Update state and extra pending tasks
  return got_pending_tasks.then(function(res) {
    // Check status code
    if (!res.ok) {
      throw new Error("Failed to fetch tasks!");
    }
    // Read tasks from queue
    var tasks = res.body.tasks.filter(function(task) {
      // Filter out tasks that isn't for this provisioner
      if (task.provisionerId != provisionerId) {
        debug("Got task for provisionerId: %s", task.provisionerId);
        return false;
      }
      return true;
    });
    // Log response from queue
    debug("got %s tasks", tasks.length);
    // Clear pending tasks for all WorkerTypes
    _wTypes.forEach(function(wType) {
      wType.pendingTasks = [];
    });
    // Add pending tasks to state for WorkerTypes
    tasks.forEach(function(task) {
      var wType = _nameToWType[task.workerType];
      if (!wType) {
        return debug("Critical: unknown workerType: '%s'", task.workerType);
      }
      wType.pendingTasks.push(task);
    });
    return tasks;
  });
};

/** Update list of running instances
 * Returns a promise for a list of running instances prefixed with keyNamePrefix
 * but for which no workerType exists.
 */
exports.updateRunningInstances = function() {
  // Find number of running instances
  debug("Get instances running");
  return ec2.describeInstances({
    Filters: [{
      Name:               'instance-state-name',
      Values:             ['pending', 'running']
    }, {
      Name:               'key-name',
      Values:             [nconf.get('provisioner:keyNamePrefix') + '*']
    }]
  }).promise().then(function(response) {
    // Clear list of running instances
    _wTypes.forEach(function(wType) {
      wType.runningInstances = [];
    });
    // Add running instances to type
    var nPrefix = nconf.get('provisioner:keyNamePrefix').length;
    var rougeInstances = [];
    response.data.Reservations.forEach(function(reservation) {
      reservation.Instances.forEach(function(instance) {
        var workerType = instance.KeyName.substr(nPrefix);
        var wType = _nameToWType[workerType];
        if (wType) {
          wType.runningInstances.push(instance);
        } else {
          rougeInstances.push(instance);
        }
      });
    });
    debug("found %s rouge instances", rougeInstances.length);
    return rougeInstances;
  });
};

/** Update state and murder rouge spot-requests and rouge instances */
exports.updateAndMurder = function() {
  // Update spot requests and get rouge requests
  var got_rouge_spot = exports.updateSpotRequests();

  // Handle rouge spot requests
  var handled_spot = got_rouge_spot.then(function(rougeSpotRequests) {
    if (rougeSpotRequests.length == 0) {
      return;
    }

    // Find request ids
    var rougeSpotRequestIds = rougeSpotRequests.map(function(spotRequest) {
      return spotRequest.SpotInstanceRequestId
    });
    // Cancel all rouge requests
    return ec2.cancelSpotInstanceRequests({
      SpotInstanceRequestIds:         rougeSpotRequestIds
    }).promise();
  });

  // Update running instances and get rouge instances
  var got_rouge_instances = exports.updateRunningInstances();

  // Handle rouge instances
  var handled_instance = got_rouge_instances.then(function(rougeInstances) {
    if (rougeInstances.length == 0) {
      return;
    }

    // Find rouge instance ids
    var rougeInstanceIds = rougeInstances.map(function(instance) {
      return instance.InstanceId;
    });
    // Terminate rouge instances
    return ec2.terminateInstances({
      InstanceIds:                    rougeInstanceIds
    }).promise();
  });

  // Return promise that updated and handled everything
  return Promise.all(
    handled_spot,
    handled_instance,
    exports.updatePendingTasks()
  );
};

