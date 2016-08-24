let log = require('taskcluster-lib-log');

let env = process.env.NODE_ENV;
if (!env) {
  throw new Error('You must have an environment');
}

module.exports = log('aws-provisioner-' + env.trim());
