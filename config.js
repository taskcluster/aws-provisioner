var fs      = require('fs');
var nconf   = require('nconf');
var aws     = require('aws-sdk');

/** Default configuration values */
var DEFAULT_CONFIG_VALUES = {
  // Server (HTTP) configuration
  server: {
    // Server hostname
    hostname:                       'localhost',

    // Port to run the HTTP server on
    port:                           3001,

    // Cookie secret used to sign cookies, must be secret at deployment
    cookieSecret:                   "Warn, if no secret is used on production"
  },

  pulse: {
    username:                            null,
    password:                            null,
  },

  taskcluster: {
    clientId:                           null,
    accessToken:                        null
  },

  // Provisioner settings
  provisioner: {
    // Provisioner identifier
    provisionerId:                  'test-aws-provisioner',

    // Interval with which to run the provisioning algorithm (in seconds)
    interval:                       45,

    // Key name prefix for instances launched, all instances with a key-name
    // prefixed with the `keyNamePrefix` will be managed by this provisioner
    keyNamePrefix:                  'test-provisioner-managed:',

    // Base64 encoded public key
    publicKeyData:                  '',

    // Azure table with workerType definitions
    azureWorkerTypeTable:           'TestAWSWorkerTypes'
  },

  // Azure table credentials
  azureTableCredentials: {
    accountUrl:                     null,
    accountName:                    null,
    accountKey:                     null
  },

  // Queue configuration
  queue: {
    baseUrl:                        'https://queue.taskcluster.net'
  },

  // AWS SDK Configuration
  aws: {
    // Default AWS region, this is where S3 buckets etc. will be placed.
    // In the first iteration this is also where spot instances will be launched
    region:                         'us-west-2',

    // Lock API version to use the latest API from 2013, this is fuzzy locking,
    // but it does the trick...
    apiVersion:                     '2014-01-01'
  }
};

/** Load configuration */
exports.load = function() {

  // Configurations elements loaded from commandline, these are the only
  // values we should ever really need to change.
  nconf.env({
    separator:  '__',
    whitelist:  [
      'provisioner__provisionerId',
      'provisioner__keyNamePrefix',
      'provisioner__publicKeyData',
      'provisioner__azureWorkerTypeTable',
      'azureTableCredentials__accountUrl',
      'azureTableCredentials__accountName',
      'azureTableCredentials__accountKey',
      'queue__baseUrl',
      'server__hostname',
      'server__port',
      'server__cookieSecret',
      'aws__accessKeyId',
      'aws__secretAccessKey',
      'pulse__username',
      'pulse__password',
      'taskcluster__clientId',
      'taskcluster__accessToken'
    ]
  });

  // Load configuration from command line arguments, if requested
  nconf.argv();

  // Config from current working folder if present
  nconf.file('local', 'taskcluster-aws-provisioner.conf.json');

  // User configuration
  nconf.file('user', '~/.taskcluster-aws-provisioner.conf.json');

  // Global configuration
  nconf.file('global', '/etc/taskcluster-aws-provisioner.conf.json');

  // Load default configuration
  nconf.defaults(DEFAULT_CONFIG_VALUES);

  // Set configuration for aws-sdk
  aws.config.update(nconf.get('aws'));
}
