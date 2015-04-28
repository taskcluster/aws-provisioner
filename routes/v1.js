'use strict';
var debug     = require('debug')('routes:v1');
var base      = require('taskcluster-base');
var objFilter = require('../lib/objFilter');
var _         = require('lodash');

// Common schema prefix
var SCHEMA_PREFIX_CONST = 'http://schemas.taskcluster.net/aws-provisioner/v1/';


/**
 * API end-point for version v1/
 *
 * In this API implementation we shall assume the following context:
 * {
 *   publisher:         // Publisher created with exchanges.js
 *   WorkerType:        // Instance of data.WorkerType
 * }
 */
var api = new base.API({
  title: 'AWS Provisioner API Documentation',
  description: [
    'The AWS Provisioner is responsible for provisioning instances on EC2 for use in',
    'TaskCluster.  The provisioner maintains a set of worker configurations which',
    'can be managed with an API that is typically available at',
    'aws-provisioner.taskcluster.net.  This API can also perform basic instance',
    'management tasks in addition to maintaining the internal state of worker type',
    'configuration information.',
    '',
    'The Provisioner runs at a configurable interval.  Each iteration of the',
    'provisioner fetches a current copy the state that the AWS EC2 api reports.  In',
    'each iteration, we ask the Queue how many tasks are pending for that worker',
    'type.  Based on the number of tasks pending and the scaling ratio, we may',
    'submit requests for new instances.  We use pricing information, capacity and',
    'utility factor information to decide which instance type in which region would',
    'be the optimal configuration.',
    '',
    'Each EC2 instance type will declare a capacity and utility factor.  Capacity is',
    'the number of tasks that a given machine is capable of running concurrently.',
    'Utility factor is a relative measure of performance between two instance types.',
    'We multiply the utility factor by the spot price to compare instance types and',
    'regions when making the bidding choices.',
    '',
  ].join('\n'),
});

module.exports = api;

api.declare({
  method:     'put',
  route:      '/worker-type/:workerType',
  name:       'createWorkerType',
  deferAuth:  true,
  scopes:     ['aws-provisioner:manage-worker-type:<workerType>'],
  input:      SCHEMA_PREFIX_CONST + 'create-worker-type-request.json#',
  output:     SCHEMA_PREFIX_CONST + 'get-worker-type-response.json#',
  title:      "Create new Worker Type",
  description: [
    'Create a worker type and ensure that all EC2 regions have the required',
    'KeyPair',
  ].join('\n'),
}, async function (req, res) {
  var input = req.body;
  var workerType = req.params.workerType;

  // Authenticate request with parameterized scope
  if(!req.satisfies({workerType: workerType})) {
    return;
  }

  // TODO: If workerType launchSpecification specifies scopes that should be given
  //       to the workers using temporary credentials, then you should validate
  //       that the caller has this scopes to avoid scope elevation.

  // We want to make sure that every single possible generated LaunchSpec
  // would be valid before we even try to store it
  try {
    this.WorkerType.testLaunchSpecs(input, this.keyPrefix, this.provisionerId);
  } catch (err) {
    // We handle invalid launch spec errors
    if (!err && err.code !== 'InvalidLaunchSpecifications') {
      throw err;
    }
    return res.status(400).json({
      message:  "Invalid launchSpecification",
      error: {
        reasons:    err.reasons
      }
    });
  }

  // Create workerType
  var wType;
  try {
    wType = await this.WorkerType.create(workerType, input);
  }
  catch(err) {
    // We only catch EntityAlreadyExists errors
    if (!err || err.code !== 'EntityAlreadyExists') {
      throw err;
    }
    wType = await this.WorkerType.load({workerType});

    // Check the it matches the existing workerType
    var match = [
      'launchSpecification',
      'minCapacity',
      'maxCapacity',
      'scalingRatio',
      'minPrice',
      'maxPrice',
      'canUseOndemand',
      'canUseSpot',
      'instanceTypes',
      'regions'
    ].every((key) => {
      return _.isEqual(wType[key], input[key]);
    });

    // If we don't have a match we return 409, otherwise we continue as this is
    // is an idempotent operation.
    if (!match) {
      return res.status(409).json({
        error:  "WorkerType already exists with different definition"
      });
    }
  }

  // Publish pulse message
  await this.publisher.workerTypeCreated({
    workerType: workerType,
  });

  return res.reply(wType.json());
});


