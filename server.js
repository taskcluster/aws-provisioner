// Load configuration
var config  = require('./config');

// Load default_only if server.js has a parent, hence, is being imported
config.load(module.parent);

// Dependencies
var express                         = require('express');
var http                            = require('http');
var path                            = require('path');
var nconf                           = require('nconf');
var passport                        = require('passport');
var PersonaStrategy                 = require('passport-persona').Strategy;
var data                            = require('./provisioner/data');
var state                           = require('./provisioner/state');
var debug                           = require('debug')('server');
var Promise                         = require('promise');

// Load a little monkey patching
require('./utils/aws-sdk-promise').patch();

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
app.use(express.cookieParser(nconf.get('server:cookieSecret')));
app.use(express.session());
app.use(passport.initialize());
app.use(passport.session());
app.use(function(req, res, next) {
  // Expose user to all templates, if logged in
  res.locals.user = req.user;
  next();
});
app.use(app.router);
app.use('/assets', require('stylus').middleware(path.join(__dirname, 'assets')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Warn if no secret was used in production
if ('production' == app.get('env')) {
  var secret = nconf.get('server:cookieSecret');
  if (secret == "Warn, if no secret is used on production") {
    console.log("Warning: Customized cookie secret should be used in production");
  }
}

// Middleware for development
if ('development' == app.get('env')) {
  console.log("Launched in development-mode");
  app.use(express.errorHandler());
}

// Passport configuration
passport.use(new PersonaStrategy({
    audience: 'http://' + nconf.get('server:hostname') + ':' +
               nconf.get('server:port')
  },
  function(email, done) {
    console.log("Signed in with:" + email);
    if (/@mozilla\.com$/.test(email)) {
      done(null, {email: email});
    } else {
      done(null, null);
    }
  }
));

// Serialize user to signed cookie
passport.serializeUser(function(user, done) {
  done(null, user.email);
});

// Deserialize user from signed cookie
passport.deserializeUser(function(email, done) {
  done(null, {email: email});
});

app.post('/persona-auth',
  passport.authenticate('persona', {failureRedirect: '/unauthorized'}),
  function(req, res) {
    res.redirect('/');
  }
);

app.get('/logout', function(req, res){
  req.logout();
  res.redirect('/');
});

/** Middleware for requiring authenticatoin */
var ensureAuthenticated = function(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect('/unauthorized');
}

// Route configuration
var routes = require('./routes');
app.get('/',                                                    routes.index);
app.get('/unauthorized',                                        routes.unauthorized);
app.get('/worker-type',                   ensureAuthenticated,  routes.workertype.list);
app.get('/worker-type/create',            ensureAuthenticated,  routes.workertype.create);
app.get('/worker-type/:workerType/view',  ensureAuthenticated,  routes.workertype.view);
app.get('/worker-type/:workerType/edit',  ensureAuthenticated,  routes.workertype.edit);
app.get('/worker-type/:workerType/delete',ensureAuthenticated,  routes.workertype.delete);
app.post('/worker-type/update',           ensureAuthenticated,  routes.workertype.update)


/** Launch the server */
exports.launch = function() {
  debug("Launching server");

  if ('development' == app.get('env')) {
    debug("Launching in development-mode");
  }

  // Setup
  return data.ensureTable(data.WorkerType).then(function() {
    return state.load();
  }).then(function() {
    return new Promise(function(accept, reject) {
      // Launch HTTP server
      var server = http.createServer(app);

      // Add a little method to help kill the server
      server.terminate = function() {
        return new Promise(function(accept, reject) {
          server.close(function() {
            accept(Promise.all(events.disconnect(), data.disconnect()));
          });
        });
      };

      // Listen
      server.listen(app.get('port'), function(){
        debug('Express server listening on port ' + app.get('port'));
        accept(server);
      });

      // Setup provisioning
      var provisioner = require('./provisioner');

      // provision instances then schedule next provision at configured interval
      var provision_and_schedule = function() {
        provisioner.provision().then(function() {
          setTimeout(provision_and_schedule,
                     nconf.get('provisioner:interval') * 1000);
        }, function(err) {
          debug("Provisioning Error: %s, as JSON: %j", err, err, err.stack);
          setTimeout(provision_and_schedule,
                     nconf.get('provisioner:interval') * 1000);
        });
      };

      // Provision instances after first 3 sec
      setTimeout(provision_and_schedule, 3 * 1000);
    });
  });
};

// If server.js is executed start the server
if (!module.parent) {
  exports.launch().then(function() {
    // If launched in development mode as a subprocess of node, then we'll
    // sending a message informing the parent process that we're now ready!
    if (app.get('env') == 'development' && process.send) {
      process.send({ready: true});
    }
    debug("Launch queue successfully");
  }).catch(function(err) {
    debug("Failed to start server, err: %s, as JSON: %j", err, err, err.stack);
    // If we didn't launch the server we should crash
    process.exit(1);
  });
}
