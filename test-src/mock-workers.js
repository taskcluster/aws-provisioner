var _ = require('lodash');

var baseWorkerType = {
  launchSpec: {
    SecurityGroups: [
      'docker-worker',
    ],
  },
  owner: 'John',
  description: 'Mock worker type',
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
        ImageId: 'ami-c229c0a2',
      },
      secrets: {},
      userData: {},
      scopes: [],
    },
  ],
};

function makeRegion(overwrites) {
  return _.defaults(overwrites || {}, {
    region: 'us-west-2',
    launchSpec: {
      ImageId: 'ami-c229c0a2',
    },
    secrets: {},
    userData: {},
    scopes: [],
  });
}

function makeInstanceType(overwrites) {
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

function makeWorkerType(overwrites) {
  return _.defaults(overwrites || {}, baseWorkerType);
}

function makeWorkerState(state) {
  var id = 0;

  return _.defaults({}, {
    instances: state.instances.map((i) => {
      id++;
      if (typeof i === 'string') {
        i = {type: i};
      }
      return _.defaults({}, i, {
        id: 'i-' + id,
        srId: 'sir-' + id,
        ami: 'ami-1234',
        region: 'us-north-7',
        zone: 'j',
        launchTime: '2016-04-11T20:55:47.987Z',
        type: 'c3.xlarge',
        state: 'running',
      });
    }),
    requests: state.requests.map((i) => {
      id++;
      if (typeof i === 'string') {
        i = {type: i};
      }
      return _.defaults({}, i, {
        id: 'sir-' + id,
        ami: 'ami-1234',
        region: 'us-north-7',
        zone: 'j',
        time: '2016-04-11T20:55:47.987Z',
        type: 'c3.xlarge',
        status: 'running',
      });
    }),
    internalTrackedRequests: [],
  }, state);
};

module.exports = {
  baseWorkerType: baseWorkerType,
  makeRegion: makeRegion,
  makeInstanceType: makeInstanceType,
  makeWorkerType: makeWorkerType,
  makeWorkerState,
};