api.declare({
  method: 'post',
  route: '/worker-type/:workerType/update',
  name: 'updateWorkerType',
  deferAuth: true,
  // Shouldn't we just have a single scope for modifying/creating/deleting workerTypes
  scopes: ['aws-provisioner:manage-worker-type:<workerType>'],
  input: SCHEMA_PREFIX_CONST + 'create-worker-type-request.json#',
  output: SCHEMA_PREFIX_CONST + 'get-worker-type-response.json#',
  title: 'Update Worker Type',
  description: [
    'Update a workerType and ensure that all regions have the require',
    'KeyPair',
  ].join('\n'),
}, async function(req, res) {
  var input = req.body;
  var workerType = req.params.workerType;

  if(!req.satisfies({workerType: workerType})) { return undefined; }

  var worker;

  try {
    this.WorkerType.testLaunchSpecs(input, this.keyPrefix, this.provisionerId);
  } catch (err) {
    // We handle invalid launch spec errors
    if (!err && err.code !== 'InvalidLaunchSpecifications') {
      throw err;
    }
    return res.status(400).json({
      message:  "Invalid launchSpecification",
      error: {
        reasons:    err.reasons
      }
    });
  }

  var wType = await this.WorkerType.load({workerType: workerType});

  await wType.modify(function(w) {
    // We know that data that gets to here is valid per-schema
    Object.keys(input).forEach(function(key) {
      w[key] = input[key];
    });
  });

  // Publish pulse message
  await this.publisher.workerTypeUpdated({
    workerType: workerType,
  });

  return res.reply(wType.json());
});


api.declare({
  method: 'get',
  route: '/worker-type/:workerType',
  name: 'workerType',
  deferAuth: true,
  scopes: [
    'aws-provisioner:view-worker-type:<workerType>',
    'aws-provisioner:manage-worker-type:<workerType>',
  ],
  input: undefined,  // No input
  output: SCHEMA_PREFIX_CONST + 'get-worker-type-response.json#',
  title: 'Get Worker Type',
  description: [
    'Retreive a WorkerType definition',
  ].join('\n'),
}, async function(req, res) {
  var workerType = req.params.workerType;

  if(!req.satisfies({workerType: workerType})) { return undefined; }

  try {
    var wType = await this.WorkerType.load({workerType: workerType});
    return res.reply(wType.json());
  } catch (err) {
    if (err.code === 'ResourceNotFound') {
      return res.status(404).json({
        error: workerType + ' does not exist',
      });
    } else {
      throw err;
    }
  }
});


// Delete workerType
// TODO: send a pulse message that a worker type was removed
api.declare({
  method: 'delete',
  route: '/worker-type/:workerType',
  name: 'removeWorkerType',
  deferAuth: true,
  // TODO: Should we have a special scope for workertype removal?
  scopes: ['aws-provisioner:manage-worker-type:<workerType>'],
  input: undefined,  // No input
  output: undefined,  // No output
  title: 'Delete Worker Type',
  description: [
    'Delete a WorkerType definition, submits requests to kill all ',
    'instances and delete the KeyPair from all configured EC2 regions',
  ].join('\n'),
}, async function(req, res) {
  var workerType = req.params.workerType;

  if(!req.satisfies({workerType: workerType})) { return undefined; }

  try {
    var wType = await this.WorkerType.load({workerType: workerType});
    await wType.remove();

    await this.publisher.workerTypeRemoved({
      workerType: workerType,
    });

    return res.reply({});
  } catch(err) {
    if (err.code === 'ResourceNotFound') {
      return res.status(404).json({
        error: workerType + ' could not be deleted'
      });
    } else {
      throw err;
    }
  }
});


api.declare({
  method: 'get',
  route: '/list-worker-types',
  name: 'listWorkerTypes',
  scopes: [
      'aws-provisioner:list-worker-types',
  ],
  input: undefined,  // No input
  output: SCHEMA_PREFIX_CONST + 'list-worker-types-response.json#',
  title: 'List Worker Types',
  description: [
    'List all known WorkerType names',
  ].join('\n'),
}, async function(req, res) {

  var list = await this.WorkerType.listWorkerTypes();

  return res.reply(list);
});


api.declare({
  method: 'get',
  route: '/worker-type/:workerType/launch-specifications',
  name: 'getLaunchSpecs',
  deferAuth: true,
  scopes: [
    'aws-provisioner:view-worker-type:<workerType>',
    'aws-provisioner:manage-worker-type:<workerType>',
  ],
  input: undefined,  // No input
  output: SCHEMA_PREFIX_CONST + 'get-launch-specs-response.json#',
  title: 'Get All Launch Specifications for WorkerType',
  description: [
    'Return the EC2 LaunchSpecifications for all combinations of regions',
    'and instance types or a list of reasons why the launch specifications',
    'are not valid',
    '',
    '**This API end-point is experimental and may be subject to change without warning.**',
  ].join('\n'),
}, async function(req, res) {
  var workerType = req.params.workerType;

  if(!req.satisfies({workerType: workerType})) { return undefined; }

  var wType = await this.WorkerType.load({workerType: workerType});

  return res.reply(wType.testLaunchSpecs());
});


