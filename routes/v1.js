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
 *   workerType:        // Instance of data.workerTypes
 * }
 */
var api = new base.API({
  title:          "AWS Provisioner API Documentation",
  description: [
    "The AWS  provisioner, typically available at",
    "`aws-provisioner.taskcluster.net`, is responsible for provisioning EC2",
    "instances as tasks become become pending. To do this it monitors the",
    "state of queues, EC2 instances, spot prices and other interesting",
    "parameters."
    // TODO: Write who the intended users are:
    //        - tools for defining workerTypes
    //        - tools for inspecting state of AWS
    //        - hooks monitoring state
    // TODO: Write what the AWS provisioner does, how the API works
    //       just some introduction...
    //       To quote a the Daleks: Explain..., Explain,.. Exterminate!
    //                                                    (^disregard the that)
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
  output:         SCHEMA_PREFIX_CONST + 'create-worker-type-response.json#',
  title:          "Create new Worker Type",
  description: [
    // Document what this method does
  ].join('\n')
}, function(req, res) {
  var ctx         = this;
  var input       = req.body;
  var workerType  = req.params.workerType;

  // Authenticate request by providing parameters, this is necessary because
  // we set `deferAuth: true`, we can't do automatic authentication if the
  // scopes contain parameters like <workerType>
  if(!req.satisfies({
    workerType:       workerType
  })) {
    return; // by default req.satisfies() sends a response, so we're done
  }

  // TODO: If workerType definition specifies scopes that should be given
  //       to the workers using temporary credentials, then you should validate
  //       that the caller has this scopes to avoid scope elevation.

  // Create workerType
  return ctx.workerTypes.create({
    // Define properties, see data.js
  }).then((function() {
    // TODO: Post AMQP message that workerType was created
    return ctx.publisher.workerTypeCreated({
      // Define properties, see exchanges.js
    }).then(function() {
      // Send a reply (always use res.reply), only use
      return res.reply({
        // Fulfill schema: 'create-worker-type-response.json#'
      });
  }, function(err) {
    // Handle errors from `ctx.workerTypes.create`, not message publishing
    // or res.reply.

    // Check that the code matches something you expected
    if (err && err.code === 'EntityAlreadyExists') {
      // Log this with debug() this makes it easier to see that we handled the
      // error above which will typically be logged anyways.
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
});



// Update workerType
api.declare({
  method:         'post',
  route:          '/worker-type/:workerType/update',
  name:           'updateWorkerType',
  deferAuth:      true,
  scopes:         ['aws-provisioner:update-worker-type:<workerType>'],
  input:          SCHEMA_PREFIX_CONST + 'create-worker-type-request.json#',
  output:         SCHEMA_PREFIX_CONST + 'create-worker-type-response.json#',
  title:          "Update Worker Type",
  description: [
    // Document what this method does
  ].join('\n')
}, function(req, res) {
  var ctx         = this;
  var input       = req.body;
  var workerType  = req.params.workerType;

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
    // Document what this method does
  ].join('\n')
}, function(req, res) {
  var ctx         = this;
  var workerType  = req.params.workerType;

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
      'aws-provisioner:get-worker-type:<workerType>',
      'aws-provisioner:list-worker-types',
    ]
  ],
  input:          undefined,  // No input
  output:         SCHEMA_PREFIX_CONST + 'list-worker-types-response.json#',
  title:          "List Worker Types",
  description: [
    // Document what this method does
  ].join('\n')
}, function(req, res) {
  var ctx         = this;

});


