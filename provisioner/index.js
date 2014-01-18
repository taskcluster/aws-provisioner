var Promise = require('promise');
var nconf   = require('nconf');
var aws     = require('aws-sdk');
var request = require('request');
var _       = require('lodash');

var PromiseRequest = Promise.denodeify(request);

// Create ec2 service object
var ec2 = new aws.EC2();

// Number of failures allowed before raising an alert
var retries = nconf.get('provisioning:max-retries');

/** Run the provisioning algorithm */
var provision = function() {
  console.log("Provisioning");
  // Count up how many of each AMI we need and how many we have
  var amis_needed = {};
  var amis_running = {};

  // Find number of pending spot requests
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
    // For each spot request, decrement number of AMIs needed
    spot_requests.forEach(function(request) {
      var ami = request.LaunchSpecification.ImageId;
      var amis = (amis_needed[ami] || 0) - 1;
      amis_needed[ami] = amis;
    });
    return spot_requests;
  });

  // Find number of pending tasks
  var get_pending_tasks = PromiseRequest(
      'http://' + nconf.get('queue:host') + '/' +
      nconf.get('queue:version') + '/jobs/PENDING'
    ).then(function(response) {
    // Check status code
    if (response.statusCode != 200) {
      throw new Error("Failed to fetch tasks with status code 200!");
    }
    var tasks = JSON.parse(response.body);
    tasks.forEach(function(task) {
      // For each task increment the number of AMIs requested
      var ami = ((task.parameters || {}).hardware || {}).ami;
      if (ami) {
        var amis = (amis_needed[ami] || 0) + 1;
        amis_needed[ami] = amis;
      }
    });
    return tasks;
  });

  // Find number of running instances
  var get_instances_running = ec2.describeInstances({
    Filters: [{
      Name:                       'instance-state-name',
      Values:                     ['pending', 'running']
    }, {
      Name:                       'launch.key-name',
      Values:                     [nconf.get('provisioning:key-name')]
    }],
    DryRun:                         nconf.get('dry-run')
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
    return instances;
  });

  // Wait for above operations to finish and bring
  Promise.all(
    get_spot_requests,
    get_pending_tasks,
    get_instances_running
  ).spread(function(spotRequests, tasks, instances) {
    // Find number of instances we're allowed to request
    var slots_available = nconf.get('provisioning:max-instances') -
                          spotRequests.length - instances.length;

    // List of pending promises built here
    var pending_promises = [];

    // Cancel spot requests where needed
    var requestsToCancel = [];
    _.forIn(amis_needed, function(ami, needed) {
      if (needed < 0) {
        // Find requests for th given ami
        var requests = spotRequests.filter(function(req) {
          return req.LaunchSpecification.ImageId == ami;
        });
        while (needed < 0) {
          var request = requests.pop();
          if (request) {
            requestsToCancel.push(request.SpotInstanceRequestId);
            needed -= 1;
          } else {
            break;
          }
        }
        // Update number of needed AMIs
        amis_needed[ami] = needed;
      }
    });

    // Cancel requests as decided above
    pending_promises.push(ec2.cancelSpotInstanceRequests({
      SpotInstanceRequestIds:       requestsToCancel,
      DryRun:                       nconf.get('dry-run')
    }).promise());

    // We don't care about success or failure of the operation above, we'll try
    // it again at next scaling event anyway
    slots_available += requestsToCancel.length;

    // Request spot instances to the extend we have slots available
    _.forIn(amis_needed, function(ami, needed) {
      if (needed > 0) {
        // Request spot instances
        while (slots_available > 0) {
          pending_promises.push(ec2.requestSpotInstances({
            SpotPrice:              nconf.get('provisioning:spot-price'),
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
        }
      }
    });

    // Kill instances if needed
    if (slots_available < 0) {
      var instances_to_kill = [];
      // Find some instance ids
      while (slots_available < 0) {
        var instance = instances.pop();
        if (instance) {
          instances_to_kill.push(instance.InstanceId);
          slots_available += 1;
        } else {
          break;
        }
      }
      // Terminate instances
      pending_promises.push(ec2.terminateInstances({
        InstanceIds:                instances_to_kill,
        DryRun:                     nconf.get('dry-run')
      }).promise());
    }

    // Wait for all pending promises to succeed before we determine success or
    // failure...
    return Promise.all(pending_promises);
  }).then(function() {
    // If the scaling operation is successful we reset the number of retries
    // available. This allows for occasional failures, which is to be expected.
    retries = nconf.get('provisioning:max-retries');
    console.log("I'm not sure we should believe this!!!");
  }, function(error) {
    // On error decrement retries, if it goes negative, then we should raise
    // an alert of some kind...
    retries -= 1;
    if (retries < 0) {
      // TODO: This is bad, raise an alert
      console.log("Provisioning-failed:");
      console.log(error);
    }
  })
};



exports.provision = provision;
