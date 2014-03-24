var debug       = require('debug')('provisioner:state');
var assert      = require('assert');
var Promise     = require('promise');
var nconf       = require('nconf');
var aws         = require('aws-sdk');
var _           = require('lodash');
var request     = require('superagent-promise');

// Create ec2 service object
var ec2 = exports.ec2 = new aws.EC2();

var _wTypes = [];

/** Add WorkerType instance to state currently tracked */
exports.addWorkerType = function(newWType) {
  // Check if the worker type already is defined
  var exists = false;
  _wTypes.forEach(function(wType) {
    if (newWType.workerType == wType.workerType) {
      exists = true;
    }
  });
  if (exists) {
    throw new Error(
      "Can't adding " + newWType.workerType + " as one with the " +
      "name already is tracked"
    );
  }
  _wTypes.push(newWType);
};

/** Load WorkerTypes from azure */
exports.load = function() {
  return WorkerType.loadAll().then(function(wTypes) {
    _wTypes = wTypes;
  });
};

/** Get state currently tracked */
exports.get = function() {
  return _wTypes;
};

/** Update state of all tracked WorkerTypes */
exports.update = function() {
  // Mapping from imageId to list of WorkerTypes
  var imageToWTypes = {};
  // Mapping from workerType name to WorkerType instance
  var nameToWType = {};

  // Populate mapping defined above
  _wTypes.forEach(function(wType) {
    assert(nameToWType[wType.workerType] === undefined,
           "WorkerType: " + wType.workerType + " is in state twice!");
    nameToWType[wType.workerType] = wType;

    var imageId = wType.configuration.imageId;
    var wTypes = imageToWTypes[imageId] || [];
    wTypes.push(wType);
    imageToWTypes[imageId] = wTypes;
  });


  // Find number of pending spot requests
  debug("Get spot requests");
  var got_spot_requests = ec2.describeSpotInstanceRequests({
    Filters: [{
      Name:                         'state',
      Values:                       ['open']
    }, {
      Name:                         'launch.key-name',
      Values:                       [nconf.get('provisioning:key-name')]
    }],
    DryRun:                         nconf.get('dry-run')
  }).promise().then(function(response) {
    var spotRequests = response.data.SpotInstanceRequests;
    debug("Got %s instances", spotRequests.length);
    // Clear pending spot requests for all WorkerTypes
    _wTypes.forEach(function(wType) {
      wType.pendingSpotRequests = [];
    });
    // Added spot requests to list of pending requests
    spotRequests.forEach(function(request) {
      var imageId = request.LaunchSpecification.ImageId;
      // Update number of pending spot requests for WorkerTypes with
      // this imageId
      (imageToWTypes[imageId] || []).forEach(function(wType) {
        wType.pendingSpotRequests.push(request);
      });
    });
    return spotRequests;
  });

  // Find number of pending tasks
  debug("Get pending tasks");
  var provisionerId = nconf.get('provisioning:provisioner-id');
  var got_pending_tasks = request.get(
      nconf.get('queue:baseUrl') + '/v1/pending-tasks/' + provisionerId
    ).end().then(function(res) {
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
      var wType = nameToWType[task.workerType];
      if (!wType) {
        return debug("Critical unknown workerType: '%s'", task.workerType);
      }
      wType.pendingTasks.push(task);
    });
    return tasks;
  });

  // Find number of running instances
  debug("Get instances running");
  var got_instances_running = ec2.describeInstances({
    Filters: [{
      Name:                       'instance-state-name',
      Values:                     ['pending', 'running']
    }, {
      Name:                       'key-name',
      Values:                     [nconf.get('provisioning:key-name')]
    }],
    DryRun:                       nconf.get('dry-run')
  }).promise().then(function(response) {
    // Clear list of running instances
    _wTypes.forEach(function(wType) {
      wType.runningInstances = [];
    });
    // Add running instances to type
    var instances = [];
    response.data.Reservations.forEach(function(reservation) {
      reservation.Instances.forEach(function(instance) {
        instances.push(instance);
        var imageId = instance.ImageId;
        (imageToWTypes[imageId] || []).forEach(function(wType) {
          wType.runningInstances.push(instance);
        });
      });
    });
    debug("found %s instances", instances.length);
    return instances;
  });

  // Return a promise that state have been updated
  return Promise.all(
    got_spot_requests,
    got_pending_tasks,
    got_instances_running
  );
};






