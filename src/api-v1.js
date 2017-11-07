let log = require('./log');
let API = require('taskcluster-lib-api');
let taskcluster = require('taskcluster-client');
let amiExists = require('./check-for-ami');
let _ = require('lodash');
let rp = require('request-promise');
let url = require('url');
let assert = require('assert');

let SLUGID_PATTERN = /^[A-Za-z0-9_-]{8}[Q-T][A-Za-z0-9_-][CGKOSWaeimquy26-][A-Za-z0-9_-]{10}[AQgw]$/;
let GENERIC_ID_PATTERN = /^[a-zA-Z0-9-_]{1,22}$/;
let EC2_INSTANCE_ID_PATTERN = /^i-[a-fA-F0-9]{8}$/;

/**
 * API end-point for version v1/
 *
 * In this API implementation we shall assume the following context:
 * {
 *   publisher:         // Publisher created with exchanges.js
 *   WorkerType:        // Instance of data.WorkerType
 * }
 */
let api = new API({
  title: 'AWS Provisioner API Documentation',
  description: [
    'The AWS Provisioner is responsible for provisioning instances on EC2 for use in',
    'Taskcluster.  The provisioner maintains a set of worker configurations which',
    'can be managed with an API that is typically available at',
    'aws-provisioner.taskcluster.net/v1.  This API can also perform basic instance',
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
    'When a new EC2 instance is instantiated, its user data contains a token in',
    '`securityToken` that can be used with the `getSecret` method to retrieve',
    'the worker\'s credentials and any needed passwords or other restricted',
    'information.  The worker is responsible for deleting the secret after',
    'retrieving it, to prevent dissemination of the secret to other proceses',
    'which can read the instance user data.',
    '',
  ].join('\n'),
  schemaPrefix: 'http://schemas.taskcluster.net/aws-provisioner/v1/',
  params: {
    workerType: GENERIC_ID_PATTERN,
    provisionerId: GENERIC_ID_PATTERN,
    token: SLUGID_PATTERN,
    instanceId: EC2_INSTANCE_ID_PATTERN,
  },
});

/**
 * Calculate some summary statistics for a worker type, based on the given
 * worker state.
 */
function workerTypeSummary(workerType, workerState) {
  let summary = {
    workerType: workerType.workerType,
    minCapacity: workerType.minCapacity,
    maxCapacity: workerType.maxCapacity,
    requestedCapacity: 0,
    pendingCapacity: 0,
    runningCapacity: 0,
  };

  if (!workerState) {
    return summary;
  }

  let capacities = {};

  workerType.instanceTypes.forEach(instanceType => {
    capacities[instanceType.instanceType] = instanceType.capacity;
  });

  for (let resource of workerState.running) {
    let change = (capacities[resource.instanceType] || 1) * resource.count;
    summary.runningCapacity += change;
  }

  for (let resource of workerState.pending) {
    let change = (capacities[resource.instanceType] || 1) * resource.count;
    if (resource.type === 'instance') {
      summary.pendingCapacity += change;
    } else {
      summary.requestedCapacity += change;
    }
  }

  return summary;
}

module.exports = api;

api.declare({
  method: 'get',
  route: '/list-worker-type-summaries',
  name: 'listWorkerTypeSummaries',
  input: undefined,  // No input
  output: 'list-worker-types-summaries-response.json#',
  title: 'List worker types with details',
  stability:  API.stability.stable,
  description: [
    'Return a list of worker types, including some summary information about',
    'current capacity for each.  While this list includes all defined worker types,',
    'there may be running EC2 instances for deleted worker types that are not',
    'included here.  The list is unordered.',
  ].join('\n'),
}, async function(req, res) {
  // gather workerType information
  let workerTypes = [];
  await this.WorkerType.scan({}, {
    handler: (item) => workerTypes.push(item),
  });

  // now gather worker state information for each one, in parallel
  let result = await Promise.all(workerTypes.map(async (workerType) => {
    let workerStats = await this.ec2manager.workerTypeStats(workerType.workerType);
    return workerTypeSummary(workerType, workerStats);
  }));

  return res.reply(result);
});

