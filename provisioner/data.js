var base        = require('taskcluster-base');
var assert      = require('assert');
var Promise     = require('promise');
var _           = require('lodash');
var debug = require('debug')('aws-provisioner:provisioner:data');

var ROW_KEY_CONST = 'worker-type';

/** Entities for persisting WorkerType */
var WorkerType = base.Entity.configure({
  version: 1,
  partitionKey: base.Entity.keys.StringKey('workerType'),
  rowKey: base.Entity.keys.StringKey('workerType'),
  properties: {
    workerType: base.Entity.types.String,
    launchSpecification: base.Entity.types.JSON,
    minCapacity: base.Entity.types.Number,
    maxCapacity: base.Entity.types.Number,
    scalingRation: base.Entity.types.Number,
    minSpotBid: base.Entity.types.Number,
    maxSpotBid: base.Entity.types.Number,
    canUseOndemand: base.Entity.types.JSON,
    canUseSpot: base.Entity.types.JSON,
    types: base.Entity.types.JSON,
    regions: base.Entity.types.JSON,
  }
});

/** Create a worker type */
WorkerType.create = function(workerType, properties) {
  properties.RowKey = ROW_KEY_CONST;
  properties.workerType = workerType;
  return base.Entity.create.call(this, properties);
};

/** Load worker from worker type */
WorkerType.load = function(workerType) {
  return base.Entity.load.call(this, workerType, ROW_KEY_CONST);
};

/** Prepare a workerType for display */
WorkerType.loadForReply = function(workerType) {
  var worker = this.load(workerType);
  worker[workerType] = workerType;
  return worker;
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
