let debug = require('debug')('routes:v1');
let base = require('taskcluster-base');
let taskcluster = require('taskcluster-client');
let amiExists = require('./check-for-ami');
let _ = require('lodash');
let rp = require('request-promise');
let url = require('url');
let assert = require('assert');
let slugid = require('slugid');

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
let api = new base.API({
  title: 'AWS Provisioner API Documentation',
  description: [
    'The AWS Provisioner is responsible for provisioning instances on EC2 for use in',
    'TaskCluster.  The provisioner maintains a set of worker configurations which',
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
 * Do nothing if a workerType is valid and should be added and throw Exception
 * with a '.reasons' attribute with a list of reasons why it is invalid if it's
 * not valid
 */
async function validateWorkerType (ctx, workerTypeName, workerType) {
  assert(typeof ctx === 'object', 'context must be an object');
  assert(typeof workerTypeName === 'string', 'workerTypeName must be string');
  assert(typeof workerType === 'object', 'workerType must be object');

  let reasons = [];

  // First let's ensure that the launch specs are valid and able to be
  // generated
  let launchSpecs = [];
  try {
    launchSpecs = ctx.WorkerType.testLaunchSpecs(
        workerType,
        ctx.keyPrefix,
        ctx.provisionerId,
        ctx.provisionerBaseUrl,
        ctx.pubKey,
        workerType);
    debug(`generated launch specifications for ${workerTypeName}`);
  } catch (err) {
    // We don't want to handle other things breaking, just badly formed worker
    // types
    debug(`could not generate launch specifications for ${workerTypeName}`);
    if (err && err.code !== 'InvalidLaunchSpecifications') {
      throw err;
    }
    reasons.concat(err.reasons);
  }

  await Promise.all(_.map(launchSpecs, async (region, regionName) => {
    await Promise.all(_.map(region, async (type, typeName) => {
      let launchSpec = type.launchSpec;
      // We delete the Placement.AvailabilityZone key because we aren't don't
      // know which AZ to test for and this shouldn't matter for these purposes
      if (launchSpec.Placement && launchSpec.Placement.AvailabilityZone) {
        delete launchSpec.Placement.AvailabilityZone;
      }
      // Next, let's check if the launch spec has valid parameters
      try {
        await ctx.ec2[regionName].requestSpotInstances({
          DryRun: true,
          InstanceCount: 1,
          Type: 'one-time',
          LaunchSpecification: launchSpec,
          SpotPrice: '1', // Only since this is a DryRun:true call
        }).promise();
        debug(`did DryRun of requesting spot instance for ${workerTypeName}`);
      } catch (err) {
        if (err.code !== 'DryRunOperation') {
          debug(`could not do a DryRun of requesting spot instance for ${workerTypeName}`);
          reasons.push(err);
        }
      }
      let images = [];
      try {
        images = await ctx.ec2[regionName].describeImages({
          ImageIds: [launchSpec.ImageId],
        }).promise();
        if (images.data.Images.length !== 1) {
          reasons.push(new Error(`Too many results found for ${launchSpec.ImageId}`)); 
        }
        let image = images.data.Images[0];
        if (image.ImageId !== launchSpec.ImageId) {
          reasons.push(new Error(`Image ID returned from EC2 api ${image.ImageId}` +
                  ` does not match launch spec ${launchSpec.ImageId}`));
        }
        if (image.State !== 'available') {
          reasons.push(new Error(`Image state for ${launchSpec.ImageId} must be 'available' not ${image.State}`));
        }
      } catch (err) {
        reasons.push(err);
      }
    }));
  }));

  // Finally, let's verify that the image for this workerType exists in EC2

  if (reasons.length > 0) {
    debug('Found errors with ' + workerTypeName); 
    let e = new Error('Refusing to create an invalid worker type');
    e.reasons = reasons;
    throw e;
  }

}

/**
 * Calculate some summary statistics for a worker type, based on the given
 * WorkerState.
 */
function workerTypeSummary (workerType, workerState) {
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

  workerState.instances.forEach(instance => {
    if (instance.state === 'running') {
      summary.runningCapacity += capacities[instance.type] || 0;
    } else if (instance.state === 'pending') {
      summary.pendingCapacity += capacities[instance.type] || 0;
    } // note that other states are ignored
  });

  workerState.requests.forEach(request => {
    summary.requestedCapacity += capacities[request.type] || 0;
  });

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
  stability:  base.API.stability.stable,
  description: [
    'Return a list of worker types, including some summary information about',
    'current capacity for each.  While this list includes all defined worker types,',
    'there may be running EC2 instances for deleted worker types that are not',
    'included here.  The list is unordered.',
  ].join('\n'),
}, async function (req, res) {
  try {
    // gather workerType information
    let workerTypes = [];
    await this.WorkerType.scan({}, {
      handler: (item) => workerTypes.push(item),
    });

    // now gather worker state information for each one, in parallel
    let result = await Promise.all(workerTypes.map(async (workerType) => {
      let workerState;
      try {
        workerState = await this.WorkerState.load({workerType: workerType.workerType});
      } catch (err) {
        if (err.code !== 'ResourceNotFound') {
          throw err;
        }
      }
      return workerTypeSummary(workerType, workerState);
    }));

    return res.reply(result);
  } catch (err) {
    debug('error listing workertypes');
    debug(err);
    if (err.stack) {
      debug(err.stack);
    }
    throw err;
  }
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
  stability:  base.API.stability.stable,
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
}, async function (req, res) {
  let input = req.body;
  let workerType = req.params.workerType;

  input.lastModified = new Date();

  // Authenticate request with parameterized scope
  if (!req.satisfies({workerType: workerType})) {
    return;
  }

  // TODO: If workerType launchSpecification specifies scopes that should be given
  //       to the workers using temporary credentials, then you should validate
  //       that the caller has this scopes to avoid scope elevation.

  // We want to make sure that all AMIs that we are submitting are valid
  let missing = [];
  await Promise.all(input.regions.map(async (def) => {
    let exists = await amiExists(this.ec2[def.region], def.launchSpec.ImageId);
    if (!exists) {
      missing.push({imageId: def.launchSpec.ImageId, region: def.region});
    }
  }));
  if (missing.length > 0) {
    return res.status(400).json({
      message: 'ami does not exist',
      missing: missing,
    });
  }

  // We want to make sure that every single possible generated LaunchSpec
  // would be valid before we even try to store it
  try {
    await validateWorkerType(this, workerType, input);
  } catch (err) {
    res.status(400).json({
      message: 'Invalid workerType',
      error: {
        reasons: err.reasons,
      },
    });
    return;
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
  stability:  base.API.stability.stable,
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
}, async function (req, res) {
  let input = req.body;
  let workerType = req.params.workerType;

  let modDate = new Date();

  // We want to make sure that all AMIs that we are submitting are valid
  let missing = [];
  await Promise.all(input.regions.map(async (def) => {
    let exists = await amiExists(this.ec2[def.region], def.launchSpec.ImageId);
    if (!exists) {
      missing.push({imageId: def.launchSpec.ImageId, region: def.region});
    }
  }));
  if (missing.length > 0) {
    debug(missing);
    return res.status(400).json({
      message: 'ami does not exist',
      missing: missing,
    });
  }

  input.lastModified = modDate;

  if (!req.satisfies({workerType: workerType})) { return undefined; }

  try {
    await validateWorkerType(this, workerType, input);
  } catch (err) {
    res.status(400).json({
      message: 'Invalid workerType',
      error: {
        reasons: err.reasons,
      },
    });
    return;
  }

  let wType = await this.WorkerType.load({workerType: workerType});

  await wType.modify(function (w) {
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

  return res.reply(wType.json());
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
  stability:  base.API.stability.stable,
  description: [
    'Retreive a copy of the requested worker type definition.',
    'This copy contains a lastModified field as well as the worker',
    'type name.  As such, it will require manipulation to be able to',
    'use the results of this method to submit date to the update',
    'method.',
  ].join('\n'),
}, async function (req, res) {
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
  method: 'delete',
  route: '/worker-type/:workerType',
  name: 'removeWorkerType',
  deferAuth: true,
  scopes: [['aws-provisioner:manage-worker-type:<workerType>']],
  input: undefined,  // No input
  output: undefined,  // No output
  title: 'Delete Worker Type',
  stability:  base.API.stability.stable,
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
}, async function (req, res) {
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
      debug('unknown error deleting ' + workerType);
      debug(err);
      if (err.stack) {
        debug(err.stack);
      }
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
  stability:  base.API.stability.stable,
  description: [
    'Return a list of string worker type names.  These are the names',
    'of all managed worker types known to the provisioner.  This does',
    'not include worker types which are left overs from a deleted worker',
    'type definition but are still running in AWS.',
  ].join('\n'),
}, async function (req, res) {

  try {
    let list = await this.WorkerType.listWorkerTypes();
    return res.reply(list);
  } catch (err) {
    debug('error listing workertypes');
    debug(err);
    if (err.stack) {
      debug(err.stack);
    }
    throw err;
  }
});

api.declare({
  method: 'put',
  route: '/secret/:token',
  name: 'createSecret',
  scopes: [['aws-provisioner:create-secret']],
  input: 'create-secret-request.json#',
  title: 'Create new Secret',
  stability:  base.API.stability.stable,
  description: [
    'Insert a secret into the secret storage.  The supplied secrets will',
    'be provided verbatime via `getSecret`, while the supplied scopes will',
    'be converted into credentials by `getSecret`.',
    '',
    'This method is not ordinarily used in production; instead, the provisioner',
    'creates a new secret directly for each spot bid.',
  ].join('\n'),
}, async function (req, res) {
  let input = req.body;
  let token = req.params.token;

  let secret;
  try {
    secret = await this.Secret.create({
      token: token,
      workerType: input.workerType,
      secrets: input.secrets,
      region: input.region,
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
      'region',
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
  stability:  base.API.stability.stable,
  description: [
    'Retrieve a secret from storage.  The result contains any passwords or',
    'other restricted information verbatim as well as a temporary credential',
    'based on the scopes specified when the secret was created.',
    '',
    'It is important that this secret is deleted by the consumer (`removeSecret`),',
    'or else the secrets will be visible to any process which can access the',
    'user data associated with the instance.',
  ].join('\n'),
}, async function (req, res) {
  let token = req.params.token;

  try {
    let secret = await this.Secret.load({
      token: token,
    });

    let workerId = slugid.v4();
    let workerGroup = 'ec2_' + secret.region;

    return res.reply({
      data: secret.secrets,
      workerId: workerId,
      workerGroup: workerGroup,
      credentials: taskcluster.createTemporaryCredentials({
        scopes: [
          `assume:worker-type:${this.provisionerId}/${secret.workerType}`,
          `assume:worker-id:${workerGroup}:${workerId}`,
        ],
        expiry: taskcluster.fromNow('96 hours'),
        credentials: this.credentials,
      }),
    });
  } catch (err) {
    if (err.code === 'ResourceNotFound') {
      res.status(404).end();
    } else {
      debug('error getting secret ' + token);
      debug(err);
      if (err.stack) {
        debug(err.stack);
      }
      throw err;
    }
  }
});

api.declare({
  method: 'get',
  route: '/instance-started/:instanceId/:token',
  name: 'instanceStarted',
  title: 'Report an instance starting',
  stability:  base.API.stability.stable,
  description: [
    'An instance will report in by giving its instance id as well',
    'as its security token.  The token is given and checked to ensure',
    'that it matches a real token that exists to ensure that random',
    'machines do not check in.  We could generate a different token',
    'but that seems like overkill',
  ].join('\n'),
}, async function (req, res) {
  let instanceId = req.params.instanceId;
  let token = req.params.token;

  try {
    await this.Secret.load({
      token: token,
    });

    this.reportInstanceStarted({
      id: instanceId,
    });

    return res.status(204).end();
  } catch (err) {
    debug('error reporting instance %s start with token %s', instanceId, token);
    debug(err);
    if (err.stack) {
      debug(err.stack);
    }
    throw err;
  }
});

api.declare({
  method: 'delete',
  route: '/secret/:token',
  name: 'removeSecret',
  title: 'Remove a Secret',
  stability:  base.API.stability.stable,
  description: [
    'Remove a secret.  After this call, a call to `getSecret` with the given',
    'token will return no information.',
    '',
    'It is very important that the consumer of a ',
    'secret delete the secret from storage before handing over control',
    'to untrusted processes to prevent credential and/or secret leakage.',
  ].join('\n'),
}, async function (req, res) {
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
      debug('error removing a secret');
      debug(err);
      if (err.stack) {
        debug(err.stack);
      }
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
  stability:  base.API.stability.experimental,
  description: [
    'This method returns a preview of all possible launch specifications',
    'that this worker type definition could submit to EC2.  It is used to',
    'test worker types, nothing more',
    '',
    '**This API end-point is experimental and may be subject to change without warning.**',
  ].join('\n'),
}, async function (req, res) {
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
  scopes: [['aws-provisioner:view-worker-type:<workerType>']],
  stability:  base.API.stability.stable,
  description: [
    'Return the state of a given workertype as stored by the provisioner. ',
    'This state is stored as three lists: 1 for all instances, 1 for requests',
    'which show in the ec2 api and 1 list for those only tracked internally',
    'in the provisioner.  The `summary` property contains an updated summary',
    'similar to that returned from `listWorkerTypeSummaries`.',
  ].join('\n'),
}, async function (req, res) {
  let workerType, workerState;

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

  try {
    workerState = await this.WorkerState.load({workerType: req.params.workerType});
  } catch (err) {
    if (err.code !== 'ResourceNotFound') {
      throw err;
    }
  }

  res.reply({
    workerType: workerType.workerType,
    instances: workerState ? workerState.instances : [],
    requests: workerState ? workerState.requests : [],
    internalTrackedRequests: workerState ? workerState.internalTrackedRequests : [],
    summary: workerTypeSummary(workerType, workerState),
  });
});

api.declare({
  method: 'get',
  route: '/ping',
  name: 'ping',
  title: 'Ping Server',
  stability:  base.API.stability.experimental,
  description: [
    'Documented later...',
    '',
    '**Warning** this api end-point is **not stable**.',
  ].join('\n'),
}, function (req, res) {
  res.status(200).json({
    alive: true,
    uptime: process.uptime(),
  });
});

api.declare({
  method: 'get',
  route: '/backend-status',
  name: 'backendStatus',
  title: 'Backend Status',
  stability:  base.API.stability.experimental,
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
}, async function (req, res) {
  let endpoint = 'https://api.deadmanssnitch.com/v1/snitches/';
  endpoint += url.parse(this.iterationSnitch).pathname.split('/').slice(-1);

  debug('Getting status of snitch from: ' + endpoint);

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