api.declare({
  method: 'put',
  route: '/worker-type/:workerType',
  name: 'createWorkerType',
  deferAuth: true,
  scopes: [['aws-provisioner:manage-worker-type:<workerType>']],
  input: 'create-worker-type-request.json#',
  output: 'get-worker-type-response.json#',
  title: 'Create new Worker Type',
  stability:  API.stability.stable,
  description: [
    'Create a worker type.  A worker type contains all the configuration',
    'needed for the provisioner to manage the instances.  Each worker type',
    'knows which regions and which instance types are allowed for that',
    'worker type.  Remember that Capacity is the number of concurrent tasks',
    'that can be run on a given EC2 resource and that Utility is the relative',
    'performance rate between different instance types.  There is no way to',
    'configure different regions to have different sets of instance types',
    'so ensure that all instance types are available in all regions.',
    'This function is idempotent.',
    '',
    'Once a worker type is in the provisioner, a back ground process will',
    'begin creating instances for it based on its capacity bounds and its',
    'pending task count from the Queue.  It is the worker\'s responsibility',
    'to shut itself down.  The provisioner has a limit (currently 96hours)',
    'for all instances to prevent zombie instances from running indefinitely.',
    '',
    'The provisioner will ensure that all instances created are tagged with',
    'aws resource tags containing the provisioner id and the worker type.',
    '',
    'If provided, the secrets in the global, region and instance type sections',
    'are available using the secrets api.  If specified, the scopes provided',
    'will be used to generate a set of temporary credentials available with',
    'the other secrets.',
  ].join('\n'),
}, async function(req, res) {
  let input = req.body;
  let workerType = req.params.workerType;

  if (!input.availabilityZones) {
    input.availabilityZones = [];
  }

  input.lastModified = new Date();

  // Authenticate request with parameterized scope
  if (!req.satisfies({workerType: workerType})) {
    return;
  }

  let workerForValidation = _.defaults({}, {workerType: workerType}, input);

  // Let's double check that this worker type would be launchable
  let launchInfo = await this.awsManager.workerTypeCanLaunch(workerForValidation, this.WorkerType);
  if (!launchInfo.canLaunch) {
    log.debug({launchInfo}, 'cannot launch this worker type submission');
    let reasons = launchInfo.reasons.map(e => e.toString());
    return res.reportError(
      'InputError',
      'Invalid workerType: ' + reasons.join('; '),
      {reasons});
  }

  // Create workerType
  let wType;
  try {
    wType = await this.WorkerType.create(workerType, input);
  } catch (err) {
    // We only catch EntityAlreadyExists errors
    if (!err || err.code !== 'EntityAlreadyExists') {
      throw err;
    }
    wType = await this.WorkerType.load({workerType});

    // Check the it matches the existing workerType
    let match = [
      'launchSpec',
      'userData',
      'secrets',
      'scopes',
      'minCapacity',
      'maxCapacity',
      'scalingRatio',
      'minPrice',
      'maxPrice',
      'canUseOndemand',
      'canUseSpot',
      'instanceTypes',
      'regions',
      'availabilityZones',
    ].every((key) => {
      return _.isEqual(wType[key], input[key]);
    });

    // If we don't have a match we return 409, otherwise we continue as this is
    // is an idempotent operation.
    if (!match) {
      res.status(409).json({
        error: 'WorkerType already exists with different definition',
      });
      return;
    }
  }

  // Publish pulse message
  await this.publisher.workerTypeCreated({
    workerType: workerType,
  });

  await wType.declareWorkerType();

  // There was a typo a while ago and it meant that the results from this
  // function weren't valid per the schema.  This shouldn't really be neeeded
  // anymore, but left in because it's harmless and there might still be an
  // entity or two that require it
  let workerjson = wType.json();
  delete workerjson.canUseOnDemand;
  workerjson.canUseOndemand = false;
  res.reply(workerjson);
  return;
});

