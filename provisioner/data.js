var base        = require('taskcluster-base');
var assert      = require('assert');
var Promise     = require('promise');
var _           = require('lodash');

/** Entities for persisting WorkerType */
var WorkerType = base.Entity.configure({
  mapping: [
    {
      key:                'PartitionKey',
      property:           'workerType',
      type:               'keystring'
    }, {
      // This is always hardcoded to 'worker-type', as we don't have any sane
      // value for this key
      key:              'RowKey',
      type:             'string',
      hidden:           true
    },
    { key: 'version',     type: 'number'    },
    { key: 'definition',  type: 'json'      } // up to 32kb JSON data
    // Note, not all properties have to be properties on the entity.
    // It only makes sense to add multiple properties if you want to query by
    // them... Or if you want to add a lot of JSON, it can be necessary to split
    // it...
  ]
});

// Export WorkerType
exports.WorkerType = WorkerType;