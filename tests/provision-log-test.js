var mock_queue  = require('./mock-queue');
var server      = require('../server');
var log         = require('../provisioner/log');

/** Test the logging */
exports.log = function(test) {
  var cb = log("HACK", "Test that we can log", 4);
  test.ok(log.entries().length > 0, "Log entries was expected");
  test.done();
};


/** Test log entries retrieval */
exports.retrieval = function(test) {
  var cb = log("HACK", "Test that we can log", 4);
  test.ok(log.entries().length > 0, "Log entries was expected");
  var entry = log.entries().pop();
  test.ok(entry.action == 'HACK', "Couldn't find last log entry")
  test.done();
};

/** Test timing of on log entries */
exports.timing = function(test) {
  var cb = log("HACK", "Test that we can log", 4);
  test.ok(log.entries().length > 0, "Log entries was expected");
  cb();
  var entry = log.entries().pop();
  test.ok(entry.time instanceof Array, "Expected a timestamp");
  test.done();
};