var Promise     = require('promise');
var _           = require('lodash');
var debug       = require('debug')('routes:v1');
var assert      = require('assert');
var base        = require('taskcluster-base');

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
  title:          "AWS Provisioner API Documentation",
  description: [
    "The AWS Provisioner is responsible for provisioning instances on EC2 for use in",
    "TaskCluster.  The provisioner maintains a set of worker configurations which",
    "can be managed with an API that is typically available at",
    "aws-provisioner.taskcluster.net.  This API can also perform basic instance",
    "management tasks in addition to maintaining the internal state of worker type",
    "configuration information.",
    "",
    "The Provisioner runs at a configurable interval.  Each iteration of the",
    "provisioner fetches a current copy the state that the AWS EC2 api reports.  In",
    "each iteration, we ask the Queue how many tasks are pending for that worker",
    "type.  Based on the number of tasks pending and the scaling ratio, we may",
    "submit requests for new instances.  We use pricing information, capacity and",
    "utility factor information to decide which instance type in which region would",
    "be the optimal configuration.",
    "",
    "Each EC2 instance type will declare a capacity and utility factor.  Capacity is",
    "the number of tasks that a given machine is capable of running concurrently.",
    "Utility factor is a relative measure of performance between two instance types.",
    "We multiply the utility factor by the spot price to compare instance types and",
    "regions when making the bidding choices.",
    "",
  ].join('\n')
});


function errorHandler(err, res, workerType) {
  console.error(err, err.stack);
  switch(err.code) {
    case 'ResourceNotFound':
      return res.status(404).json({
        message: workerType + ': ' + err.body.message.value,
        error: {
          workerType: workerType,
          reason: err.code,
        }
      });
      break; // I guess I don't need this because of the return...
    case 'EntityAlreadyExists':
      return res.status(409).json({
        message: workerType + ': ' + err.body.message.value,
        error: {
          workerType: workerType,
          reason: err.code,
        }
      });
      break;
    case 'InvalidLaunchSpecifications':
      if (err.reasons) {
        err.reasons.forEach(function (e) {
          console.error(e, e.stack);
        });
      }
      if (err.code === 'InvalidLaunchSpecifications') {
        return res.status(500).json({
          message: err.toString(),
          code: err.code,
          reason: err.reasons.map(function (x) { return x.toString() }),
        });
      }      
    default:
      throw err;
  }
}

module.exports = api;

api.declare({
  method:         'put',
  route:          '/worker-type/:workerType',
  name:           'createWorkerType',
  deferAuth:      true,
  scopes:         ['aws-provisioner:create-worker-type:<workerType>'],
  input:          SCHEMA_PREFIX_CONST + 'create-worker-type-request.json#',
  output:         SCHEMA_PREFIX_CONST + 'get-worker-type-response.json#',
  title:          "Create new Worker Type",
  description: [
    "Create a worker type and ensure that all EC2 regions have the required ",
    "KeyPair"
  ].join('\n')
}, 
function(req, res) {
  var ctx         = this;
  var input       = req.body;
  var workerType  = req.params.workerType;

  if(!req.satisfies({
    workerType:       workerType
  })) {
    return; // by default req.satisfies() sends a response on failure, so we're done
  }

  // TODO: If workerType launchSpecification specifies scopes that should be given
  //       to the workers using temporary credentials, then you should validate
  //       that the caller has this scopes to avoid scope elevation.
  // TODO: ^ do this.  not entirely sure what this means, are LaunchSpecification
  //       security groups the same as scopes?

  try {
    ctx.WorkerType.testLaunchSpecs(debug, input, 'TestKeyPrefix');
  } catch (err) {
    errorHandler(err, res, workerType);
  }

  var worker;

  var p = ctx.WorkerType.create(workerType, input)
  
  p = p.then(function(worker_) {
    worker = worker_;
  });

  p = p.then(function() {
    return worker.createKeyPair();
  });

  p = p.then(function(result) {
    debug('Finished creating AWS KeyPair');
  });

  p = p.then(function() {
    return ctx.publisher.workerTypeCreated({
      workerType: workerType,
    })
  });

  p = p.then(function() {
    return res.reply(worker.json());
  });

  p = p.catch(function(err) {
    errorHandler(err, res, workerType);
    return err;
  });

  return p;
});

