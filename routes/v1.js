var Promise     = require('promise');
var _           = require('lodash');
var debug       = require('debug')('routes:v1');
var assert      = require('assert');
var base        = require('taskcluster-base');

// Common schema prefix
var SCHEMA_PREFIX_CONST = 'http://schemas.taskcluster.net/aws-provisioner/v1/';


/** TODO: Questions for Jonas for review:
  
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
    "The AWS  provisioner, typically available at",
    "`aws-provisioner.taskcluster.net`, is responsible for provisioning EC2",
    "instances as tasks become become pending. To do this it monitors the",
    "state of queues, EC2 instances, spot prices and other interesting",
    "parameters.  This API can be used to define, update and remove worker",
    "types.  The state of AWS nodes as well as demand will be available.",
    // TODO: Write what the AWS provisioner does, how the API works
    //       just some introduction...
    //       To quote a the Daleks: Explain..., Explain,.. Exterminate!
    //                                                    (^disregard the that)
    // TODO: ^ do this
  ].join('\n')
});


function errorHandler(err, res, workerType) {
  debug('%s error %s %s', workerType, err, err.stack || JSON.stringify(err));
  switch(err.code) {
    case 'ResourceNotFound':
      return res.status(404).json({
        message: workerType + ': ' +err.body.message.value,
        error: {
          workerType: workerType,
          reason: err.code,
        }
      });
      break; // I guess I don't need this because of the return...
    case 'EntityAlreadyExists':
      return res.status(409).json({
        message: workerType + ': ' +err.body.message.value,
        error: {
          workerType: workerType,
          reason: err.code,
        }
      });
      break;
    default:
      throw err;
  }
}

// Export api
module.exports = api;

// Create workerType
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
    "This API method creates a worker type for AWS based workers.",
    "A worker type has the information required to create an EC2",
    "instance of the required type for pending jobs"
  ].join('\n')
}, 
function(req, res) {
  var ctx         = this;
  var input       = req.body;
  var workerType  = req.params.workerType;

  // Authenticate request by providing parameters, this is necessary because we
  // set `deferAuth: true`, we can't do automatic authentication if the scopes
  // contain parameters like <workerType>

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

  // Create workerType

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

// Update workerType
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
    'Placeholder',
    // Document what this method does
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

// Get workerType
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
    'placeholder',
    // Document what this method does
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
    'placeholder',
    // Document what this method does
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
      // Require both scopes... We need to parameterize these for each
      // <workerType> before we return the result
      // Wait, why do we need the get-worker-type:<workerType> scope?
      // The problem that I see here is that you'd need to a) provide a param
      // which told the server which type of worker type we're looking for.
      // b) need figure out what to do if someone has get-worker-type for a
      // non-complete list of worker types.
      // If someone has the workertype they're looking for, why even do a list?
      // I assume this is to protect possible secrets in the WorkerType entity,
      // so instead I'll just return a list of workerType names
      //'aws-provisioner:get-worker-type:<workerType>',
      'aws-provisioner:list-worker-types',
  ],
  input:          undefined,  // No input
  output:         SCHEMA_PREFIX_CONST + 'list-worker-types-response.json#',
  title:          "List Worker Types",
  description: [
    'placeholder'
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
 * Shut down all managed instances.
 */
api.declare({
  method:   'get', // Hmm, maybe this should be post
  route:    '/shutdown/every/single/ec2/instance/managed/by/this/provisioner',
  name:     'shutdownEverySingleEc2InstanceManagedByThisProvisioner',
  title:    "Shutdown Every Single Ec2 Instance Managed By This Provisioner",
  scopes:   ['aws-provisioner:all-stop'],
  description: [
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


/** Check that the server is a alive */
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

/** Check that the server is a alive */
api.declare({
  method:   'get',
  route:    '/api',
  name:     'api',
  title:    "api reference",
  description: [
    "Documented later...",
    "",
    "**Warning** this api end-point is **not stable**."
  ].join('\n')
}, function(req, res) {
  res.status(200).json(api.reference({
    baseUrl: 'http://localhost:5556/v1'
  }));
});



