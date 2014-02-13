var fs      = require('fs');
var nconf   = require('nconf');
var aws     = require('aws-sdk');

/** Default configuration values */
var DEFAULT_CONFIG_VALUES = {
  // Run the provisioner without modifying AWS resources
  'dry-run':                        false,

  // Log provisioning actions to stdout
  'log-actions':                    true,

  // Server (HTTP) configuration
  'server': {
    // Server hostname
    'hostname':                     'localhost',

    // Port to run the HTTP server on
    'port':                         3001,

    // Port through which the public access this server
    'public-port':                  3001,

    // Cookie secret used to sign cookies, must be secret at deployment
    'cookie-secret':                "Warn, if no secret is used on production"
  },

  // Settings related to provisioning
  'provisioning': {
    // Provisioner identifier
    'provisioner-id':               'test-aws-provisioner',

    // Interval with which to run the provisioning algorithm (in seconds)
    'interval':                     2 * 60,

    // Number of provision retries before exiting non-zero, in deployment this
    // should email some administrator...
    'max-retries':                  5,

    // Instance type to launch
    'instance-type':                'm1.xlarge',

    // IAM profile assigned to instances launched
    'iam-profile':                  'taskcluster-worker',

    // Spot bid in USD
    'spot-price':                   0.1,

    // Max number of instances to have running
    'max-instances':                20,

    // Security groups to assign workers
    'security-groups':              ['ssh-only'],

    // Key name for instances launched, this must be unique as the key-name will
    // be used query for running instances and this provisioner reserves the
    // right to kill any instance with it's key-name...
    'key-name':                     'provisioner-managed'
  },

  // Queue configuration
  'queue': {
    // Host name for the taskcluster-queue
    'host':                         'localhost',
    
    // Port for the taskcluster-queue
    'port':                         '3000',

    // API version of the taskcluster-queue
    'version':                      'v1'
  },

  // AWS SDK Configuration
  'aws': {
    // Default AWS region, this is where S3 buckets etc. will be placed.
    // In the first iteration this is also where spot instances will be launched
    region:                         'us-west-2',

    // Lock API version to use the latest API from 2013, this is fuzzy locking,
    // but it does the trick...
    apiVersion:                     '2014-01-01'
  }
};

/** Load configuration */
exports.load = function(default_only) {

  if (!default_only || true) {
    // Load configuration from command line arguments, if requested
    nconf.argv();

    // Config from current working folder if present
    nconf.file('local', 'taskcluster-aws-provisioner.conf.json');

    // User configuration
    nconf.file('user', '~/.taskcluster-aws-provisioner.conf.json');

    // Global configuration
    nconf.file('global', '/etc/taskcluster-aws-provisioner.conf.json');
  }

  // Load default configuration
  nconf.defaults(DEFAULT_CONFIG_VALUES);

  // Set configuration for aws-sdk
  aws.config.update(nconf.get('aws'));
}