api.declare({
  method: 'post',
  route: '/worker-type/:workerType/update',
  name: 'updateWorkerType',
  deferAuth: true,
  scopes: [['aws-provisioner:manage-worker-type:<workerType>']],
  input: 'create-worker-type-request.json#',
  output: 'get-worker-type-response.json#',
  title: 'Update Worker Type',
  stability:  API.stability.stable,
  description: [
    'Provide a new copy of a worker type to replace the existing one.',
    'This will overwrite the existing worker type definition if there',
    'is already a worker type of that name.  This method will return a',
    '200 response along with a copy of the worker type definition created',
    'Note that if you are using the result of a GET on the worker-type',
    'end point that you will need to delete the lastModified and workerType',
    'keys from the object returned, since those fields are not allowed',
    'the request body for this method',
    '',
    'Otherwise, all input requirements and actions are the same as the',
    'create method.',
  ].join('\n'),
}, async function(req, res) {
  let input = req.body;
  let workerType = req.params.workerType;

  let modDate = new Date();

  if (!input.availabilityZones) {
    input.availabilityZones = [];
  }

  input.lastModified = modDate;

  if (!req.satisfies({workerType: workerType})) { return undefined; }

  let workerForValidation = _.defaults({}, {workerType: workerType}, input);

  // Let's double check that this worker type would be launchable
  let launchInfo = await this.awsManager.workerTypeCanLaunch(workerForValidation, this.WorkerType);
  if (!launchInfo.canLaunch) {
    log.debug({launchInfo}, 'cannot launch this worker type submission');
    let reasons = launchInfo.reasons.map(e => e.toString());
    return res.reportError(
      'InputError',
      'Invalid workerType: ' + reasons.join('; '),
      {reasons});
  }

  let wType = await this.WorkerType.load({workerType: workerType});

  await wType.modify(function(w) {
    // We know that data that gets to here is valid per-schema
    for (let key of Object.keys(input)) {
      w[key] = input[key];
      w.lastModified = modDate;
    }
  });

  // Publish pulse message
  await this.publisher.workerTypeUpdated({
    workerType: workerType,
  });

  await wType.declareWorkerType();

  return res.reply(wType.json());
});

api.declare({
  method: 'get',
  route: '/worker-type-last-modified/:workerType',
  name: 'workerTypeLastModified',
  input: undefined,  // No input
  output: 'get-worker-type-last-modified.json#',
  title: 'Get Worker Type Last Modified Time',
  stability:  API.stability.stable,
  description: [
    'This method is provided to allow workers to see when they were',
    'last modified.  The value provided through UserData can be',
    'compared against this value to see if changes have been made',
    'If the worker type definition has not been changed, the date',
    'should be identical as it is the same stored value.',
    
  ].join('\n'),
}, async function(req, res) {
  let workerType = req.params.workerType;

  let worker;
  try {
    worker = await this.WorkerType.load({workerType: workerType});

    // We do this because John made a mistake in the V1->V2
    // schema update and there was a typo :(
    let workerjson = worker.json();
    return res.reply(_.pick(workerjson, 'workerType', 'lastModified'));
  } catch (err) {
    if (err.code === 'ResourceNotFound') {
      res.status(404).json({
        error: err.code,
        msg: workerType + ' not found',
      });
    } else {
      throw err;
    }
  }
});

api.declare({
  method: 'get',
  route: '/worker-type/:workerType',
  name: 'workerType',
  deferAuth: true,
  scopes: [
    ['aws-provisioner:view-worker-type:<workerType>'],
    ['aws-provisioner:manage-worker-type:<workerType>'],
  ],
  input: undefined,  // No input
  output: 'get-worker-type-response.json#',
  title: 'Get Worker Type',
  stability:  API.stability.stable,
  description: [
    'Retrieve a copy of the requested worker type definition.',
    'This copy contains a lastModified field as well as the worker',
    'type name.  As such, it will require manipulation to be able to',
    'use the results of this method to submit date to the update',
    'method.',
  ].join('\n'),
}, async function(req, res) {
  let workerType = req.params.workerType;

  if (!req.satisfies({workerType: workerType})) { return undefined; }

  let worker;
  try {
    worker = await this.WorkerType.load({workerType: workerType});

    // We do this because John made a mistake in the V1->V2
    // schema update and there was a typo :(
    let workerjson = worker.json();
    workerjson.canUseOndemand = false;
    delete workerjson.canUseOnDemand;

    return res.reply(workerjson);
  } catch (err) {
    if (err.code === 'ResourceNotFound') {
      res.status(404).json({
        error: err.code,
        msg: workerType + ' not found',
      });
    } else {
      throw err;
    }
  }
});

