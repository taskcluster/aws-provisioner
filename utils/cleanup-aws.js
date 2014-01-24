var Promise                         = require('promise');
var fs                              = require('fs');
var nconf                           = require('nconf');
var aws                             = require('aws-sdk');
var uuid                            = require('uuid');

// Load a little monkey patching
require('./aws-sdk-promise').patch();
require('./spread-promise').patch();

// Config filename
var config_filename = 'taskcluster-aws-provisioner.conf.json';

// Load local config file
var data = "{}";
try {
  data = fs.readFileSync(config_filename, {encoding: 'utf-8'});
}
catch (error) {
  // Ignore file doesn't exists errors
  if (error.code != 'ENOENT') {
    throw error;
  }
}

var cfg  = JSON.parse(data);

// Find key-name and region
var key_name  = (cfg.provisioning  || {})['key-name'];
var region    = (cfg.aws  || {}).region;

// Check that we have key-name and region
if (!key_name || !region) {
  console.log("Local config file '" + config_filename+ "'");
  console.log("doesn't contain key-name and region, can't clean-up!");
  process.exit(1);
}

// Setup ec2
var ec2 = new aws.EC2({region: region});

// Create a function to clean up
var count = 1;
var cleanup = function() {
  console.log("Cleaning up " + count++ + ":");

  // Cancel all spot requests, first get the spot requests
  var cancel_spot_requests = ec2.describeSpotInstanceRequests({
    Filters: [{
      Name:                         'state',
      Values:                       ['open']
    }, {
      Name:                         'launch.key-name',
      Values:                       [key_name]
    }]
  }).promise().then(function(response) {
    // Find all spot request ids
    var spotRequests = response.data.SpotInstanceRequests;
    var requestIds = spotRequests.map(function(spotRequest) {
      return spotRequest.SpotInstanceRequestId;
    });
    if (requestIds.length > 0) {
      console.log(" - Canceling " + requestIds.length + " spot requests");
      // Cancel all spot requests
      return ec2.cancelSpotInstanceRequests({
        SpotInstanceRequestIds:       requestIds
      }).promise();
    } else {
      console.log(" - No spot requests to cancel");
    }
  });

  // Kill all running instances, first get the instances
  var kill_running_instances = ec2.describeInstances({
    Filters: [{
      Name:                       'instance-state-name',
      Values:                     ['pending', 'running']
    }, {
      Name:                       'key-name',
      Values:                     [key_name]
    }],
  }).promise().then(function(response) {
    // Then we find instance ids
    var instancesIds = [];
    response.data.Reservations.forEach(function(reservation) {
      reservation.Instances.forEach(function(instance) {
        instancesIds.push(instance.InstanceId);
      });
    });
    // If any, we terminate them
    if (instancesIds.length > 0) {
      console.log(" - Terminating " + instancesIds.length + " instances");
      return ec2.terminateInstances({
        InstanceIds:                instancesIds
      }).promise();
    } else {
      console.log(" - No instances to terminate");
    }
  });

  // delete key-pair
  var delete_key_pair = ec2.deleteKeyPair({
    KeyName:                        key_name
  }).promise();

  // Promise that all of these succeed
  return Promise.all(
    cancel_spot_requests,
    kill_running_instances,
    delete_key_pair
  );
};

var sleep = function(time) {
  return new Promise(function(accept) {
    console.log(" - Sleeping " + time / 1000 + " s");
    setTimeout(accept, time);
  });
};

// Cleanup 3 times before we're done
cleanup().then(function() {
  return sleep(5000);
}).then(function() {
  return cleanup();
}).then(function() {
  return sleep(10000);
}).then(function() {
  return cleanup();
}).then(function() {
  return sleep(20000);
}).then(function() {
  return cleanup();
}).then(function() {
  return sleep(30000);
}).then(function() {
  return cleanup();
}).then(function() {
  delete cfg.provisioning['key-name'];
  delete cfg.aws.region;
  fs.writeFileSync(config_filename, JSON.stringify(cfg));
  try {
    fs.unlinkSync(key_name + ".pem");
  }
  catch (error) {
    if (error.code != 'ENOENT') {
      throw error;
    }
  }
}).then(function() {
  console.log("cleanup-aws successful!");
}, function(error) {
  console.log("cleanup-aws failed!");
  console.log(error)
  process.exit(1);
})
