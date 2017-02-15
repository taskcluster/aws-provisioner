let Exchanges = require('pulse-publisher');

/** Declaration of exchanges offered by the aws-provisioner */
let exchanges = new Exchanges({
  title: 'AWS Provisioner Pulse Exchanges',
  description: [
    'Exchanges from the provisioner... more docs later',
  ].join('\n'),
  schemaPrefix: 'http://schemas.taskcluster.net/aws-provisioner/v1/',
});

// Export exchanges
module.exports = exchanges;

/** Common routing key construct for `exchanges.declare` */
let commonRoutingKey = [
  {
    // Let's keep the "primary." prefix, so we can support custom routing keys
    // in the future, I don't see a need for it here. But it's nice to have the
    // option of adding it later...
    name: 'routingKeyKind',
    summary: 'Identifier for the routing-key kind. This is ' +
             'always `\'primary\'` for the formalized routing key.',
    constant: 'primary',
    required: true,
  }, {
    name: 'workerType',
    summary: 'WorkerType that this message concerns.',
    required: true,
    maxSize: 22,
  }, {
    name: 'reserved',
    summary: 'Space reserved for future routing-key entries, you ' +
             'should always match this entry with `#`. As ' +
             'automatically done by our tooling, if not specified.',
    multipleWords: true,
    maxSize: 1,
  },
];

/** Build an pulse compatible message from a message */
let commonMessageBuilder = function(message) {
  message.version = 1;
  return message;
};

/** Build a routing-key from message */
let commonRoutingKeyBuilder = function(message) {
  return {workerType: message.workerType};
};

/** Build a list of routes to CC */
let commonCCBuilder = function() {
  return [];
};

exchanges.declare({
  exchange: 'worker-type-created',
  name: 'workerTypeCreated',  // Method to call on publisher
  title: 'WorkerType Created Message',
  description: [
    'When a new `workerType` is created a message will be published to this',
    'exchange.',
  ].join('\n'),
  routingKey: commonRoutingKey,
  schema: 'worker-type-message.json#',
  messageBuilder: commonMessageBuilder,
  routingKeyBuilder: commonRoutingKeyBuilder,
  CCBuilder: commonCCBuilder,
});

exchanges.declare({
  exchange: 'worker-type-updated',
  name: 'workerTypeUpdated',    // Method to call on publisher
  title: 'WorkerType Updated Message',
  description: [
    'When a `workerType` is updated a message will be published to this',
    'exchange.',
  ].join('\n'),
  routingKey: commonRoutingKey,
  schema: 'worker-type-message.json#',
  messageBuilder: commonMessageBuilder,
  routingKeyBuilder: commonRoutingKeyBuilder,
  CCBuilder: commonCCBuilder,
});

exchanges.declare({
  exchange: 'worker-type-removed',
  name: 'workerTypeRemoved',    // Method to call on publisher
  title: 'WorkerType Removed Message',
  description: [
    'When a `workerType` is removed a message will be published to this',
    'exchange.',
  ].join('\n'),
  routingKey: commonRoutingKey,
  schema: 'worker-type-message.json#',
  messageBuilder: commonMessageBuilder,
  routingKeyBuilder: commonRoutingKeyBuilder,
  CCBuilder: commonCCBuilder,
});
