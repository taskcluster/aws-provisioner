var Promise = require('promise');
var nconf   = require('nconf');
var aws     = require('aws-sdk');
var request = require('request');
var _       = require('lodash');
var log     = require('./log');

var PromiseRequest = Promise.denodeify(request);

// Create ec2 service object
var ec2 = new aws.EC2();

/** Run the provisioning algorithm, return a promise that either succeed or fail
 */
var provision = function() {
  var log_provisioning_end = log('PROVISION', "Provisioning instances");

  // Count up how many of each AMI we need and how many we have
  var amis_needed = {};
  var amis_running = {};

  // Find number of pending spot requests
  var log_get_spots_requests_end = log('EC2', "Get spot requests");
  var get_spot_requests = ec2.describeSpotInstanceRequests({
    Filters: [{
      Name:                         'state',
      Values:                       ['open']
    }, {
      Name:                         'launch.key-name',
      Values:                       [nconf.get('provisioning:key-name')]
    }],
    DryRun:                         nconf.get('dry-run')
  }).promise().then(function(response) {
    var spot_requests = response.data.SpotInstanceRequests;
    // Log that we got spot instance requests
    log_get_spots_requests_end("Got %i instances", spot_requests.length);
    // For each spot request, decrement number of AMIs needed
    spot_requests.forEach(function(request) {
      var ami = request.LaunchSpecification.ImageId;
      var amis = (amis_needed[ami] || 0) - 1;
      amis_needed[ami] = amis;
    });
    return spot_requests;
  });

  // Find number of pending tasks
  var log_get_pending_tasks_end = log('QUEUE', "Get pending tasks");
  var get_pending_tasks = PromiseRequest(
      'http://' + nconf.get('queue:host') + '/' +
      nconf.get('queue:version') + '/jobs/PENDING'
    ).then(function(response) {
    // Check status code
    if (response.statusCode != 200) {
      throw new Error("Failed to fetch tasks with status code 200!");
    }
    // Read tasks from queue
    var tasks = JSON.parse(response.body);
    // Log response from queue
    log_get_pending_tasks_end("got %i tasks", tasks.length);
    // For each task increment the number of AMIs requested
    tasks.forEach(function(task) {
      var ami = ((task.parameters || {}).hardware || {}).ami;
      if (ami) {
        var amis = (amis_needed[ami] || 0) + 1;
        amis_needed[ami] = amis;
      }
    });
    return tasks;
  });

  // Find number of running instances
  var log_get_instances_end = log('EC2', "Get instances running");
  var get_instances_running = ec2.describeInstances({
    Filters: [{
      Name:                       'instance-state-name',
      Values:                     ['pending', 'running']
    }, {
      Name:                       'key-name',
      Values:                     [nconf.get('provisioning:key-name')]
    }],
    DryRun:                       nconf.get('dry-run')
  }).promise().then(function(response) {
    var instances = [];
    response.data.Reservations.forEach(function(reservation) {
      reservation.Instances.forEach(function(instance) {
        instances.push(instance);
        var ami = instance.ImageId;
        var amis = (amis_running[ami] || 0) + 1;
        amis_running[ami] = amis;
      });
    });
    log_get_instances_end("found %i instances", instances.length);
    return instances;
  });

  // Wait for above operations to finish, then continue the scaling operation
  // when all done, that returns a promise of success
  return Promise.all(
    get_spot_requests,
    get_pending_tasks,
    get_instances_running
  ).spread(function(spotRequests, tasks, instances) {
    // Find number of instances we're allowed to request
    var slots_available = nconf.get('provisioning:max-instances') -
                          (spotRequests.length + instances.length);

    // List of pending promises built here
    var pending_promises = [];

    // Cancel spot requests where needed
    var requestsToCancel = [];
    _.forIn(amis_needed, function(needed, ami) {
      if (needed < 0) {
        log('DECISION', "Cancelling %i spot requests with image " + ami, - needed);
        // Find requests for th given ami
        var requests = spotRequests.filter(function(req) {
          return req.LaunchSpecification.ImageId == ami;
        });
        while (needed < 0) {
          var request = requests.pop();
          if (request) {
            requestsToCancel.push(request.SpotInstanceRequestId);
            log('DECISION', "Cancelling spot request " +
                            request.SpotInstanceRequestId);
            needed -= 1;
          } else {
            break;
          }
        }
        // Update number of needed AMIs
        amis_needed[ami] = needed;
      }
    });

    // Cancel requests if there is anything to cancel
    if (requestsToCancel.length > 0) {
      // Cancel requests as decided above
      log('EC2', "Cancelling %i requets", requestsToCancel.length);
      pending_promises.push(ec2.cancelSpotInstanceRequests({
        SpotInstanceRequestIds:       requestsToCancel,
        DryRun:                       nconf.get('dry-run')
      }).promise());
      // We don't care about success or failure of the operation above, we'll try
      // it again at next scaling event anyway
      slots_available += requestsToCancel.length;
    }

    // Request spot instances to the extend we have slots available
    _.forIn(amis_needed, function(needed, ami) {
      // Request spot instances
      while (slots_available > 0 && needed > 0) {
        log('DECISION', "Request instance with image " + ami);
        pending_promises.push(ec2.requestSpotInstances({
          SpotPrice:              '' + nconf.get('provisioning:spot-price'),
          InstanceCount:          1,
          Type:                   'one-time',
          LaunchSpecification: {
            ImageId:              ami,
            KeyName:              nconf.get('provisioning:key-name'),
            InstanceType:         nconf.get('provisioning:instance-type'),
            IamInstanceProfile: {
              Name:               nconf.get('provisioning:iam-profile')
            },
            SecurityGroups:       nconf.get('provisioning:security-groups')
          },
          DryRun:                 nconf.get('dry-run')
        }).promise());
        slots_available -= 1;
        needed -= 1;
      }
    });

    // Kill instances if needed
    if (slots_available < 0) {
      log('DECISION', "Need to kill %i instances", - slots_available);
      var instances_to_kill = [];
      // Find some instance ids
      while (slots_available < 0) {
        var instance = instances.pop();
        if (instance) {
          log('DECISION', "Terminating instance: " + instance.InstanceId);
          instances_to_kill.push(instance.InstanceId);
          slots_available += 1;
        } else {
          break;
        }
      }
      // Check if we have instances to kill
      if (instances_to_kill.length > 0) {
        log('EC2', "Terminating %i instances", instances_to_kill.length);
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
  }).then(function() {
    log_provisioning_end();
  });
};

exports.provision = provision;
