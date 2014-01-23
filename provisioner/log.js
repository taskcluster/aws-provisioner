var nconf   = require('nconf');
var fs      = require('fs');
var _       = require('lodash');

// List of log entries
var _entries = [];

/** Pad string with spaces */
function pad(msg, n) {
  while (msg.length < n) {
    msg += " ";
  }
  return msg;
}

/**
 * Log the beginning of an operation, this returns a callback to be invoked
 * when the operation ends...
 */
var log = function(action, message, quantity) {
  if (quantity === undefined) {
    quantity = null;
  }
  var start = process.hrtime();
  var entry = {
    action:                         action,
    message:                        message,
    quantity:                       quantity,
    time:                           null
  };
  _entries.push(entry);
  if (_entries.lenght > 20) {
    _entries.shift();
  }

  // Log entry if needed
  if (nconf.get('log-actions')) {
    console.log(pad(action + ':', 15) + message.replace('%i', entry.quantity) +
                ' - quantity: ' + quantity);
  }

  // Return callback to measure time elapsed
  return function(message, quantity) {
    if (entry.time !== null) {
      console.log("Entry was ended twice: " + JSON.stringify(entry));
    }
    entry.time = process.hrtime(start);
    if (message !== undefined) {
      entry.message += " - " + message;
    }
    if (quantity !== undefined) {
      entry.quantity = quantity;
    }
    if (nconf.get('log-actions')) {
      console.log(
        pad(entry.action + ':', 15) +
        entry.message.replace('%i', entry.quantity) + ' - ' + entry.time[0] +
        ' s and ' + entry.time[1] + ' ns'
      );
    }
  };
};

/** Get log entries */
log.entries = function() {
  return _.cloneDeep(_entries);
};

module.exports = log;