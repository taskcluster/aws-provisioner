'use strict';

var base = require('taskcluster-base');
var assert = require('assert');
var debug = require('debug')('aws-provisioner:Secret')
var taskcluster = require('taskcluster-client');

var Secret = base.Entity.configure({
  version: 1,

  partitionKey: base.Entity.keys.StringKey('token'),
  rowKey: base.Entity.keys.ConstantKey('secret'),

  properties: {
    token: base.Entity.types.String,
    expiration: base.Entity.types.Date,
    workerType: base.Entity.types.String,
    secrets: base.Entity.types.JSON,
    scopes: base.Entity.types.JSON,
  },
});

Secret.prototype.modify = function () {
  throw new Error('No modifications of secrets are allowed');
};

module.exports = Secret;
