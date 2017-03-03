let mocha = require('mocha');

let taskcluster = require('taskcluster-client');
let testing = require('taskcluster-lib-testing');

let main = require('../lib/main');

let client;
let server;

mocha.before(async () => {
  client = await main('apiClient', {process: 'apiClient', profile: 'test'});
  server = await main('server', {process: 'server', profile: 'test'});

  // Mock out the authentication
  let x = {};
  x[client._options.credentials.clientId] = ['*'];
  testing.fakeauth.start(x);
});

mocha.after(async () => {
  testing.fakeauth.stop();
  await server.terminate();
});

module.exports.getServer = function() {
  return server;
};

module.exports.getClient = function() {
  return client;
};