api.declare({
  method:     'delete',
  route:      '/killWorker',
  // actions with context=worker will a query of the form ?provisionerId=...&workerType=...&workerGroup=...&workerId=...
  // https://docs.taskcluster.net/reference/platform/taskcluster-queue/docs/actions#context
  query: {
    provisionerId: /./,
    workerType: /./,
    workerGroup: /./,
    workerId: /./,
  },
  name:       'killWorker',
  scopes: [['aws-provisioner:kill-worker:<provisionerId>/<workerType>/<workerGroup>/<workerId>']],
  input:      undefined,
  output:     undefined,
  title:      'Kill a Worker',
  stability:  API.stability.experimental,
  description: [
    'Kill an AWS worker by supplying a query with its region (workerGroup) and instanceId (workerId).',
  ].join('\n'),
}, async function(req, res) {
  const {workerGroup, workerId} = req.query;

  if (!workerGroup || !workerId) {
    res.status(400).end();
  }

  try {
    await this.ec2manager.terminateInstance(workerGroup, workerId);
    res.status(204).end();
  } catch (err) {
    if (err.code === 'ResourceNotFound') {
      res.status(204).end();
    } else {
      throw err;
    }
  }
});

api.declare({
  method: 'delete',
  route: '/worker-type/:workerType',
  name: 'removeWorkerType',
  deferAuth: true,
  scopes: [['aws-provisioner:manage-worker-type:<workerType>']],
  input: undefined,  // No input
  output: undefined,  // No output
  title: 'Delete Worker Type',
  stability:  API.stability.stable,
  description: [
    'Delete a worker type definition.  This method will only delete',
    'the worker type definition from the storage table.  The actual',
    'deletion will be handled by a background worker.  As soon as this',
    'method is called for a worker type, the background worker will',
    'immediately submit requests to cancel all spot requests for this',
    'worker type as well as killing all instances regardless of their',
    'state.  If you want to gracefully remove a worker type, you must',
    'either ensure that no tasks are created with that worker type name',
    'or you could theoretically set maxCapacity to 0, though, this is',
    'not a supported or tested action',
  ].join('\n'),
}, async function(req, res) {
  let that = this;
  let workerType = req.params.workerType;

  if (!req.satisfies({workerType: workerType})) { return undefined; }

  try {
    await this.WorkerType.remove({workerType: workerType}, true);
    await that.publisher.workerTypeRemoved({
      workerType: workerType,
    });
    res.status(204).end();
  } catch (err) {
    if (err.code === 'ResourceNotFound') {
      res.status(204).end();
    } else {
      throw err;
    }
  }
});

api.declare({
  method: 'get',
  route: '/list-worker-types',
  name: 'listWorkerTypes',
  input: undefined,  // No input
  output: 'list-worker-types-response.json#',
  title: 'List Worker Types',
  stability:  API.stability.stable,
  description: [
    'Return a list of string worker type names.  These are the names',
    'of all managed worker types known to the provisioner.  This does',
    'not include worker types which are left overs from a deleted worker',
    'type definition but are still running in AWS.',
  ].join('\n'),
}, async function(req, res) {

  let list = await this.WorkerType.listWorkerTypes();
  return res.reply(list);
});

