'use strict';

var fs = require('fs');
var debug = require('debug')('bin:createWorker');
var tc = require('taskcluster-client');
var api = require('../routes/v1');

//var references = api.reference({baseUrl: "https://aws-provisioner2.herokuapp.com/v1"});
var references = api.reference({baseUrl: "http://localhost:5556/v1"});
var AwsProvisioner = tc.createClient(references);
var client = new AwsProvisioner();

var fileNames = process.argv.slice(2);

client.listWorkerTypes().then(function(extant) {
  fileNames.forEach(function(f) {
    var rawData = fs.readFileSync(f);
    var data;
    try {
      data = JSON.parse(rawData);
    } catch (e) {
      console.error('Error reading', f, e);
      process.exit(1);
    }
    debug(data);
    var workerType = data.workerType;
    delete data.workerType;

    var p;
    if (-1 === extant.indexOf(workerType)) {
      p = client.createWorkerType(workerType, data);
    } else {
      p = client.updateWorkerType(workerType, data);
    }

    p.then(client.workerType(workerType))
      .then(function(x) {
        console.log('Complete');
        console.log(JSON.stringify(x, null, 2));
      }, function (y) {
        console.log('Error!', y.stack, JSON.stringify(y, null, 2));
      });
  });
}).done();


