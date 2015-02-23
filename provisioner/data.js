var base        = require('taskcluster-base');
var assert      = require('assert');
var Promise     = require('promise');
var _           = require('lodash');
var debug = require('debug')('aws-provisioner:provisioner:data');

var KEY_CONST = 'worker-type';

/** Entities for persisting WorkerType */
var WorkerType = base.Entity.configure({
  version: 1,
  partitionKey: base.Entity.keys.ConstantKey(KEY_CONST),
  rowKey: base.Entity.keys.StringKey('workerType'),
  properties: {
    workerType: base.Entity.types.String,
    launchSpecification: base.Entity.types.JSON,
    minCapacity: base.Entity.types.Number,
    maxCapacity: base.Entity.types.Number,
    scalingRatio: base.Entity.types.Number,
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
  properties.workerType = workerType;
  return base.Entity.create.call(this, properties);
};

/** Load worker from worker type */
WorkerType.load = function(workerType) {
  return base.Entity.load.call(this, {
    workerType: workerType
  });
};

/** Give a JSON version of a worker type */
WorkerType.prototype.json = function() {
  return _.clone(this.__properties);
};

/** Load all worker types.  Note that this
 * This method only returns the __properties
 * from base.Entity.scan */
WorkerType.loadAll = function() {
  var workers = [];

  var p = base.Entity.scan.call(this, {}, {
    handler: function (item) {
      workers.push(item.__properties);
    }
  });

  p = p.then(function() {
    return workers;
  });

  return p;
};

/** Load all workerTypes.  This won't scale perfectly, but
 *  we don't see there being a huge number of these upfront */
WorkerType.loadAllNames = function() {
  var names = [];

  var p = base.Entity.scan.call(this, {}, {
    handler: function (item) {
      names.push(item.workerType);
    }
  });

  p = p.then(function() {
    return names;
  });

  return p;
};

/** Remove worker type with given workertype */
WorkerType.remove = function(workerType) {
  return base.Entity.remove.call(this, {
    workerType: workerType
  });
};


// Export WorkerType
exports.WorkerType = WorkerType;
