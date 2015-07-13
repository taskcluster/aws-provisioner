'use strict';

let base = require('taskcluster-base');

module.exports = base.Entity.configure({
  version: 1,

  partitionKey: base.Entity.keys.StringKey('workerType'),
  rowKey: base.Entity.keys.ConstantKey('state'),

  properties: {
    workerType: base.Entity.types.String,
    instances: base.Entity.types.JSON,
    requests: base.Entity.types.JSON,
    internalTrackedRequests: base.Entity.types.JSON,
  },
});
