let stats = require('taskcluster-lib-stats');

// This is a time series to measure how long it takes for instances to show up
// in the AWS api responses
module.exports.ec2ApiLag = new stats.Series({
  name: 'AwsProvisioner.Ec2ApiLag',
  columns: {
    provisionerId: stats.types.String,
    region: stats.types.String,
    az: stats.types.String,
    instanceType: stats.types.String,
    workerType: stats.types.String,
    id: stats.types.String,
    // other columns should be obvious.
    // This column is 0 for it showed up somehow, somewhere
    // and 1 for being dropped on the floor
    didShow: stats.types.Number,
    // How many seconds to show up in API.  This is a maximum
    // bound since we only check the API once every iteration
    lag: stats.types.Number,
  },
});

// Store the spot requests which we submit
module.exports.spotRequestsSubmitted = new stats.Series({
  name: 'AwsProvisioner.SpotRequestsSubmitted',
  columns: {
    provisionerId: stats.types.String,
    region: stats.types.String,
    az: stats.types.String,
    instanceType: stats.types.String,
    workerType: stats.types.String,
    id: stats.types.String,
    // Both the bid and price will be the pre-safety factor number
    bid: stats.types.Number,
    price: stats.types.Number,
    bias: stats.types.Number,
  },
});

// Store when an instance is available for work
module.exports.instanceStarted = new stats.Series({
  name: 'AwsProvisioner.InstanceStarted',
  columns: {
    id: stats.types.String, // instance id
  },
});

// Store the times when a spot request is fulfilled
module.exports.spotRequestsFulfilled = new stats.Series({
  name: 'AwsProvisioner.SpotRequestsFulfilled',
  columns: {
    provisionerId: stats.types.String,
    region: stats.types.String,
    az: stats.types.String,
    instanceType: stats.types.String,
    workerType: stats.types.String,
    id: stats.types.String,
    instanceId: stats.types.String,
    // This is the true time per the ec2 api
    time: stats.types.Number,
    bid: stats.types.Number,
  },
});

// Store the times when a spot request is closed but not fulfilled
module.exports.spotRequestsDied = new stats.Series({
  name: 'AwsProvisioner.SpotRequestsDied',
  columns: {
    provisionerId: stats.types.String,
    region: stats.types.String,
    az: stats.types.String,
    instanceType: stats.types.String,
    workerType: stats.types.String,
    id: stats.types.String,
    // This is the true time per the ec2 api
    time: stats.types.Number,
    bid: stats.types.Number,
    state: stats.types.String,
    // These are the status fields
    statusCode: stats.types.String,
    statusMsg: stats.types.String,
  },
});

// Store the times when an instance terminated
module.exports.instanceTerminated = new stats.Series({
  name: 'AwsProvisioner.InstanceTerminated',
  columns: {
    provisionerId: stats.types.String,
    region: stats.types.String,
    az: stats.types.String,
    instanceType: stats.types.String,
    workerType: stats.types.String,
    id: stats.types.String,
    spotRequestId: stats.types.String,
    time: stats.types.Number,
    launchTime: stats.types.Number,
    // These are the status fields
    stateCode: stats.types.Number,
    stateMsg: stats.types.String,
    stateChangeCode: stats.types.String,
    stateChangeMsg: stats.types.String,
  },
});

// Store the minimum spot price for a given instance type in
// a region and availability zone
module.exports.spotPriceFloorFound = new stats.Series({
  name: 'AwsProvisioner.SpotPriceFloor',
  columns: {
    region: stats.types.String,
    az: stats.types.String,
    instanceType: stats.types.String,
    time: stats.types.Number,
    price: stats.types.Number,
    reason: stats.types.String,
  },
});

// Store when and where we use a given AMI.  This is separate
// from the spot request submission since we can use ondemand
// and I'd rather not have to change this when we start doing
// so
module.exports.amiUsage = new stats.Series({
  name: 'AwsProvisioner.AmiUsage',
  columns: {
    provisionerId: stats.types.String,
    ami: stats.types.String,
    region: stats.types.String,
    az: stats.types.String,
    instanceType: stats.types.String,
    workerType: stats.types.String,
  },
});

// Keep track of the duration of each provisioning iteration
module.exports.allProvisioningIterationDuration = new stats.Series({
  name: 'AwsProvisioner.AllProvisioningIterationDuration',
  columns: {
    provisionerId: stats.types.String,
    duration: stats.types.Number,
  },
});

// Keep track of capacity for each workerType's provisioning iteration
module.exports.provisionerIteration = new stats.Series({
  name: 'AwsProvisioner.ProvisioningIteration',
  columns: {
    provisionerId: stats.types.String,
    workerType: stats.types.String,
    pendingTasks: stats.types.Number,
    runningCapacity: stats.types.Number,
    pendingCapacity: stats.types.Number,
    change: stats.types.Number,
  },
});
