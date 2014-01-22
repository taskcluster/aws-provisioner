var fs      = require('fs');
var nconf   = require('nconf');
var aws     = require('aws-sdk');

/** Default configuration values */
var DEFAULT_CONFIG_VALUES = {
  // Run the provisioner without modifying AWS resources
  'dry-run':                        false,

  // Log provisioning actions to stdout
  'log-actions':                    false,

  // Server (HTTP) configuration
  'server': {
    // Server hostname
    'hostname':                     'localhost',

    // Port to run the HTTP server on
    'port':                         3000,

    // Cookie secret used to sign cookies, must be secret at deployment
    'cookie-secret':                "Warn, if no secret is used on production"
  },

  // Settings related to provisioning
  'provisioning': {
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
    'key-name':                     'provisioner-managed',

    // File to write log of scaling actions to
    'log-path':                     '/tmp/taskcluster-aws-provisioner-actions.log'
  },

  // Queue configuration
  'queue': {
    // Host name for the taskcluster-queue
    'host':                         'localhost:4242',

    // API version of the taskcluster-queue
    'version':                      '0.1.0'
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
  if (!default_only) {
    // Load configuration from command line arguments, if requested
    nconf.argv();

    // User configuration
    nconf.file('~/.taskcluster-spot-provisioner.conf.json');

    // Global configuration
    nconf.file('/etc/taskcluster-spot-provisioner.conf.json');
  }


  // Load default configuration
  nconf.defaults(DEFAULT_CONFIG_VALUES);

  // Set configuration for aws-sdk
  aws.config.update(nconf.get('aws'));
}
