











// THIS IS OLD code that MIGHT be useful!!!!!!!!!!!!!!!!!!
















var Promise                         = require('promise');
var fs                              = require('fs');
var nconf                           = require('nconf');
var aws                             = require('aws-sdk');
var uuid                            = require('uuid');

// Load a little monkey patching
require('./aws-sdk-promise').patch();

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

var cfg = JSON.parse(data);

// If provisioner and keyname prefix and not
if (cfg.provisioner && cfg.provisioner.keyNamePrefix && !nconf.get('force')) {
  console.log("Either specify --force or run cleanup-aws.js first!");
  process.exit(1);
}


// If key is missing demand it
if (!nconf.get('key')) {
  console.log("You must specify public key as file with --key");
  process.exit(1);
}
// Read key from file
var keyData = fs.readFileSync(nconf.get('key'), {encoding: 'utf-8'});
keyData = (new Buffer(keyData)).toString('base64');

cfg.provisioner = cfg.provisioner || {};
cfg.provisioner.keyNamePrefix = 'provisioner-test-' + uuid.v4() + ':';
cfg.provisioner.publicKeyData = keyData;

// Set region on cfg
var awscfg = (cfg.aws || {});
awscfg.region = nconf.get('region');
cfg.aws = awscfg;

// Write config file to disk
fs.writeFileSync(config_filename, JSON.stringify(cfg, null, 2));

console.log("Setup completed");