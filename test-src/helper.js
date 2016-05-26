let mocha = require('mocha');

let base = require('taskcluster-base');
let taskcluster = require('taskcluster-client');

let main = require('../lib/main');

let client;
let server;

mocha.before(async () => {
  client = await main('apiClient', {process: 'apiClient', profile: 'test'});
  server = await main('server', {process: 'server', profile: 'test'});

  // Mock out the authentication
  let x = {};
  x[client._options.credentials.clientId] = ['*'];
  base.testing.fakeauth.start(x);
});

mocha.after(async () => {
  base.testing.fakeauth.stop();
  await server.terminate();
});

module.exports.getServer = function () {
  return server;
};

module.exports.getClient = function () {
  return client;
};
