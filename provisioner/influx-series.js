'use strict';

var base = require('taskcluster-base');

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
