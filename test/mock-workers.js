'use strict';

var _ = require('lodash');

var baseWorkerType = {
  launchSpec: {
    SecurityGroups: [
      'docker-worker',
    ],
  },
  //lastModified: new Date(),
  minCapacity: 0,
  maxCapacity: 20,
  scalingRatio: 0,
  minPrice: 0,
  maxPrice: 0.5,
  canUseOndemand: false,
  canUseSpot: true,
  scopes: [],
  secrets: {},
  userData: {},
  instanceTypes: [
    {
      instanceType: 'c3.xlarge',
      capacity: 1,
      utility: 1,
      launchSpec: {},
      secrets: {},
      userData: {},
      scopes: [],
    },
    {
      instanceType: 'c3.2xlarge',
      capacity: 2,
      utility: 2,
      launchSpec: {},
      secrets: {},
      userData: {},
      scopes: [],
    },
  ],
  regions: [
    {
      region: 'us-west-2',
      launchSpec: {
        ImageId: 'ami-1dfcd32d',
      },
      secrets: {},
      userData: {},
      scopes: [],
    },
  ],
};

function makeRegion (overwrites) {
  return _.defaults(overwrites || {}, {
    region: 'us-west-2',
    launchSpec: {
      ImageId: 'ami-1bdf21d',
    },
    secrets: {},
    userData: {},
    scopes: [],
  });
}

function makeInstanceType (overwrites) {
  return _.defaults(overwrites || {}, {
    instanceType: 't1.micro',
    capacity: 1,
    utility: 1,
    launchSpec: {},
    secrets: {},
    userData: {},
    scopes: [],
  });
}

function makeWorkerType (overwrites) {
  return _.defaults(overwrites || {}, baseWorkerType);
}

module.exports = {
  baseWorkerType: baseWorkerType,
  makeRegion: makeRegion,
  makeInstanceType: makeInstanceType,
  makeWorkerType: makeWorkerType,
};