api.declare({
  method:         'post',
  route:          '/worker-type/:workerType/update',
  name:           'updateWorkerType',
  deferAuth:      true,
  scopes:         ['aws-provisioner:update-worker-type:<workerType>'],
  input:          SCHEMA_PREFIX_CONST + 'create-worker-type-request.json#',
  output:         SCHEMA_PREFIX_CONST + 'get-worker-type-response.json#',
  title:          "Update Worker Type",
  description: [
    "Update a workerType and ensure that all regions have the require",
    "KeyPair",
  ].join('\n')
}, function(req, res) {
  var ctx         = this;
  var input       = req.body;
  var workerType  = req.params.workerType;

  if(!req.satisfies({
    workerType:       workerType
  })) {
    return; // by default req.satisfies() sends a response on failure, so we're done
  }

  var worker;

  try {
    ctx.WorkerType.testLaunchSpecs(debug, input, 'TestKeyPrefix');
  } catch (err) {
    errorHandler(err, res, workerType);
  }
  
  var p = ctx.WorkerType.load(workerType)
    
  p = p.then(function(worker_) {
    worker = worker_;
    return worker.modify(function(worker) {
      // We know that data that gets to here is valid per-schema
      Object.keys(input).forEach(function(key) {
        worker[key] = input[key];
      });
    });
  });

  p = p.then(function() {
    return worker.createKeyPair();
  });

  p = p.then(function(result) {
    debug('Finished creating AWS KeyPair');
  });

  p = p.then(function() {
    return ctx.publisher.workerTypeCreated({
      workerType: workerType,
    })
  });

  p = p.then(function() {
    return res.reply(worker.json());
  })

  p = p.catch(function(err) {
    errorHandler(err, res, workerType);
    return err;
  });

  return p;

});


api.declare({
  method:         'get',
  route:          '/get-launch-specs/:workerType',
  name:           'getLaunchSpecs',
  deferAuth:      true,
  scopes:         ['aws-provisioner:get-worker-type:<workerType>'],
  input:          undefined,  // No input
  output:         SCHEMA_PREFIX_CONST + 'get-launch-specs-response.json#',
  title:          "Get All Launch Specifications for WorkerType",
  description: [
    "Return the EC2 LaunchSpecifications for all combinations of regions", 
    "and instance types or a list of reasons why the launch specifications",
    "are not valid",
  ].join('\n')
}, function(req, res) {
  var ctx         = this;
  var workerType  = req.params.workerType;

  if(!req.satisfies({
    workerType:       workerType
  })) {
    return; // by default req.satisfies() sends a response on failure, so we're done
  }

  var p = ctx.WorkerType.load(workerType);
  
  p = p.then(function(worker) {
    return res.reply(worker.testLaunchSpecs(debug));
  });

  p = p.catch(function(err) {
    errorHandler(err, res, workerType);
  });

  return p;

});


api.declare({
  method:         'get',
  route:          '/worker-type/:workerType',
  name:           'workerType',
  deferAuth:      true,
  scopes:         ['aws-provisioner:get-worker-type:<workerType>'],
  input:          undefined,  // No input
  output:         SCHEMA_PREFIX_CONST + 'get-worker-type-response.json#',
  title:          "Get Worker Type",
  description: [
    "Retreive a WorkerType definition"
  ].join('\n')
}, function(req, res) {
  var ctx         = this;
  var workerType  = req.params.workerType;

  if(!req.satisfies({
    workerType:       workerType
  })) {
    return; // by default req.satisfies() sends a response on failure, so we're done
  }

  var p = ctx.WorkerType.load(workerType);
  
  p = p.then(function(worker) {
    return res.reply(worker.json());
  });

  p = p.catch(function(err) {
    errorHandler(err, res, workerType);
    return err;
  });

  return p;

});