api.declare({
  method: 'put',
  route: '/secret/:token',
  name: 'createSecret',
  scopes: [['aws-provisioner:create-secret:<workerType>']],
  input: 'create-secret-request.json#',
  title: 'Create new Secret',
  stability:  API.stability.stable,
  description: [
    'Insert a secret into the secret storage.  The supplied secrets will',
    'be provided verbatime via `getSecret`, while the supplied scopes will',
    'be converted into credentials by `getSecret`.',
    '',
    'This method is not ordinarily used in production; instead, the provisioner',
    'creates a new secret directly for each spot bid.',
  ].join('\n'),
}, async function(req, res) {
  let input = req.body;
  let token = req.params.token;

  if (!req.satisfies({workerType: input.workerType})) { return undefined; }

  let secret;
  try {
    secret = await this.Secret.create({
      token: token,
      workerType: input.workerType,
      availabilityZones: [],
      secrets: input.secrets,
      scopes: input.scopes,
      expiration: new Date(input.expiration),
    });
  } catch (err) {
    if (err.code !== 'EntityAlreadyExists') {
      throw err;
    }

    secret = await this.Secret.load({
      token: token,
      provisionerId: this.provisionerId,
    });

    let match = [
      'workerType',
      'secrets',
      'token',
      'scopes',
      //'expiration' weird stuff is happening here.  going to assume that
      // we should probably do some sort of Date.toISOString() comparison or something
    ].every((key) => {
      return _.isEqual(secret[key], input[key]);
    });

    // If we don't have a match we return 409, otherwise we continue as this is
    // is an idempotent operation.
    if (!match) {
      res.status(409).json({
        error: 'Secret already exists with different definition',
      });
      return;
    }
  }

  res.reply({outcome: 'success'});
  return;
});

api.declare({
  method: 'get',
  route: '/secret/:token',
  name: 'getSecret',
  output: 'get-secret-response.json#',
  title: 'Get a Secret',
  stability:  API.stability.stable,
  description: [
    'Retrieve a secret from storage.  The result contains any passwords or',
    'other restricted information verbatim as well as a temporary credential',
    'based on the scopes specified when the secret was created.',
    '',
    'It is important that this secret is deleted by the consumer (`removeSecret`),',
    'or else the secrets will be visible to any process which can access the',
    'user data associated with the instance.',
  ].join('\n'),
}, async function(req, res) {
  let token = req.params.token;

  try {
    let secret = await this.Secret.load({
      token: token,
    });

    return res.reply({
      data: secret.secrets,
      scopes: secret.scopes,
      credentials: taskcluster.createTemporaryCredentials({
        scopes: [
          `assume:worker-type:${this.provisionerId}/${secret.workerType}`,
          'assume:worker-id:*',
        ],
        expiry: taskcluster.fromNow('96 hours'),
        credentials: this.credentials,
      }),
    });
  } catch (err) {
    if (err.code === 'ResourceNotFound') {
      res.status(404).end();
    } else {
      throw err;
    }
  }
});

api.declare({
  method: 'get',
  route: '/instance-started/:instanceId/:token',
  name: 'instanceStarted',
  title: 'Report an instance starting',
  stability:  API.stability.stable,
  description: [
    'An instance will report in by giving its instance id as well',
    'as its security token.  The token is given and checked to ensure',
    'that it matches a real token that exists to ensure that random',
    'machines do not check in.  We could generate a different token',
    'but that seems like overkill',
  ].join('\n'),
}, async function(req, res) {
  let instanceId = req.params.instanceId;
  let token = req.params.token;

  try {
    await this.Secret.load({
      token: token,
    });

    return res.status(204).end();
  } catch (err) {
    throw err;
  }
});

api.declare({
  method: 'delete',
  route: '/secret/:token',
  name: 'removeSecret',
  title: 'Remove a Secret',
  stability:  API.stability.stable,
  description: [
    'Remove a secret.  After this call, a call to `getSecret` with the given',
    'token will return no information.',
    '',
    'It is very important that the consumer of a ',
    'secret delete the secret from storage before handing over control',
    'to untrusted processes to prevent credential and/or secret leakage.',
  ].join('\n'),
}, async function(req, res) {
  let token = req.params.token;

  try {
    await this.Secret.remove({
      token: token,
    }, true);
    res.status(204).end();
  } catch (err) {
    if (err.code === 'ResourceNotFound') {
      res.status(204).end();
    } else {
      throw err;
    }
  }
});

/** Utility methods below */

