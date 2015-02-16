'use strict';
process.env.DEBUG='';

var fs = require('fs');
var debug = require('debug')('bin:createWorker');
var tc = require('taskcluster-client');
var api = require('../routes/v1');
var Promise = require('promise');

var references = api.reference({baseUrl: "https://aws-provisioner2.herokuapp.com/v1"});
//var references = api.reference({baseUrl: "http://localhost:5556/v1"});
var AwsProvisioner = tc.createClient(references);
var client = new AwsProvisioner();

var action = process.argv[2] || 'list';
var names = process.argv.slice(3) || [];

function classifyNames(names) {
  var p = client.listWorkerTypes();

  p = p.then(function(listing) {
    var existing = names.filter(function(name) {
      return -1 !== listing.indexOf(name);
    });

    var notExisting = names.filter(function(name) {
      return -1 === listing.indexOf(name);
    });

    return {present: existing, absent: notExisting};
  });

  return p;
}

function slurp (filenames) {
  var files = {};
  filenames.forEach(function(file) {
    var raw = fs.readFileSync(file);
    var data = JSON.parse(raw);
    files[data.workerType] = data;
  });
  return files;
}

function writeWorkerTypes(workerTypes) {
  return Promise.all(workerTypes.map(function(name) {
    return client.workerType(name);
  })).then(function(res) {
    res.forEach(function(worker) {
      var filename = worker.workerType + '.json';
      fs.writeFileSync(filename.replace(' ', '_'), worker);
    });
    console.log('Fetched and wrote workerTypes');
  });
}

switch(action) {
  case 'list':
    client.listWorkerTypes().then(function(workerTypes) {
      if (workerTypes.length > 0) {
        console.log('The system knows the following workertypes:');
        workerTypes.forEach(function(name) {
          console.log('  * %s', name);
        });
      } else {
        console.log('There are no worker types');
      }
    }).done();
    break;
  case 'create':
    var files = slurp(names);
    var workerTypeNames = [];
    Object.keys(files).forEach(function(workerType) {
      workerTypeNames.push(files[workerType].workerType);
    });

    var p = classifyNames(workerTypeNames);

    p = p.then(function(classified) {
      var promises = [];
      classified.present.forEach(function(name) {
        delete files[name]['workerType'];
        promises.push(client.updateWorkerType(name, files[name])); 
      });
      classified.absent.forEach(function(name) {
        delete files[name]['workerType'];
        promises.push(client.createWorkerType(name, files[name]));
      });

      return Promise.all(promises);
    });

    p = p.then(function() {
      console.log('Finished inserting or updating');
    });

    p.done();

    break;
  case 'delete':
  case 'remove':
    var workerTypes;
    var p = classifyNames(names);

    p = p.then(function (workerTypes_) {
      workerTypes = workerTypes_;
      return Promise.all(workerTypes.present.map(function(workerType) {
        return client.removeWorkerType(workerType);
      }))
    });

    p = p.then(function(outcome) {
      if (workerTypes.absent.length > 0) {
        console.log('These workerTypes were not found and ignored: ' + JSON.stringify(workerTypes.absent));
      }
      if (workerTypes.present.length > 0) {
        console.log('These workerTypes were found and deleted ' + JSON.stringify(workerTypes.present));
      }
    });

    p.done();
    break;
  case 'fetchall':
    client.listWorkerTypes().then(function(names) {
      return writeWorkerTypes(names);
    }).done();
    break;
  case 'fetch':
    writeWorkerTypes(names).catch(function() {
      console.error('Error!');
    }).done();
    break;
  default:
    console.error('You must specify a supported action');
    process.exit(1);
}

