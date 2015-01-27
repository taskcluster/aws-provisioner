var base        = require('taskcluster-base');
var assert      = require('assert');
var Promise     = require('promise');
var _           = require('lodash');
var debug = require('debug')('aws-provisioner:provisioner:data');

var ROW_KEY_CONST = 'worker-type';

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
    { key: 'version', type: 'number'},

    // Store worker specific information
    { key: 'launchSpecification', type: 'json'},

    // Store the maximum number of combined instances This is global max, so
    // across all instance types
    { key: 'minInstances', type: 'number'},
    { key: 'maxInstances', type: 'number'},

    // A scaling ratio of 1.1 means that we don't start spawning new machines
    // until 10% of our capacity is pending.  A scaling ratio of 0.9 means that
    // we spawn enough machines that we always have 10% empty capacity.
    // DEFAULT: 1
    { key: 'scalingRatio', type: 'number'},

    // What are our minimum and maximum spot bids in dollars?
    { key: 'minSpotBid', type: 'number'},
    { key: 'maxSpotBid', type: 'number'},

    // Can we use ondemand, just 'true' or 'false'
    { key: 'canUseOndemand', type: 'json'},
    
    // Can we use spot, just 'true' or 'false'
    { key: 'canUseSpot', type: 'json'},
    
    // A list of ordered instance types allowed for this worker
    // This JSON is just a list
    { key: 'allowedInstanceTypes', type: 'json'},

    // A list of regions allowed for this worker type
    // This JSON is just a list
    { key: 'allowedRegions', type: 'json'},

  ]
});

// RowKey constant, used as we don't need a RowKey
var ROW_KEY_CONST = 'worker-type';

var MANDATORY_ENTITIES = [
  
];

/** Create a worker type */
WorkerType.create = function(properties) {
  properties.RowKey = ROW_KEY_CONST;
  return base.Entity.create.call(this, properties);
};

/** Load worker from worker type */
WorkerType.load = function(workerType) {
  return base.Entity.load.call(this, workerType, ROW_KEY_CONST);
};

/** Load all worker types */
WorkerType.loadAll = function() {
  return base.Entity.queryRowKey.call(this, ROW_KEY_CONST);
};

WorkerType.loadAllNames = function() {
  return base.Entity.queryRowKey.call(this, ROW_KEY_CONST).then(function(result) {
    return result.map(function(i) { 
      return i.workerType;
    });
  });
};

/** Remove worker type with given workertype */
WorkerType.remove = function(workerType) {
  return base.Entity.remove.call(this, workerType, ROW_KEY_CONST);
};

// Export WorkerType
exports.WorkerType = WorkerType;
