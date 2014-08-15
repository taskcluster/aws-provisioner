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
  var queueEvents      = new taskcluster.QueueEvents();
  var connectionString = nconf.get('amqp:url');
  var queueName        = PREFIX + workerType;
  // Initialize the listener which will bind the queue.
  var listener         = new taskcluster.Listener({
    connectionString: connectionString,
    queueName:        queueName
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
  var queueEvents      = new taskcluster.QueueEvents();
  var connectionString = nconf.get('amqp:url');
  var queueName        = PREFIX + workerType;
  // Initialize the listener which will bind the queue.
  var listener         = new taskcluster.Listener({
    connectionString: connectionString,
    queueName:        queueName
  });

  return listener.deleteQueue();
};

