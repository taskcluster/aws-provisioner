var Promise     = require('promise');
var debug       = require('debug')('routes:workertype');
var state       = require('../provisioner/state');
var bind        = require('../provisioner/bind');
var WorkerType  = require('../provisioner/data').WorkerType;
var aws         = require('aws-sdk');
var nconf       = require('nconf');

// Create ec2 service object
var ec2 = exports.ec2 = new aws.EC2();


/** List all registered workerTypes */
exports.list = function(req, res){
  res.render('workertype-list', {
    title:          "Registered WorkerTypes",
    workerTypes:    state.get()
  });
};

/** Show form to create new workerType */
exports.create = function(req, res){
  res.render('workertype-edit', {
    title:          "Create New WorkerType",
    workerType:     null
  });
};

/** View existing workerType */
exports.view = function(req, res, next){
  var wType = state.get().filter(function(wType) {
    return wType.workerType == req.params.workerType;
  })[0] || null;
  if (!wType) {
    return next();
  }
  res.render('workertype-view', {
    title:          "WorkerType " + wType.workerType,
    workerType:     wType
  });
};

/** Edit existing workerType */
exports.edit = function(req, res){
  var wType = state.get().filter(function(wType) {
    return wType.workerType == req.params.workerType;
  })[0] || null;
  if (!wType) {
    return next();
  }
  res.render('workertype-edit', {
    title:          "Edit " + wType.workerType,
    workerType:     wType
  });
};

/** Delete existing workerType */
exports.delete = function(req, res){
  var wType = state.get().filter(function(wType) {
    return wType.workerType == req.params.workerType;
  })[0] || null;
  if (!wType) {
    return next();
  }
  var workerType = wType.workerType;
  var keyName = nconf.get('provisioner:keyNamePrefix') + workerType;
  ec2.deleteKeyPair({
    KeyName:          keyName
  }).promise().then(function() {
    wType.remove(true).then(function() {
      state.removeWorkerType(wType);
      res.redirect(302, '/worker-type/');
    }).catch(function(err) {
      debug("Error in %s, err: %s, as JSON: %j", req.url, err, err, err.stack);
      res.render('error', {
        title:        "500 Internal Error",
        message:      "Hmm, something went wrong..."
      });
    });
  });
};

/** Update/create worker type and redirect to view */
exports.update = function(req, res){
  debug("Create/update workertype:\n%s", JSON.stringify(req.body, null, 2));
  // Find workerType if it exists
  var wType = state.get().filter(function(wType) {
    return wType.workerType == req.body.workerType;
  })[0] || null;

  Promise.from(null).then(function() {
    // Create WorkerType if requested
    if (req.body.updateOrCreate == 'create') {
      if (wType) {
        throw new Error("WorkerType " + wType.workerType + " already exists");
      }
      console.log('create the thing!?', req.body, '<<<!');
      var workerType = req.body.workerType;
      var keyName = nconf.get('provisioner:keyNamePrefix') + workerType;
      return ec2.importKeyPair({
        KeyName:                keyName,
        PublicKeyMaterial:      nconf.get('provisioner:publicKeyData')
      }).promise().then(function() {
        return WorkerType.create({
          version:        '0.2.0',
          workerType:     workerType,
          configuration: {
            launchSpecification:  JSON.parse(req.body.launchSpecification),
            maxInstances:         parseInt(req.body.maxInstances),
            spotBid:              req.body.spotBid
          }
        }).then(function(wType) {
          state.addWorkerType(wType);
        });
      });
    }

    // Update WorkerType if requested
    if (req.body.updateOrCreate == 'update') {
      return wType.modify(function() {
        this.configuration.launchSpecification  = JSON.parse(req.body.launchSpecification);
        this.configuration.maxInstances         = parseInt(req.body.maxInstances);
        this.configuration.spotBid              = req.body.spotBid;
      });
    }
  }).then(function() {
    if (req.body.bindQueue) {
      console.log('create the queue xofoos');
      return bind(req.body.workerType);
    }
  }).then(function() {
    res.redirect(302, '/worker-type/' + req.body.workerType + '/view');
  }).catch(function(err) {
    debug("Error in %s, err: %s, as JSON: %j", req.url, err, err, err.stack);
    res.render('error', {
      title:        "500 Internal Error",
      message:      "Hmm, something went wrong... it's might be your fault!"
    });
  });
};
