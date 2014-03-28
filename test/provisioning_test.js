suite('Provisioning Tests', function() {
  // Load mock queue, server and provision module from provisioner
  var debug             = require('debug')('provisioning-test');
  var request           = require('superagent-promise');
  var assert            = require('assert');
  var slugid            = require('slugid');
  var LocalProvisioner  = require('./localprovisioner');

  var _provisioner = null;
  setup(function() {
    _provisioner = new LocalProvisioner();
    return _provisioner.launch();
  });

  teardown(function() {
    _provisioner.terminate();
  });

  var baseUrl = 'http://localhost:3001';

  suite('createWorkerType', function() {
    var workerType = slugid.v4();
    return request
      .post(baseUrl + '/worker-type/update')
      .send({
        updateOrCreate:       'create',
        workerType:           workerType,
        launchSpecification: {
          ImageId:            'ami-7eaecc4e',
          InstanceType:       't1.micro'
        },
        maxInstances:         1,
        spotBid:              0.2
      }).end().then(function(res) {
        assert(res.ok);
      });
  });
});
