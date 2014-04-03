suite('State Tests', function() {
  // Load config
  var server            = require('../server');

  var debug             = require('debug')('state-test');
  var request           = require('superagent-promise');
  var assert            = require('assert');
  var WorkerType        = require('../provisioner/data.js').WorkerType;
  var state             = require('../provisioner/state.js');


  var wType = new WorkerType({
    PartitionKey:   'TestWorkerType',
    RowKey:         'definition',
    version:        '0.2.0',
    configuration: JSON.stringify({
      launchConfiguration: {
        ImageId:            'ami-7eaecc4e',
        InstanceType:       't1.micro'
      },
      spotBid:                0.2,
      maxInstances:           2
    })
  });

  state.addWorkerType(wType);

  test('Update State', function() {
    return state.updateAndMurder().then(function() {
      assert(wType.pendingSpotRequests.length == 0);
      assert(wType.runningInstances.length == 0);
      assert(wType.pendingTasks.length == 0);
    });
  });
});