// Delete workerType
// TODO: send a pulse message that a worker type was removed
api.declare({
  method:         'delete',
  route:          '/worker-type/:workerType',
  name:           'removeWorkerType',
  deferAuth:      true,
  // TODO: Should we have a special scope for workertype removal?
  scopes:         ['aws-provisioner:get-worker-type:<workerType>'],
  input:          undefined,  // No input
  output:         undefined,  // No output
  title:          "Delete Worker Type",
  description: [
    "Delete a WorkerType definition, submits requests to kill all ",
    "instances and delete the KeyPair from all configured EC2 regions",
  ].join('\n')
}, function(req, res) {
  var ctx         = this;
  var workerType  = req.params.workerType;

  if(!req.satisfies({
    workerType:       workerType
  })) {
    return; // by default req.satisfies() sends a response on failure, so we're done
  }

  var worker;
  var p = ctx.WorkerType.load(workerType)

  p = p.then(function(worker_) {
    worker = worker_;
    return worker.killAll(debug);
  });

  p = p.then(function() {
    return worker.remove();
  });

  p = p.then(function(result) {
    debug('Finished deleting worker type');
  });

  p = p.then(function(worker) {
    return res.reply({});
  });

  p = p.catch(function(err) {
    errorHandler(err, res, workerType);
    return err;
  });

  return p;
});


// List workerTypes
api.declare({
  method:         'get',
  route:          '/list-worker-types',
  name:           'listWorkerTypes',
  deferAuth:      true, // I don't think we need this unless we do parameterized scopes
  scopes:         [
      'aws-provisioner:list-worker-types',
  ],
  input:          undefined,  // No input
  output:         SCHEMA_PREFIX_CONST + 'list-worker-types-response.json#',
  title:          "List Worker Types",
  description: [
    "List all known WorkerType names",
  ].join('\n')
}, function(req, res) {
  var ctx         = this;
  var workerType  = req.params.workerType;

  if(!req.satisfies({
    workerType:       workerType
  })) {
    return; // by default req.satisfies() sends a response on failure, so we're done
  }

  var p = this.WorkerType.loadAllNames()

  p = p.then(function(workerNames) {
    return res.reply(workerNames);
  });

  p = p.catch(function(err) {
    errorHandler(err, res, 'listing all worker types');
    return err;
  });

  return p;

});


/** 
 * Shut down all instances of a workerType.
 */
api.declare({
  method:   'get',
  route:    '/shutdown/every/ec2/instances/for/:workerType',
  name:     'shutdownEveryEc2InstanceFor',
  title:    "Shutdown Every Ec2 Instance of this Worker Type",
  scopes:   [
    ['aws-provisioner:aws',
    'aws-provisioner:get-worker-type:<workerType>',],
  ],
  description: [
    "WARNING: YOU ALMOST CERTAINLY DO NOT WANT TO USE THIS ",
    "Shut down every single EC2 instance associated with this workerType. ",
    "This means every single last one.  You probably don't want to use ",
    "this method, which is why it has an obnoxious name.  Don't even try ",
    "to claim you didn't know what this method does!"
  ].join('\n')
}, function(req, res) {

  // I don't think we need this here....
  if(!req.satisfies({
    workerType:       workerType
  })) {
    return; // by default req.satisfies() sends a response on failure, so we're done
  }

  var ctx = this;
  var workerType = req.params.workerType;

  debug('SOMEONE IS TURNING OFF ALL ' + workerType);

  var p = ctx.WorkerType.load(workerType);

  p = p.then(function(worker) {
    return worker.killAll();
  });

  p = p.then(function() {
    res.reply({
      outcome: true,
      message: 'Dude, you just turned absolutely everything off.',
    });
  });

  p = p.catch(function(err) {
    res.status(503).json({
      message: 'Could not shut down all ' + workerType,
    });
  });

  return p;

});

/** 
 * Shut down all managed instances.
 */
