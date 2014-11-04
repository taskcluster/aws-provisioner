var base    = require('taskcluster-base');
var assert  = require('assert');

/** Declaration of exchanges offered by the aws-provisioner */
var exchanges = new base.Exchanges({
  title:      "AWS Provisioner Pulse Exchanges",
  description: [
    // TODO: Write docs
  ].join('\n')
});

// Export exchanges
module.exports = exchanges;

/** Common routing key construct for `exchanges.declare` */
var commonRoutingKey = [
  {
    // Let's keep the "primary." prefix, so we can support custom routing keys
    // in the future, I don't see a need for it here. But it's nice to have the
    // option of adding it later...
    name:             'routingKeyKind',
    summary:          "Identifier for the routing-key kind. This is " +
                      "always `'primary'` for the formalized routing key.",
    constant:         'primary',
    required:         true
  }, {
    name:             'workerType',
    summary:          "WorkerType that this message concerns.",
    required:         true,
    maxSize:          22
  }, {
    name:             'reserved',
    summary:          "Space reserved for future routing-key entries, you " +
                      "should always match this entry with `#`. As " +
                      "automatically done by our tooling, if not specified.",
    multipleWords:    true,
    maxSize:          1
  }
];

/** Build an pulse compatible message from a message */
var commonMessageBuilder = function(message) {
  message.version = 1;
  return message;
};

/** Build a routing-key from message */
var commonRoutingKeyBuilder = function(message) {
  return {
    workerType:       message.workerType
  };
};

/** Build a list of routes to CC */
var commonCCBuilder = function() {
  return [];
};

// Common schema prefix
var SCHEMA_PREFIX_CONST = 'http://schemas.taskcluster.net/aws-provisioner/v1/';

/** Task-graph running exchange */
exchanges.declare({
  exchange:           'worker-type-created',
  name:               'workerTypeCreated',    // Method to call on publisher
  title:              "WorkerType Created Message",
  description: [
    "When a new `workerType` is created a message will be published to this",
    "exchange."
  ].join('\n'),
  routingKey:         commonRoutingKey,
  schema:             SCHEMA_PREFIX_CONST + 'worker-type-created-message.json#',
  messageBuilder:     commonMessageBuilder,
  routingKeyBuilder:  commonRoutingKeyBuilder,
  CCBuilder:          commonCCBuilder
});


