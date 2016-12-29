let Entity = require('azure-entities');

let Secret = Entity.configure({
  version: 1,

  partitionKey: Entity.keys.StringKey('token'),
  rowKey: Entity.keys.ConstantKey('secret'),

  properties: {
    token: Entity.types.String,
    expiration: Entity.types.Date,
    workerType: Entity.types.String,
    secrets: Entity.types.JSON,
    scopes: Entity.types.JSON,
  },
});

Secret.prototype.modify = function() {
  throw new Error('No modifications of secrets are allowed');
};

module.exports = Secret;