api.declare({
  method: 'post',
  route: '/worker-type/:workerType/terminate-all-instances',
  name: 'terminateAllInstancesOfWorkerType',
  title: 'Shutdown Every Ec2 Instance of this Worker Type',
  scopes: [
    [
      'aws-provisioner:all-stop',
      'aws-provisioner:aws',
    ],
  ],
  description: [
    'WARNING: YOU ALMOST CERTAINLY DO NOT WANT TO USE THIS ',
    'Shut down every single EC2 instance associated with this workerType. ',
    'This means every single last one.  You probably don\'t want to use ',
    'this method, which is why it has an obnoxious name.  Don\'t even try ',
    'to claim you didn\'t know what this method does!',
    '',
    '**This API end-point is experimental and may be subject to change without warning.**',
  ].join('\n'),
}, async function(req, res) {
  var workerType = req.params.workerType;

  debug('[alert-operator] SOMEONE IS TURNING OFF ALL ' + workerType);

  await this.awsManager.killByName(workerType);

  return res.reply({
    outcome: true,
    message: 'You just turned off all ' + workerType + '.  Feel the power!',
  });
});


api.declare({
  method: 'post',
  route: '/shutdown/every/single/ec2/instance/managed/by/this/provisioner',
  name: 'shutdownEverySingleEc2InstanceManagedByThisProvisioner',
  title: 'Shutdown Every Single Ec2 Instance Managed By This Provisioner',
  scopes: [
    [
      'aws-provisioner:all-stop',
      'aws-provisioner:aws',
    ],
  ],
  description: [
    'WARNING: YOU ALMOST CERTAINLY DO NOT WANT TO USE THIS ',
    'Shut down every single EC2 instance managed by this provisioner. ',
    'This means every single last one.  You probably don\'t want to use ',
    'this method, which is why it has an obnoxious name.  Don\'t even try ',
    'to claim you didn\'t know what this method does!',
    '',
    '**This API end-point is experimental and may be subject to change without warning.**',
  ].join('\n'),
}, async function(req, res) {

  debug('SOMEONE IS TURNING EVERYTHING OFF');

  // Note that by telling the rouge killer
  await this.awsManager.rougeKiller([]);

  return res.reply({
    outcome: true,
    message: 'You just turned absolutely everything off.  Feel the power!',
  });
});

/**
 * These lists are the keys for the object filtering we'll do for their
 * respective aws state objects.
 */
var filterForSR = [
  'CreateTime',
  'State',
  'LaunchSpecification:InstanceType',
  'LaunchSpecification:ImageId',
  'LaunchSpecification:Placement:AvailabilityZone',
  'SpotInstanceRequestId',
];
var filterForInstance = [
  'InstanceId',
  'ImageId',
  'InstanceType',
  'LaunchTime',
  'Placement:AvailabilityZone',
  'SpotInstanceRequestId',
];

/**
 * The UI is going to be a lot easier if we organize by workerType name
 * instead of by region
 */
function stateForUI(state) {
  var newState = {};
  Object.keys(state).forEach(function(region) {
    var regionState = state[region];
    Object.keys(regionState).forEach(function(workerType) {
      if (!newState[workerType]) newState[workerType] = {
        running: [],
        pending: [],
        spotReq: [],
      };
      ['running', 'pending', 'spotReq'].forEach(function(nodeState) {
        var thisNodeState = newState[workerType][nodeState];
        state[region][workerType][nodeState].forEach(function(oldThing) {
          var x = _.cloneDeep(oldThing);
          if (nodeState === 'spotReq') {
            x = objFilter(x, filterForSR);
          } else {
            x = objFilter(x, filterForInstance);
          }
          x.Region = region;
          newState[workerType][nodeState].push(x);
        })
      });
    });
  });
  return newState;
}

// NOTE: there should be some sort of updateIfOlderThan function in the aws manager
// that only does the update once every X seconds.
api.declare({
  method: 'get',
  route: '/aws-state/',
  name: 'awsState',
  title: 'Get AWS State for all worker types',
  description: [
    'Documented later...',
    '',
    '**Warning** this api end-point is **not stable**'
  ].join('\n'),
}, function(req, res) {
  return res.reply(stateForUI(this.awsManager.getApi()));
});

// NOTE: there should be some sort of updateIfOlderThan function in the aws manager
// that only does the update once every X seconds.
api.declare({
  method: 'get',
  route: '/update-aws-state/',
  name: 'updateAwsState',
  title: 'Get AWS State after fetching updates for all worker types',
  description: [
    'Documented later...',
    '',
    '**Warning** this api end-point is **not stable**'
  ].join('\n'),
}, async function(req, res) {
  await this.awsManager.update();

  return res.reply(stateForUI(that.awsManager.getApi()));
});

api.declare({
  method: 'get',
  route: '/ping',
  name: 'ping',
  title: 'Ping Server',
  description: [
    'Documented later...',
    '',
    '**Warning** this api end-point is **not stable**.',
  ].join('\n'),
}, function(req, res) {
  res.status(200).json({
    alive: true,
    uptime: process.uptime(),
  });
});

api.declare({
  method: 'get',
  route: '/api-reference',
  name: 'apiReference',
  title: 'api reference',
  description: [
    'Get an API reference!',
    '',
    '**Warning** this api end-point is **not stable**.',
  ].join('\n'),
}, function(req, res) {
  var host = req.get('host');
  var proto = req.connection.encrypted ? 'https' : 'http';
  res.status(200).json(api.reference({
    baseUrl: proto + '://' + host + '/v1',
  }));
});

