suite("Manage WorkerType", () => {
  var helper    = require('./helper');
  var slugid    = require('slugid');
  var assume    = require('assume');
  var debug     = require('debug')('test');
  var _         = require('lodash');

  var id = slugid.v4();
  var workerTypeDefinition = {
    launchSpecification: {
      "SecurityGroups": [
        "default"
      ],
      "UserData": "eyJhIjoxfQ=="
    },
    minCapacity:        4,
    maxCapacity:        30,
    scalingRatio:       1.1,
    minPrice:           0.2,
    maxPrice:           1,
    canUseOndemand:     false,
    canUseSpot:         true,
    instanceTypes: [{
      instanceType:   "m3.medium",
      capacity:       1,
      utility:        1,
      overwrites: {
        UserData:     "eyJhIjoxfQ=="
      }
    }],
    regions: [{
      region:        "us-west-1",
      overwrites: {
        ImageId:      "ami-42908907"
      }
    }]
  };


  test("createWorkerType (idempotent)", async () => {
    debug("### Create workerType");
    await helper.awsProvisioner.createWorkerType(id, workerTypeDefinition);

    debug("### Create workerType (again)");
    await helper.awsProvisioner.createWorkerType(id, workerTypeDefinition);
  });

  test("updateWorkerType", async () => {
    debug("### Load workerType");
    var wType = await helper.awsProvisioner.workerType(id);
    assume(wType.maxCapacity).equals(30);

    debug("### Update workerType");
    await helper.awsProvisioner.updateWorkerType(id, _.defaults({
      maxCapacity: 15
    }, workerTypeDefinition));

    debug("### Load workerType (again)");
    var wType = await helper.awsProvisioner.workerType(id);
    assume(wType.maxCapacity).equals(15);
  });

  test("removeWorkerType", async () => {
    debug("### Remove workerType");
    await helper.awsProvisioner.removeWorkerType(id);

    debug("### Try to load workerType");
    try {
      await helper.awsProvisioner.workerType(id);
      throw new Error("Expected and error");
    }
    catch(err) {
      assume(err.statusCode).equals(404);
    }
  });
});