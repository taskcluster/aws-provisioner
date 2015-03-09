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
  "workerType": "b2gbuild",
  "launchSpecification": {
    "SecurityGroups": [
      "docker-worker"
    ],
    "UserData": "<snip>"
  },
  "minCapacity": 500,
  "maxCapacity": 3000,
  "scalingRatio": 1.0,
  "minSpotBid": 0.1,
  "maxSpotBid": 0.3,
  "canUseOndemand": false,
  "canUseSpot": true,
  "types": {
    "c3.2xlarge": {
      "capacity": 1,
      "utility": 1,
      "overwrites": {
        "UserData": "<snip>"
      }
    }
  },
  "regions": {
    "us-west-2": {
      "overwrites": {
        "ImageId": "ami-<snip>"
      }
    }
  }
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
  x.minCapacity = 0;
  x.maxCapacity = data.maxInstances;
  x.scalingRatio = 1.0;
  x.minSpotBid = 0;
  x.maxSpotBid = parseFloat(data.spotBid);
  x.canUseOndemand = false;
  x.canUseSpot = true;
  x.types = {}
  x.types[data.launchSpecification.InstanceType] = {
    capacity: 1,
    utility: 1,
    overwrites: {
      UserData: data.launchSpecification.UserData,
    },
  },
  x.regions = {
    'us-west-2': {
      overwrites: {
        ImageId: data.launchSpecification.ImageId,
      }
    },
  };
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

