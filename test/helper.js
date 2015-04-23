'use strict';
var Promise     = require('promise');
var path        = require('path');
var _           = require('lodash');
var base        = require('taskcluster-base');
var mocha       = require('mocha');
var v1          = require('../routes/v1');
var exchanges   = require('../provisioner/exchanges');
var taskcluster = require('taskcluster-client');
var bin = {
  server:             require('../bin/server'),
};

// Some default clients for the mockAuthServer
var defaultClients = [
  {
    clientId:     'test-server',  // Hardcoded into config/test.js
    accessToken:  'none',
    scopes:       ['auth:credentials', 'auth:can-delegate'],
    expires:      new Date(3000, 0, 0, 0, 0, 0, 0)
  }, {
    clientId:     'test-client',  // Used in default AwsProvisioner creation
    accessToken:  'none',
    scopes:       ['*'],
    expires:      new Date(3000, 0, 0, 0, 0, 0, 0)
  }
];

// Load configuration
var cfg = base.config({
  defaults:   require('../config/defaults'),
  profile:    require('../config/test'),
  filename:   'taskcluster-aws-provisioner'
});
exports.cfg = cfg;

// Skip tests if no AWS credentials is configured
if (!cfg.get('aws:secretAccessKey') ||
    !cfg.get('azure:accountKey') ||
    !cfg.get('pulse:password')) {
  console.log("Skip tests due to missing credentials!");
  process.exit(1);
}

// Configure PulseTestReceiver
exports.events = new base.testing.PulseTestReceiver(cfg.get('pulse'), mocha);


// Hold reference to authServer
var authServer = null;
var webServer = null;

// Setup before tests
mocha.before(async () => {
  // Create mock authentication server
  authServer = await base.testing.createMockAuthServer({
    port:     60407, // This is hardcoded into config/test.js
    clients:  defaultClients
  });

  webServer = await bin.server('test');

  // Create client for working with API
  exports.baseUrl = 'http://localhost:' + webServer.address().port + '/v1';
  var reference = v1.reference({baseUrl: exports.baseUrl});
  exports.AwsProvisioner = taskcluster.createClient(reference);
  // Utility to create an Queue instance with limited scopes
  exports.scopes = (...scopes) => {
    exports.awsProvisioner = new exports.AwsProvisioner({
      // Ensure that we use global agent, to avoid problems with keepAlive
      // preventing tests from exiting
      agent:            require('http').globalAgent,
      baseUrl:          exports.baseUrl,
      credentials: {
        clientId:       'test-client',
        accessToken:    'none'
      },
      authorizedScopes: (scopes.length > 0 ? scopes : undefined)
    });
  };

  // Initialize provisioner client
  exports.scopes();

  /*
  // Create client for binding to reference
  var exchangeReference = exchanges.reference({
    exchangePrefix:   cfg.get('provisioner:exchangePrefix'),
    credentials:      cfg.get('pulse')
  });
  helper.AwsProvisionerEvents = taskcluster.createClient(exchangeReference);
  helper.awsProvisionerEvents = new helper.AwsProvisionerEvents();
  */
});

// Setup before each test
mocha.beforeEach(() => {
  // Setup client with all scopes
  exports.scopes();
});

// Cleanup after tests
mocha.after(async () => {
  // Kill webServer
  await webServer.terminate();
  await authServer.terminate();
});

