var Promise     = require('promise');
var _           = require('lodash');
var debug       = require('debug')('routes:v1');
var assert      = require('assert');
var base        = require('taskcluster-base');

// Common schema prefix
var SCHEMA_PREFIX_CONST = 'http://schemas.taskcluster.net/aws-provisioner/v1/';


/** TODO: Questions for Jonas for review:
  
  1) Should we have seperate create, retreive, modify and delete scopes?
  1a) What about modify-<workerType>, view-<workerType> instead of per-action?
  2) If the answer to 1) is no, should we just call the scope aws-provisioner:worker-type
  3) See notes in the list worker type methods, should we have a special list scope
     or should we instead load the list of worker types and then verify the user
     satisfies the scope for each of those worker types?
*/

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

  var p = ctx.WorkerType.create(workerType, input)
  
  p = p.then(function() {
    // TODO: Should we be handling publish failures?
    return ctx.publisher.workerTypeCreated({
      workerType: workerType,
    })
  });

  p = p.then(function() {
    // Send a reply (always use res.reply), only use
    return ctx.WorkerType.loadForReply(workerType).then(function(worker) {
      return res.reply(worker);
    }, function(err) {
      if (err.code === 'ResourceNotFound') {
        return res.status(404).json({
          message: "Worker Type Not Found"
        });
      }
      throw err;
    });
  });

  p = p.catch(function(err) {
    // Check that the code matches something you expected
    if (err && err.code === 'EntityAlreadyExists') {
      debug("createWorkerType failed, as '%s' already exists", workerType);
      // This is how we return error messages, there is no formal way to this
      // yet... We probably should add something res.reportError(code, {...}),
      // But generally speaking we always want a "message" property, and all
      // the other stuff we're willing to return we stuff into "error".
      // Note, we do not return custom 500 errors.
      return res.status(409).json({
        message:          "Conflict: workerType already exists!",
        error: {
          workerType:     workerType,
          reason:         'already-exists'
        }
      });
    }

    // If not handled above, rethrow, which will cause a 500 internal error
    // Note, for 500 errors we return a generic message and a uuid that can
    // be looked up in server logs. This way we don't expose sensitive
    // information... Throwing an error in a promise returned in the handler
    // will cause a 500, so rethrow here is perfect.
    // Notice that I did do, return res.status(409)... above, so if handled
    // the program won't go here.
    throw err;
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

  return ctx.WorkerType.load(workerType).then(function(worker) {
    return worker.modify(function() {
      this.launchSpecification = input.launchSpecification;
      this.scalingRatio = input.scalingRatio;
      this.maxInstances = input.maxInstances;
      this.minSpotBid = input.minSpotBid;
      this.maxSpotBid = input.maxSpotBid;
      this.minInstances = input.minInstances;
      this.canUseOndemand = input.canUseOndemand;
      this.canUseSpot = input.canUseSpot;
      this.allowedInstanceTypes = input.allowedInstanceTypes;
      this.allowedRegions = input.allowedRegions;
    }).then(
      function() {
        // TODO: Should we be handling publish failures?
        // For updates, we still send a create message since all we're sending
        // is the worker type id
        return ctx.publisher.workerTypeCreated({
          workerType: workerType,
        })
      }).then(
      function() {
        // Send a reply (always use res.reply), only use
        return ctx.WorkerType.load(workerType).then(function(worker) {
          return res.reply(worker);
        }, function(err) {
          if (err.code === 'ResourceNotFound') {
            return res.status(404).json({
              message: "Worker Type Not Found"
            });
          }
          throw err;
        });
      })
  },
  function (err) {
    if (err.code === 'ResourceNotFound') {
      return res.status(404).json({
        message: "Worker Type not found"
      });
    }
  });

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

  return ctx.WorkerType.load(workerType).then(function(worker) {
    return res.reply(worker);
  }, function(err) {
    if (err.code === 'ResourceNotFound') {
      return res.status(404).json({
        message: "Worker Type Not Found"
      });
    }
    throw err;
  });

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

  return ctx.WorkerType.remove(workerType).then(function(worker) {
    return res.reply({});
  }, function(err) {
    if (err.code === 'ResourceNotFound') {
      return res.status(404).json({
        message: "Worker Type Not Found"
      });
    }
    throw err;
  });

});


// List workerTypes
api.declare({
  method:         'get',
  route:          '/list-worker-types',
  name:           'listWorkerTypes',
  deferAuth:      true,
  scopes:         [
    [
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
    ]
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

  return this.WorkerType.loadAll().then(function(clients) {
    return res.reply(clients.map(function(client) {
      return client.workerType;
    }));
  });


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



