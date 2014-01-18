// Dependencies
var express = require('express');
var http    = require('http');
var path    = require('path');
var nconf   = require('nconf');

// Load configuration
var config  = require('./config');

// Load default_only if server.js has a parent, hence, is being imported
config.load(module.parent);

// Load a little monkey patching
require('./utils/aws-sdk-promise').patch();
require('./utils/spread-promise').patch();

// Create expressjs application
var app = exports.app = express();

// Middleware configuration
app.set('port', nconf.get('server:port'));
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');
app.use(express.favicon());
app.use(express.logger('dev'));
app.use(express.json());
app.use(express.urlencoded());
app.use(express.methodOverride());
app.use(express.cookieParser(nconf.get('server:cookie-secret')));
app.use(express.session());
app.use(app.router);
app.use(require('stylus').middleware(path.join(__dirname, 'static')));
app.use(express.static(path.join(__dirname, 'static')));

// Warn if no secret was used in production
if ('production' == app.get('env')) {
  var secret = nconf.get('server:cookie-secret');
  if (secret == "Warn, if no secret is used on production") {
    console.log("Warning: Customized cookie secret should be used in production");
  }
}

// Middleware for development
if ('development' == app.get('env')) {
  console.log("Launched in development-mode");
  app.use(express.errorHandler());
}

// Route configuration
var routes = require('./routes');
app.get('/',                                routes.index);
app.get('/users',                           routes.users);
app.get('/0.1.0/kill-instance/:instance',   routes.api.kill);
app.get('/0.1.0/list-instances/:instance',  routes.api.list);

/** Run the server */
exports.run = function() {
  // Launch HTTP server
  http.createServer(app).listen(app.get('port'), function(){
    console.log('Express server listening on port ' + app.get('port'));
  });

  // Setup provisioning
  var provisioner = require('./provisioner');

  // Provision instances every 5 minutes
  setInterval(provisioner.provision, nconf.get('provisioning:interval') * 1000);
};

// If server.js is executed start the server
if (!module.parent) {
  exports.run();
}
