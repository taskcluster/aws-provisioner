#!/usr/bin/env node
'use strict';
process.env.DEBUG = '';

var fs = require('fs');
var base = require('taskcluster-base');
var tc = require('taskcluster-client');
var api = require('../routes/v1');
var Promise = require('promise');
var program = require('commander');
var pkgData = require('../package.json');

function errorHandler(err) {
  console.log(JSON.stringify({
    outcome: 'failure',
    err: err,
    stack: err.stack || 'no-stack',
  }, null, 2));

  // This is pretty ugly...
  throw err;
}


function classifyNames(client, names) {
  var p = client.listWorkerTypes();

  p = p.then(function(listing) {
    var existing = names.filter(function(name) {
      return listing.indexOf(name) !== -1;
    });

    var notExisting = names.filter(function(name) {
      return listing.indexOf(name) === -1;
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


function writeWorkerTypes(client, workerTypes) {
  var p = Promise.all(workerTypes.map(function(name) {
    return client.workerType(name);
  }));

  p = p.then(function(res) {
    var filenames = [];
    res.forEach(function(worker) {
      var filename = worker.workerType + '.json';
      filenames.push(filename);
      fs.writeFileSync(filename.replace(' ', '_'), JSON.stringify(worker, null, 2));
    });

    return filenames;
  });

  return p;
}


function createClient() {
  var references = api.reference({baseUrl: program.url});
  var AwsProvisioner = tc.createClient(references);
  return new AwsProvisioner();
}


program
  .version(pkgData.version || 'unknown')
  .description('Perform various management tasks for the Taskcluster AWS Provisioner')
  .option('-u, --url [url]', 'URL for the API to work against', 'http://localhost:5557/v1');
  //.option('-u, --url [url]', 'URL for the API to work against', 'https://taskcluster-aws-provisioner2.herokuapp.com/v1');


program
  .command('help')
  .description('Show help')
  .action(function() {
    program.help();
  });


program
  .command('list')
  .description('list worker types known to the host')
  .action(function() {
    var p = createClient().listWorkerTypes();

    p = p.then(function(workerTypes) {
      if (workerTypes.length > 0) {
        console.log(JSON.stringify(workerTypes, null, 2));
      } else {
        console.log('[]');
      }
    });

    p = p.catch(errorHandler);
  });


program
  .command('create <files...>')
  .description('Create a workerType based on these files')
  .action(function(filenames) {
    var files = slurp(filenames);
    var workerTypeNames = [];

    Object.keys(files).forEach(function(workerType) {
      workerTypeNames.push(files[workerType].workerType);
    });

    var client = createClient();

    var p = classifyNames(client, workerTypeNames);

    p = p.then(function(classified) {
      var promises = [];

      classified.present.forEach(function(name) {
        delete files[name].workerType;
        promises.push(client.updateWorkerType(name, files[name]));
      });

      classified.absent.forEach(function(name) {
        delete files[name].workerType;
        promises.push(client.createWorkerType(name, files[name]));
      });

      return Promise.all(promises);
    });

    p = p.then(function() {
      console.log(JSON.stringify({
        outcome: 'success',
        created: workerTypeNames,
      }, null, 2));
    });

    p = p.catch(errorHandler);
  });


program
  .command('delete <workerTypes...>')
  .description('delete listed worker types')
  .action(function(workerTypeNames) {
    var workerTypes;
    var client = createClient();

    var p = classifyNames(client, workerTypeNames);

    p = p.then(function (workerTypes_) {
      workerTypes = workerTypes_;
      return Promise.all(workerTypes.present.map(function(workerType) {
        return client.removeWorkerType(workerType);
      }));
    });

    p = p.then(function() {
      console.log(JSON.stringify({
        outcome: 'success',
        deleted: workerTypes.present || [],
        absent: workerTypes.absent || [],
      }, null, 2));
    });

    p = p.catch(errorHandler);
  });


program
  .command('delete-all')
  .description('Delete all workerTypes')
  .action(function() {
    var client = createClient();
    var workerTypeNames;

    var p = client.listWorkerTypes();

    p = p.then(function(workerTypes) {
      workerTypeNames = workerTypes;
      return Promise.all(workerTypes.map(function(workerType) {
        return client.removeWorkerType(workerType);
      }));
    });

    p = p.then(function() {
      console.log(JSON.stringify({
        outcome: 'success',
        deleted: workerTypeNames,
      }, null, 2));
    });

    p = p.catch(errorHandler);
  });


program
  .command('fetch-all')
  .description('Fetch all workerTypes')
  .action(function() {
    var client = createClient();

    var p = client.listWorkerTypes();

    p = p.then(function(names) {
      return writeWorkerTypes(client, names);
    });

    p = p.then(function(filenames) {
      console.log(JSON.stringify({
        outcome: 'success',
        wrote: filenames,
      }, null, 2));
    });

    p = p.catch(errorHandler);
  });


program
  .command('show <workerType>')
  .description('print specified workerType to screen')
  .action(function(workerType) {
    var client = createClient();

    var p = client.workerType(workerType);

    p = p.then(function(worker) {
      console.log(JSON.stringify(worker, null, 2));
    });

    p = p.catch(errorHandler);
  });


program
  .command('preview-launch-specs <workerType>')
  .description('print specified workerTypes to screen')
  .action(function(workerType) {
    var client = createClient();

    var p = client.getLaunchSpecs(workerType);

    p = p.then(function(specs) {
      console.log(JSON.stringify(specs, null, 2));
    });

    p = p.catch(errorHandler);
  });


program
  .command('fetch <workerTypes...>')
  .description('fetch specified workerTypes')
  .action(function(workerTypes) {
    var client = createClient();

    var p = writeWorkerTypes(client, workerTypes);

    p = p.then(function(filenames) {
      console.log(JSON.stringify({
        outcome: 'success',
        wrote: filenames,
      }, null, 2));
    });

    p = p.catch(errorHandler);
  });


program
  .command('all-stop')
  .description('Kill everything managed by this provisioner on aws')
  .action(function() {
    var client = createClient();

    var p = client.shutdownEverySingleEc2InstanceManagedByThisProvisioner();

    p = p.then(function() {
      console.log('{"outcome": "success"}');
    });

    p = p.catch(errorHandler);
  });


program
  .command('setup-table')
  .option('--config <config>', 'Configuration file to use', 'development')
  .description('Assert that this provisioner has a table')
  .action(function(conf) {
    var cfg = base.config({
      defaults: require('../config/defaults.js'),
      profile: require('../config/' + conf.config),
      envs: [
        'provisioner_workerTypeTableName',
        'azure_accountName',
      ],
      filename: 'taskcluster-aws-provisioner',
    });

    var accountName = cfg.get('azure:accountName');
    var tableName = cfg.get('provisioner:workerTypeTableName');

    var auth = new tc.Auth();

    var p = auth.azureTableSAS(accountName, tableName);

    p = p.then(function(outcome) {
      console.log(JSON.stringify({
        outcome: 'success',
        sas: outcome,
        tableName: tableName,
      }, null, 2));
    });

    p = p.catch(errorHandler);

  });


program.parse(process.argv);


if (!program.args.length) {
  program.help();
}