api.declare({
  method:   'get', // Hmm, maybe this should be post
  route:    '/shutdown/every/single/ec2/instance/managed/by/this/provisioner',
  name:     'shutdownEverySingleEc2InstanceManagedByThisProvisioner',
  title:    "Shutdown Every Single Ec2 Instance Managed By This Provisioner",
  scopes:   [['aws-provisioner:all-stop', 'aws-provisioner:aws']],
  description: [
    "WARNING: YOU ALMOST CERTAINLY DO NOT WANT TO USE THIS ",
    "Shut down every single EC2 instance managed by this provisioner. ",
    "This means every single last one.  You probably don't want to use ",
    "this method, which is why it has an obnoxious name.  Don't even try ",
    "to claim you didn't know what this method does!"
  ].join('\n')
}, function(req, res) {

  // I don't think we need this here....
  if(!req.satisfies({
    workerType:       workerType
  })) {
    return; // by default req.satisfies() sends a response on failure, so we're done
  }

  var ctx = this;

  debug('SOMEONE IS TURNING EVERYTHING OFF');
  var p = ctx.WorkerType.killEverything(debug);

  p = p.then(function() {
    res.reply({
      outcome: true,
      message: 'Dude, you just turned absolutely everything off.',
    });
  });

  p = p.catch(function(err) {
    res.status(503).json({
      message: 'Could not shut down everything',
    });
  });

  return p;

});


api.declare({
  method:         'post',
  route:          '/worker-type/:workerType/spawn',
  name:           'spawnWorkerType',
  deferAuth:      true,
  scopes:         [[
    'aws-provisioner:aws',
    'aws-provisioner:spawn-worker-type:<workerType>'
  ]],
  input:          SCHEMA_PREFIX_CONST + 'spawn-instance-request.json#',
  output:         SCHEMA_PREFIX_CONST + 'spawn-instance-response.json#',
  title:          "Spawn an instance of a Worker Type",
  description: [
    'Spawn an instance of a workerType given a bid.  A bid is an ',
    'object which has a number `price`, string `region` and string ',
    '`instance type`.'
  ].join('\n')
}, function(req, res) {
  var ctx         = this;
  var input       = req.body;
  var workerType  = req.params.workerType;
  
  if(!req.satisfies({
    workerType:       workerType
  })) {
    return; // by default req.satisfies() sends a response on failure, so we're done
  }

  var p = ctx.WorkerType.load(workerType)
    
  p = p.then(function(worker) {
    return worker.spawn(debug, input);
  });

  p = p.then(function(sir) {
    var reply = {
      SpotInstanceRequestId: sir,
    };
    return res.reply(reply);
  })

  p = p.catch(function(err) {
    errorHandler(err, res, workerType);
    return err;
  });

  return p;

});



api.declare({
  method:         'get',
  route:          '/aws-state',
  name:           'awsState',
  scopes:         [
      'aws-provisioner:show-state',
  ],
  input:          undefined,  // No input
  output:         SCHEMA_PREFIX_CONST + 'get-aws-state-response.json#',
  title:          "List Worker Types",
  description: [
    "List all known WorkerType names",
  ].join('\n')
}, function(req, res) {
  var ctx         = this;
  var workerType  = req.params.workerType;

  var p = ctx.awsStateCache.get();

  p = p.then(function(state) {
    res.reply(state.get());
  });

  p = p.catch(function(err) {
    errorHandler(err, res, 'showing aws state');
    return err;
  });


  return p;

});

api.declare({
  method:   'get',
  route:    '/ping',
  name:     'ping',
  title:    "Ping Server",
  description: [
    "Documented later...",
    "",
    "**Warning** this api end-point is **not stable**."
  ].join('\n')
}, function(req, res) {
  res.status(200).json({
    alive:    true,
    uptime:   process.uptime()
  });
});

api.declare({
  method:   'get',
  route:    '/api-reference',
  name:     'apiReference',
  title:    "api reference",
  description: [
    "Get an API reference!",
    "",
    "**Warning** this api end-point is **not stable**."
  ].join('\n')
}, function(req, res) {
  var host = req.get('host');
  var proto = req.connection.encrypted ? 'https' : 'http';
  res.status(200).json(api.reference({
    baseUrl: proto + '://' + host + '/v1'
  }));
});



