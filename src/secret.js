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
    scopes: base.Entity.types.JSON,
  },
});

// Encrypt the secrets column
Secret = Secret.configure({
  version: 2,
  signEntities: true, // NEW
  properties: {
    token: base.Entity.types.String,
    expiration: base.Entity.types.Date,
    workerType: base.Entity.types.String,
    secrets: base.Entity.types.EncryptedJSON,
    scopes: base.Entity.types.JSON,
  },
  migrate: item => item, // no change in the column content, just format
});

Secret.prototype.modify = function() {
  throw new Error('No modifications of secrets are allowed');
};

module.exports = Secret;
