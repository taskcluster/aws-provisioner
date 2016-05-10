let base = require('taskcluster-base');

let Secret = base.Entity.configure({
  version: 1,

  partitionKey: base.Entity.keys.StringKey('token'),
  rowKey: base.Entity.keys.ConstantKey('secret'),

  properties: {
    token: base.Entity.types.String,
    expiration: base.Entity.types.Date,
    workerType: base.Entity.types.String,
    secrets: base.Entity.types.JSON,
    region: base.Entity.types.String,
  },
});

Secret.prototype.modify = function () {
  throw new Error('No modifications of secrets are allowed');
};

module.exports = Secret;
