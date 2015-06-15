'use strict';

var base = require('taskcluster-base');
var assert = require('assert');
var debug = require('debug')('aws-provisioner:Secret')
var taskcluster = require('taskcluster-client');

var Secret = base.Entity.configure({
  version: 1,

  // TODO: verify these are valid azure keys - heeeelp please Jonas
  partitionKey: base.Entity.keys.StringKey('token'),
  rowKey: base.Entity.keys.StringKey('provisionerId'),

  properties: {
    token: base.Entity.types.String,
    created: base.Entity.types.Date,
    provisionerId: base.Entity.types.String,
    workerType: base.Entity.types.String,
    secrets: base.Entity.types.JSON,
  },
});

// we pass through the json from the HTTP post request body
Secret.create = function (token, provisionerId, body) {
  assert(typeof body === 'object');
  assert(body.workerType);
  assert(body.secrets);
  assert(typeof body.secrets === 'object');
  var properties = {
    token: token,
    created: new Date(),
    provisionerId: provisionerId,
    workerType: body.workerType,
    secrets: body.secrets,
  };
  debug('Created Secret entity %s: %j', token, body.secrets);
  return base.Entity.create.call(this, properties);
};

Secret.prototype.modify = function () {
  throw new Error('No modifications to secrets are allowed');
};

Secret.prototype.listAll = function () {
  throw new Error();
};

module.exports = Secret;
