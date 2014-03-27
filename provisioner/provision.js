var Promise     = require('promise');
var nconf       = require('nconf');
var aws         = require('aws-sdk');
var _           = require('lodash');
var state       = require('./state');
var debug       = require('debug')('provisioner:provision');

// Create ec2 service object
var ec2 = exports.ec2 = new aws.EC2();

/** Run provisioning algorithm for given WorkerType */
var provisionWorkerType = function(wType) {
  // Promises to return
  var promises = [];

  // Number of instances potentially running (either running or requested)
  var potentialRunning = wType.pendingSpotRequests.length +
                         wType.runningInstances.length;
  // Maximum number of instances allowed
  var maxInstances = wType.configuration.maxInstances;

  // Determine number of excessive spot requests, this strategy is pretty
  // naive, we just assume we want a spot request for each pending task
  var nExcessRequests = Math.max(
    0,
    wType.pendingSpotRequests.length - wType.pendingTasks.length,
    potentialRunning - maxInstances
  );

  if (nExcessRequests > 0) {
    // Find excess request
    var excessRequests = wType.pendingSpotRequests.slice(0, nExcessRequests);

    // Find excess request ids
    var excessRequestIds = excessRequests.map(function(spotRequest) {
      return spotRequest.SpotInstanceRequestId;
    });

    // Cancel excess requests
    var excess_requests_cancelled = ec2.cancelSpotInstanceRequests({
      SpotInstanceRequestIds:       requestsToCancel
    }).promise().catch(function(err) {
      debug("Failed to cancel spot-requests, error: %s, as JSON: %j",
            err, err, err.stack);
      // Ignore the error this is not significant we'll retry again next iteration
      // it's probably just eventual consistency
    });

    promises.push(excess_requests_cancelled);
  }

  // Determine number of spot-requests needed, again this is pretty naive, we
  // just assume we want one for each pending task
  var nRequestsNeeded = Math.min(Math.max(
      0,
      wType.pendingTasks.length - wType.pendingSpotRequests.length
    ),
    maxInstances - potentialRunning
  );

  // Construct launch specification
  var launchSpecification = _.defaults({
    KeyName:      nconf.get('provisioner:keyNamePrefix') + wType.workerType
  }, wType.configuration.launchSpecification);

  // Create spot instances as needed
  while(nRequestsNeeded > 0) {
    nRequestsNeeded -= 1;
    promises.push(ec2.requestSpotInstances({
      SpotPrice:              '' + wType.configuration.spotBid,
      InstanceCount:          1,
      Type:                   'one-time',
      LaunchSpecification:    launchSpecification
    }).promise().catch(function(err) {
      debug("ERROR: Failed to provision: %s with error %s, as JSON: %j",
            imageId, err, err, err.stack);
      // Ignore this error, somebody probably deleted the AMI or bad
      // configuration, who knows... Maybe we should email the person
      // who created the workerType
    }));
  }

  // Terminate running instances if we have too many
  var nInstancesToKill = Math.max(
    0,
    wType.runningInstances.length - maxInstances
  );
  if (nInstancesToKill > 0) {
    // Find instanceIds to kill
    var instancesToKill = wType.runningInstances.slice(nInstancesToKill);
    var instanceIdsToKill = instancesToKill.map(function(instance) {
      return instance.InstanceId;
    });

    // Terminate instances
    promises.push(ec2.terminateInstances({
      InstanceIds:            instanceIdsToKill
    }).promise());
  }

  return Promise.all(promises);
};

/**
 * Run the provisioning algorithm, return a promise that either succeed or fail
 * in case of failures and error might be returned, log it as best you can...
 */
exports.provision = function() {
  debug("Provisioning instances");
  // Update state of WorkerTypes, then continue the scaling operation
  // when all done, that returns a promise of success
  return state.updateAndMurder().then(function() {
    return Promise.all(state.get().map(function(wType) {
      return provisionWorkerType(wType);
    }));
  });
};

