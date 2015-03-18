/**
Wrapper around taskcluster client to connect and bind a queue to the correct
exchanges.
*/

var taskcluster = require('taskcluster-client');
var nconf       = require('nconf');
var Promise     = require('promise');

var PREFIX = 'worker/v1/aws-provisioner/';

/**
 * Bind to a predefined set of exchanges for worker creations.
 */
exports.bind = function(workerType) {
  return Promise.from(null);  // Stop this code from running
  var queueEvents      = new taskcluster.QueueEvents();
  var queueName        = PREFIX + workerType;
  // Initialize the listener which will bind the queue.
  var listener         = new taskcluster.PulseListener({
    queueName: queueName,
    credentials: {
      username: nconf.get('pulse:username'),
      password: nconf.get('pulse:password')
    }
  });

  listener.bind(queueEvents.taskPending({
    workerType:    workerType,
    provisionerId: 'aws-provisioner'
  }));

  // Connect & bind queue to events but do not actually consume any events...
  return listener.connect().then(function() {
    // Ensure we don't keep the connection open we only need to bind.
    return listener.close();
  });
};

/** delete named queue */
exports.unbind = function(workerType) {
  return Promise.from(null);  // Stop this code from running
  var queueEvents      = new taskcluster.QueueEvents();
  var queueName        = PREFIX + workerType;
  // Initialize the listener which will bind the queue.
  var listener         = new taskcluster.PulseListener({
    queueName: queueName,
    credentials: {
      username: nconf.get('pulse:username'),
      password: nconf.get('pulse:password')
    }
  });

  listener.bind(queueEvents.taskPending({
    workerType:    workerType,
    provisionerId: 'aws-provisioner'
  }));

  return listener.deleteQueue();
};

