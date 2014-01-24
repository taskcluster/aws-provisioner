var Promise                         = require('promise');
var fs                              = require('fs');
var nconf                           = require('nconf');
var aws                             = require('aws-sdk');
var uuid                            = require('uuid');

// Load a little monkey patching
require('./aws-sdk-promise').patch();
require('./spread-promise').patch();

// Load configuration from command line arguments
nconf.argv({
  help: {
    alias:                          'h',
    demand:                         false,
    default:                        false
  },
  key: {
    alias:                          'k',
    demand:                         false,
    default:                        undefined
  },
  force: {
    alias:                          'f',
    demand:                         false,
    default:                        false
  },
  region: {
    alias:                          'r',
    demand:                         false,
    default:                        'us-west-2'
  },
});

// Show help message if needed
if (nconf.get('help')) {
  console.log([
    'usage: node utils/setup-aws.js [--help] [--key FILE]',
    '',
    '  -h, --help               Show this help message',
    '  -k, --key FILE           Use FILE as public key',
    '  -f, --force              Force overwrite dirty state',
    '  -r, --region region      AWS region to setup, defaults to us-west-2',
    ''
  ].join('\n'));
  process.exit(0);
}

// Config filename
var config_filename = 'taskcluster-aws-provisioner.conf.json';

// Load local config file
var data = "{}";
try {
  data = fs.readFileSync(config_filename, {encoding: 'utf-8'});
}
catch (error) {
  // Ignore file doesn't exists errors
  if (error.code != 'ENOENT') {
    throw error;
  }
}

var cfg  = JSON.parse(data);

// Setup ec2
var ec2 = new aws.EC2({region: nconf.get('region')});

// Check if there is an existing key-name
var dirty_state = Promise.from(false);
var key_name = (cfg.provisioning  || {})['key-name'];
if (key_name !== undefined) {
  // Check if this key-name exists on AWS, if not then we don't really have to
  // worry about it...
  dirty_state = ec2.describeKeyPairs({
    KeyNames: [key_name]
  }).promise().then(function(response) {
    var retval = false;
    response.data.KeyPairs.forEach(function(keyPair) {
      if (keyPair.KeyName == key_name) {
        retval = true;
      }
    });
    return retval;
  }, function(error) {
    if (error.code == 'InvalidKeyPair.NotFound') {
      return false;
    }
    throw error;
  }).then(function(isDirty) {
    // Show warning if we're in a dirty state
    if (isDirty) {
      console.log([
        "WARNING: Local config file '" + config_filename + "'",
        "         contains key-name which already exists on AWS:",
        "         '" + key_name + "'",
        "         Please make sure you've cleaned up any previous",
        "         provisioner tests on AWS."
      ].join('\n'));
    }
    return isDirty;
  });
}

// New key-name
var keyName = 'provisioner-test-' + uuid.v4();

var key_created = dirty_state.then(function(isDirty) {
  // Abort if we're not force overwriting a dirty state
  if (isDirty && !nconf.get('force')) {
    throw "Error: --force is required to ignore existing key-name!";
  }
  if (isDirty) {
    console.log("WARNING: Overwriting previous key-name due to --force.");
  }

  // Create key either using existing ssh key public key or just by generating
  // a new one on aws servers
  if (nconf.get('key')) {
    // Read key from file
    var keyData = fs.readFileSync(nconf.get('key'), {encoding: 'utf-8'});
    keyData = (new Buffer(keyData)).toString('base64')
    console.log(keyData)
    return ec2.importKeyPair({
      KeyName:                      keyName,
      PublicKeyMaterial:            keyData
    }).promise();
  } else {
    // Create a new key
    return ec2.createKeyPair({
      KeyName:                      keyName
    }).promise().then(function(response) {
      // Write local file with created key, if this was successful
      fs.writeFileSync(keyName + '.pem', response.data.KeyMaterial);
    });
  }
});

// When the key is created update config file
key_created.then(function() {
  // Set keyName on cfg
  var provisioning = (cfg.provisioning || {});
  provisioning['key-name'] = keyName;
  cfg.provisioning = provisioning;

  // Set region on cfg
  var awscfg = (cfg.aws || {});
  awscfg.region = nconf.get('region');
  cfg.aws = awscfg;

  // Write config file to disk
  fs.writeFileSync(config_filename, JSON.stringify(cfg));

  console.log("setup-aws successfully created " + keyName);
}, function(error) {
  console.log("setup-aws failed!");
  console.log(error);
  process.exit(1);
});