api.declare({
  method: 'get',
  route: '/worker-type/:workerType/launch-specifications',
  name: 'getLaunchSpecs',
  deferAuth: true,
  scopes: [
    ['aws-provisioner:view-worker-type:<workerType>'],
    ['aws-provisioner:manage-worker-type:<workerType>'],
  ],
  input: undefined,  // No input
  output: 'get-launch-specs-response.json#',
  title: 'Get All Launch Specifications for WorkerType',
  stability:  API.stability.experimental,
  description: [
    'This method returns a preview of all possible launch specifications',
    'that this worker type definition could submit to EC2.  It is used to',
    'test worker types, nothing more',
    '',
    '**This API end-point is experimental and may be subject to change without warning.**',
  ].join('\n'),
}, async function(req, res) {
  let workerType = req.params.workerType;

  if (!req.satisfies({workerType: workerType})) { return undefined; }

  let worker = await this.WorkerType.load({workerType: workerType});
  let outcome;
  try {
    outcome = worker.testLaunchSpecs();
  } catch (err) {
    outcome = [];
    if (err.reasons) {
      for (let e of err.reasons) {
        console.error(e, e.stack);
        outcome.push({error: e, stack: e.stack});
      }
    }
  } finally {
    return res.reply(outcome);
  }
});

api.declare({
  method: 'get',
  route: '/state/:workerType',
  name: 'state',
  title: 'Get AWS State for a worker type',
  deferAuth: true,
  stability:  API.stability.stable,
  description: [
    'Return the state of a given workertype as stored by the provisioner. ',
    'This state is stored as three lists: 1 for running instances, 1 for',
    'pending requests.  The `summary` property contains an updated summary',
    'similar to that returned from `listWorkerTypeSummaries`.',
  ].join('\n'),
}, async function(req, res) {
  let workerType;

  try {
    workerType = await this.WorkerType.load({workerType: req.params.workerType});
  } catch (err) {
    if (err.code === 'ResourceNotFound') {
      res.status(404).json({
        message: req.params.workerType + ' does not have any state information',
      }).end();
    } else {
      throw err;
    }
  }

  let [workerState, workerStats] = await Promise.all([
    this.ec2manager.workerTypeState(workerType.workerType),
    this.ec2manager.workerTypeStats(workerType.workerType),
  ]);

  let instances = [];
  let requests = [];

  if (workerState) {
    for (let instance of workerState.instances) {
      instances.push({
        id: instance.id,
        srId: instance.srid || 'ondemand',
        ami: instance.imageid,
        type: instance.instancetype,
        region: instance.region,
        zone: instance.az,
        state: instance.state,
        launch: instance.launched,
      });
    }

    for (let request of workerState.requests) {
      requests.push({
        id: request.id,
        ami: request.imageid,
        type: request.instancetype,
        region: request.region,
        zone: request.az,
        time: request.created,
        visibleToEC2Api: true,
        status: request.status,
        state: request.state,
      });
    }
  }

  res.reply({
    workerType: workerType.workerType,
    instances: instances,
    requests: requests,
    // here for compatibility with the UI
    internalTrackedRequests: [],
    summary: workerTypeSummary(workerType, workerStats),
  });
});

api.declare({
  method: 'get',
  route: '/backend-status',
  name: 'backendStatus',
  title: 'Backend Status',
  stability:  API.stability.experimental,
  output: 'backend-status-response.json#',
  description: [
    'This endpoint is used to show when the last time the provisioner',
    'has checked in.  A check in is done through the deadman\'s snitch',
    'api.  It is done at the conclusion of a provisioning iteration',
    'and used to tell if the background provisioning process is still',
    'running.',
    '',
    '**Warning** this api end-point is **not stable**.',
  ].join('\n'),
}, async function(req, res) {
  let endpoint = 'https://api.deadmanssnitch.com/v1/snitches/';
  endpoint += url.parse(this.iterationSnitch).pathname.split('/').slice(-1);

  let snitch = await rp.get(endpoint, {
    auth: {
      username: this.dmsApiKey,
      password: '',
      sendImmediately: true,
    },
  });
  snitch = JSON.parse(snitch);
  res.reply({
    status: snitch.status,
    lastCheckedIn: snitch.checked_in_at,
  });
});
