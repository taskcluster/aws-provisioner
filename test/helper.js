'use strict';
var Promise = require('promise');
var path = require('path');
var _ = require('lodash');
var base = require('taskcluster-base');
var v1 = require('../routes/v1');
//var exchanges   = require('../auth/exchanges');
var taskcluster = require('taskcluster-client');

// Load configuration
var cfg = base.config({
  defaults: require('../config/defaults'),
  profile: require('../config/test'),
  filename: 'test-config',
});

/** Return a promise that sleeps for `delay` ms before resolving */
exports.sleep = function(delay) {
  return new Promise(function(accept) {
    setTimeout(accept, delay);
  });
};

exports.cfg = cfg;

/* eslint no-undef: 0, no-unused-expressions: 0 */

/** Setup testing */
exports.setup = function(options) {
  // Provide default configuration
  options = _.defaults(options || {}, {title: 'untitled test'});

  // Create subject to be tested by test
  var subject = {};

  // It's an error to run tests without credentials
  if (!cfg.get('azure:accountKey') ||
      !cfg.get('influx:connectionString')) {
    throw new Error('Cannot configure helper for ' + options.title);
  }


  // TODO: Switch from development config to test one!
  // Configure server
  var server = new base.testing.LocalApp({
    command: path.join(__dirname, '..', 'bin', 'server.js'),
    args: ['test'],
    name: 'server.js',
    baseUrlPath: '/v1',
  });

  // Hold reference to all listeners created with `subject.listenFor`
  var listeners = [];

  // Setup server
  setup(function() {
    // Utility function to listen for a message
    // Return an object with two properties/promises:
    // {
    //   ready:   Promise,  // Resolved when we've started to listen
    //   message: Promise   // Resolved when we've received a message
    // }
    subject.listenFor = function(binding) {
      // Create listener
      var listener = new taskcluster.PulseListener({
        username: cfg.get('pulse:username'),
        password: cfg.get('pulse:password'),
      });
      // Track it, so we can close it in teardown()
      listeners.push(listener);
      // Bind to binding
      listener.bind(binding);
      // Wait for a message
      var gotMessage = new Promise(function(accept, reject) {
        listener.on('message', accept);
        listener.on('error', reject);
      });
      return {
        ready: listener.resume(),
        message: gotMessage,
      };
    };
    // Set root credentials on subject
    // (so we only have to hardcode it in test.js)
    return server.launch().then(function(baseUrl) {
      // Create client for working with API
      subject.baseUrl = baseUrl;
      var reference = v1.reference({baseUrl: baseUrl});
      subject.AwsProvisioner = taskcluster.createClient(reference);
      subject.awsProvisioner = new subject.AwsProvisioner({
        baseUrl: baseUrl,
      });

      subject.badCred = new subject.AwsProvisioner({
        baseUrl: baseUrl,
        credentials: {clientId: 'c', accessToken: 'a'},
      });

    });
  });

  // Shutdown server
  teardown(function() {
    // Kill server
    return server.terminate().then(function() {
      return Promise.all(listeners.map(function(listener) {
        return listener.close();
      })).then(function() {
        listeners = [];
      });
    });
  });

  return subject;
};
