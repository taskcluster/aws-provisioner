'use strict';

let base = require('taskcluster-base');

// This is a time series to measure how long it takes for instances to show up
// in the AWS api responses
module.exports.ec2ApiLag = new base.stats.Series({
  name: 'AwsProvisioner.Ec2ApiLag',
  columns: {
    provisionerId: base.stats.types.String,
    region: base.stats.types.String,
    az: base.stats.types.String,
    instanceType: base.stats.types.String,
    workerType: base.stats.types.String,
    id: base.stats.types.String,
    // other columns should be obvious.
    // This column is 0 for it showed up somehow, somewhere
    // and 1 for being dropped on the floor
    didShow: base.stats.types.Number,
    // How many seconds to show up in API.  This is a maximum
    // bound since we only check the API once every iteration
    lag: base.stats.types.Number,
  },
});

// Store the spot requests which we submit
module.exports.spotRequestsSubmitted = new base.stats.Series({
  name: 'AwsProvisioner.SpotRequestsSubmitted',
  columns: {
    provisionerId: base.stats.types.String,
    region: base.stats.types.String,
    az: base.stats.types.String,
    instanceType: base.stats.types.String,
    workerType: base.stats.types.String,
    id: base.stats.types.String,
    // Both the bid and price will be the pre-safety factor number
    bid: base.stats.types.Number,
    price: base.stats.types.Number,
  },
});

// Store when an instance is available for work
module.exports.instanceStarted = new base.stats.Series({
  name: 'AwsProvisioner.InstanceStarted',
  columns: {
    id: base.stats.types.String, // instance id
  },
});

// Store the times when a spot request is fulfilled
module.exports.spotRequestsFulfilled = new base.stats.Series({
  name: 'AwsProvisioner.SpotRequestsFulfilled',
  columns: {
    provisionerId: base.stats.types.String,
    region: base.stats.types.String,
    az: base.stats.types.String,
    instanceType: base.stats.types.String,
    workerType: base.stats.types.String,
    id: base.stats.types.String,
    instanceId: base.stats.types.String,
    // This is the true time per the ec2 api
    time: base.stats.types.Number,
    bid: base.stats.types.Number,
  },
});

// Store the times when a spot request is closed but not fulfilled
module.exports.spotRequestsDied = new base.stats.Series({
  name: 'AwsProvisioner.SpotRequestsDied',
  columns: {
    provisionerId: base.stats.types.String,
    region: base.stats.types.String,
    az: base.stats.types.String,
    instanceType: base.stats.types.String,
    workerType: base.stats.types.String,
    id: base.stats.types.String,
    // This is the true time per the ec2 api
    time: base.stats.types.Number,
    bid: base.stats.types.Number,
    state: base.stats.types.String,
    // These are the status fields
    statusCode: base.stats.types.String,
    statusMsg: base.stats.types.String,
  },
});

// Store the times when an instance terminated
module.exports.instanceTerminated = new base.stats.Series({
  name: 'AwsProvisioner.InstanceTerminated',
  columns: {
    provisionerId: base.stats.types.String,
    region: base.stats.types.String,
    az: base.stats.types.String,
    instanceType: base.stats.types.String,
    workerType: base.stats.types.String,
    id: base.stats.types.String,
    spotRequestId: base.stats.types.String,
    time: base.stats.types.Number,
    launchTime: base.stats.types.Number,
    // These are the status fields
    stateCode: base.stats.types.Number,
    stateMsg: base.stats.types.String,
    stateChangeCode: base.stats.types.String,
    stateChangeMsg: base.stats.types.String,
  },
});

// Store the minimum spot price for a given instance type in
// a region and availability zone
module.exports.spotPriceFloorFound = new base.stats.Series({
  name: 'AwsProvisioner.SpotPriceFloor',
  columns: {
    region: base.stats.types.String,
    az: base.stats.types.String,
    instanceType: base.stats.types.String,
    time: base.stats.types.Number,
    price: base.stats.types.Number,
    reason: base.stats.types.String,
  },
});

// Store when and where we use a given AMI.  This is separate
// from the spot request submission since we can use ondemand
// and I'd rather not have to change this when we start doing
// so
module.exports.amiUsage = new base.stats.Series({
  name: 'AwsProvisioner.AmiUsage',
  columns: {
    provisionerId: base.stats.types.String,
    ami: base.stats.types.String,
    region: base.stats.types.String,
    az: base.stats.types.String,
    instanceType: base.stats.types.String,
    workerType: base.stats.types.String,
  },
});

// Keep track of capacity for each workerType's provisioning iteration
module.exports.provisionerIteration = new base.stats.Series({
  name: 'AwsProvisioner.ProvisioningIteration',
  columns: {
    provisionerId: base.stats.types.String,
    workerType: base.stats.types.String,
    pendingTasks: base.stats.types.Number,
    runningCapacity: base.stats.types.Number,
    pendingCapacity: base.stats.types.Number,
    change: base.stats.types.Number,
  },
});
