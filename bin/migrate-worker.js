'use strict';

var program = require('commander');

/**
  Convert this (b2gbuild):

{
  "bindQueue": true,
  "launchSpecification": {
    "ImageId": "ami-<snip>",
    "InstanceType": "c3.2xlarge",
    "SecurityGroups": [
      "docker-worker"
    ],
    "UserData": "<snip>"
  },
  "maxInstances": 500,
  "spotBid": "0.3"
}

  Into this:

{
  "workerType": "test",
  "launchSpecification": {
    "SecurityGroups": [
      "default"
    ],
    "UserData": "eyJhIjoxfQ=="
  },
  "minCapacity": 1,
  "maxCapacity": 30,
  "scalingRatio": 0,
  "minPrice": 0.2,
  "maxPrice": 1,
  "canUseOndemand": false,
  "canUseSpot": true,
  "instanceTypes": [{
    "instanceType": "m3.medium",
    "capacity": 1,
    "utility": 1,
    "overwrites": {
      "UserData": "eyJhIjoxfQ=="
    }
  }, {
    "instanceType": "m3.large",
    "capacity": 1,
    "utility": 1,
    "overwrites": {
      "UserData": "eyJhIjoxfQ=="
    }
  }],
  "regions": [{
    "region": "us-west-1",
    "overwrites": {
      "ImageId": "ami-42908907"
    }
  }, {
    "region": "us-west-2",
    "overwrites": {
      "ImageId": "ami-dfc39aef"
    }
  }]
}

*/

var fs = require('fs');
var path = require('path');
var assert = require('assert');

function migrate(allData) {
  assert(allData);
  var x = {};
  x.workerType = allData.workerType;
  x.launchSpecification = {};
  // Remove the unneeded level of redirection
  var data = allData.configuration;
  try{
    assert(data);
  } catch (e) {
    console.dir(allData);
  }
  Object.keys(data.launchSpecification).forEach(function(key) {
    if (key !== 'ImageId' && key !== 'InstanceType' && key !== 'UserData') {
      x.launchSpecification[key] = data.launchSpecification[key];
    }
  });
  x.minCapacity = 1;
  x.maxCapacity = data.maxInstances;
  x.scalingRatio = 0;
  x.minPrice = 0;
  x.maxPrice = parseFloat(data.spotBid);
  x.canUseOndemand = false;
  x.canUseSpot = true;
  x.instanceTypes = [{
    instanceType: data.launchSpecification.InstanceType,
    capacity: 1,
    utility: 1,
    overwrites: {
      UserData: data.launchSpecification.UserData,
    },
  }];
  x.regions = [{
    region: 'us-west-2',
    overwrites: {
      ImageId: data.launchSpecification.ImageId,
    }
  }];

  return x;
}

program
  .version('1')
  .description('Convert an old workerType definition into a new one')

program.parse(process.argv);

program.args.forEach(function(file) {
  var data = JSON.parse(fs.readFileSync(file));
  var migrated = migrate(data);
  console.log(file);
  var output = path.join(__dirname, '..', 'new-workers', data.workerType + '.json');
  fs.writeFileSync(output, JSON.stringify(migrated, null, 2) + '\n');
});

