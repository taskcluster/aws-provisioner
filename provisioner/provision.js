var Promise     = require('promise');
var nconf       = require('nconf');
var aws         = require('aws-sdk');
var _           = require('lodash');
var state       = require('state');
var debug       = require('debug')('provisioner:provision');

// Create ec2 service object
var ec2 = exports.ec2 = new aws.EC2();

/**
 * Run the provisioning algorithm, return a promise that either succeed or fail
 * in case of failures and error might be returned, log it as best you can...
 */
exports.provision = function() {
  debug("Provisioning instances");
  // Update state of WorkerTypes, then continue the scaling operation
  // when all done, that returns a promise of success
  return state.update().then(function(args) {
    var spotRequests  = args.shift();
    var pendingTasks  = args.shift();
    var instances     = args.shift();
    // Find number of instances we're allowed to request
    var slots_available = nconf.get('provisioning:max-instances') -
                          (spotRequests.length + instances.length);

    // List of pending promises built here
    var pending_promises = [];

    // Find imageIds
    var imageIds = _.uniq(state.get().map(function(wType) {
      return wType.configuration.imageId;
    }));

    var requestsToCancel = _.union(imageIds.map(function(imageId) {
      // Find workerTypes
      var workerTypes = state.get().filter(function(wType) {
        return wType.configuration.imageId == imageId;
      });
      // Find pending tasks
      var pendingTasks = _.union(workerTypes.map(function(wType) {
        return wType.pendingTasks;
      }));
      // Find pending spot requests
      var spotRequests = _.union(workerTypes.map(function(wType) {
        return wType.spotRequests;
      }));
      // Determine number of excessive spot requests
      var nExcessRequests = Math.max(0, spotRequests.length -
                                        pendingTasks.length);
      // Decide on requests to cancel
      return spotRequests.slice(0, nExcessRequests);
    })).map(function(spotRequest) {
      return spotRequest.SpotInstanceRequestId;
    });

    // Cancel requests if there is anything to cancel
    if (requestsToCancel.length > 0) {
      // Cancel requests as decided above
      debug("Cancelling %i requets", requestsToCancel.length);
      pending_promises.push(ec2.cancelSpotInstanceRequests({
        SpotInstanceRequestIds:       requestsToCancel,
        DryRun:                       nconf.get('dry-run')
      }).promise());
      // We don't care about success or failure of the operation above, we'll
      // try it again at next scaling event anyway
      slots_available += requestsToCancel.length;
    }


    // Request spot instances to the extend we have slots available
    imageIds.forEach(function(imageId) {
      // Find workerTypes
      var workerTypes = state.get().filter(function(wType) {
        return wType.configuration.imageId == imageId;
      });
      // Find pending tasks
      var pendingTasks = _.union(workerTypes.map(function(wType) {
        return wType.pendingTasks;
      }));
      // Find pending spot requests
      var spotRequests = _.union(workerTypes.map(function(wType) {
        return wType.spotRequests;
      }));
      // Determine number of requests needed
      var nRequestsNeeded = Math.max(0, pendingTasks.length -
                                        spotRequests.length);
      debug("Need %i requests for %s", nRequestsNeeded, imageId);
      while(slots_available > 0 && nRequestsNeeded > 0) {
        pending_promises.push(ec2.requestSpotInstances({
          SpotPrice:              '' + nconf.get('provisioning:spot-price'),
          InstanceCount:          1,
          Type:                   'one-time',
          LaunchSpecification: {
            ImageId:              imageId,
            KeyName:              nconf.get('provisioning:key-name'),
            InstanceType:         nconf.get('provisioning:instance-type'),
            IamInstanceProfile: {
              Name:               nconf.get('provisioning:iam-profile')
            },
            SecurityGroups:       nconf.get('provisioning:security-groups')
          },
          DryRun:                 nconf.get('dry-run')
        }).promise().catch(function(err) {
          debug("ERROR: Failed to provision: %s with error %s, as JSON: %j",
                imageId, err, err, err.stack);
          // Ignore this error, somebody probably deleted the AMI
        }));
        slots_available -= 1;
        nRequestsNeeded -= 1;
      }
    });

    // Kill instances if needed
    if (slots_available < 0) {
      debug("Need to kill %i instances", - slots_available);
      var instances_to_kill = [];
      // Find some instance ids
      while (slots_available < 0) {
        var instance = instances.pop();
        if (instance) {
          debug("Terminating instance: " + instance.InstanceId);
          instances_to_kill.push(instance.InstanceId);
          slots_available += 1;
        } else {
          break;
        }
      }
      // Check if we have instances to kill
      if (instances_to_kill.length > 0) {
        debug("Terminating %i instances", instances_to_kill.length);
        // Terminate instances
        pending_promises.push(ec2.terminateInstances({
          InstanceIds:                instances_to_kill,
          DryRun:                     nconf.get('dry-run')
        }).promise());
      }
    }

    // Wait for all pending promises to succeed before we determine success or
    // failure...
    return Promise.all(pending_promises);
  });
};
