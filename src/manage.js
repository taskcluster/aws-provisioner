#!/usr/bin/env babel-node
process.env.DEBUG = '';

var fs = require('fs');
var path = require('path');
var tc = require('taskcluster-client');
var program = require('commander');
var pkgData = require('../package.json');

var canGenerateReference = false;
try {
  var api = require('../lib/api-v1');
  var Config = require('typed-env-config');
  canGenerateReference = true;
} catch (err) { }

var localhostAddress = 'http://localhost:5557/v1';
var realBaseAddress = 'https://aws-provisioner.taskcluster.net/v1';

function errorHandler (err) {
  console.log(JSON.stringify({
    outcome: 'failure',
    err: err,
    stack: err.stack || 'no-stack',
  }, null, 2));
  throw err;
}

function classifyNames (client, names) {
  var p = client.listWorkerTypes();

  p = p.then(function (listing) {
    var existing = names.filter(function (name) {
      return listing.indexOf(name) !== -1;
    });

    var notExisting = names.filter(function (name) {
      return listing.indexOf(name) === -1;
    });

    return {present: existing, absent: notExisting};
  });

  return p;
}

function slurp (filenames) {
  var files = {};
  filenames.forEach(function (file) {
    var raw = fs.readFileSync(file);
    var data = JSON.parse(raw);
    files[data.workerType] = data;
  });
  return files;
}

function writeWorkerTypes (client, workerTypes) {
  if (!fs.existsSync('workers')) {
    fs.mkdirSync('workers');
  }

  var p = Promise.all(workerTypes.map(function (name) {
    return client.workerType(name);
  }));

  p = p.then(function (res) {
    var filenames = [];
    res.forEach(function (worker) {
      var filename = path.join('workers', worker.workerType + '.json');
      filenames.push(filename);
      if (!fs.existsSync(filename)) {
        fs.writeFileSync(filename.replace(' ', '_'), JSON.stringify(worker, null, 2));
      } else {
        throw new Error('refusing to overwrite ' + filename);
      }
    });

    return filenames;
  });

  return p;
}

function createClient () {
  var url = program.url;

  var shouldGenerateReference = false;
  if (canGenerateReference && !program.forceReleasedApi) {
    shouldGenerateReference = true;
  }

  if (program.localhost && program.production) {
    console.log('--localhost and --production are mutually exclusive');
  } else if (program.localhost) {
    url = localhostAddress;
  } else if (program.production) {
    url = realBaseAddress;
  }

  if (shouldGenerateReference) {
    var references = api.reference({baseUrl: url});
    var AwsProvisioner = tc.createClient(references);
    return new AwsProvisioner();
  } else {
    return new tc.AwsProvisioner({baseUrl: url});
  }
}

program
  .version(pkgData.version || 'unknown')
  .description('Perform various management tasks for the Taskcluster AWS Provisioner')
  .option('-u, --url [url]', 'Use arbitrary URL', 'http://localhost:5557/v1')
  .option('--localhost', 'Force URL' + localhostAddress)
  .option('--production', 'Force URL' + realBaseAddress)
  .option('--force-released-api', 'Force usage of the API reference in taskcluster-client');

program
  .command('help')
  .description('Show help')
  .action(function () {
    program.help();
  });

program
  .command('list')
  .description('list worker types known to the host')
  .action(function () {
    var p = createClient().listWorkerTypes();

    p = p.then(function (workerTypes) {
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
  .action(function (filenames) {
    var files = slurp(filenames);
    var workerTypeNames = [];

    Object.keys(files).forEach(function (workerType) {
      workerTypeNames.push(files[workerType].workerType);
    });

    var client = createClient();

    var p = classifyNames(client, workerTypeNames);

    p = p.then(function (classified) {
      var promises = [];

      classified.present.forEach(function (name) {
        delete files[name].workerType;
        promises.push(client.updateWorkerType(name, files[name]));
      });

      classified.absent.forEach(function (name) {
        delete files[name].workerType;
        promises.push(client.createWorkerType(name, files[name]));
      });

      return Promise.all(promises);
    });

    p = p.then(function () {
      console.log(JSON.stringify({
        outcome: 'success',
        created: workerTypeNames,
      }, null, 2));
    });

    p = p.catch(errorHandler);
  });

program
  .command('modify-all <nodeModule>')
  .description('modify all server-side worker types using the function exported by the nodeModule')
  .action(function (nodeModule) {
    var modifier = require(nodeModule);
    var client = createClient();

    var r = client.listWorkerTypes();

    r = r.then(function (workers) {
      return Promise.all(workers.map(function (workerTypeName) {
        var p = client.workerType(workerTypeName);

        p = p.then(function (workerType) {
          var modified = modifier(workerType);
          delete modified.lastModified;
          delete modified.workerType;
          return modified;
        });

        p = p.then(function (workerType) {
          return client.updateWorkerType(workerTypeName, workerType);
        });

        return p;
      }));
    });

    r.done();
  });

program
  .command('modify <nodeModule> <workerTypes...>')
  .description('modify specified server-side worker types using the function exported by the nodeModule')
  .action(function (nodeModule, workerTypes) {
    var modifier = require(nodeModule);
    var client = createClient();

    Promise.all(workerTypes.map(function (workerTypeName) {
      var p = client.workerType(workerTypeName);

      p = p.then(function (workerType) {
        var modified = modifier(workerType);
        delete modified.lastModified;
        delete modified.workerType;
        return modified;
      });

      p = p.then(function (workerType) {
        return client.updateWorkerType(workerTypeName, workerType);
      });

      return p;

    })).done();
  });

program
  .command('modify-file <nodeModule> <filenames...>')
  .description('modify specified local worker types using the function exported by the nodeModule')
  .action(function (nodeModule, filenames) {
    var modifier = require(nodeModule);
    filenames.forEach(function (filename) {
      var original = JSON.parse(fs.readFileSync(filename));
      var modified = modifier(original);
      fs.writeFileSync(filename + '_modified', JSON.stringify(modified, null, 2));
    });
  });

program
  .command('delete <workerTypes...>')
  .description('delete listed worker types')
  .action(function (workerTypeNames) {
    var workerTypes;
    var client = createClient();

    var p = classifyNames(client, workerTypeNames);

    p = p.then(function (workerTypes_) {
      workerTypes = workerTypes_;
      return Promise.all(workerTypes.present.map(function (workerType) {
        return client.removeWorkerType(workerType);
      }));
    });

    p = p.then(function () {
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
  .action(function () {
    var client = createClient();
    var workerTypeNames;

    var p = client.listWorkerTypes();

    p = p.then(function (workerTypes) {
      workerTypeNames = workerTypes;
      return Promise.all(workerTypes.map(function (workerType) {
        return client.removeWorkerType(workerType);
      }));
    });

    p = p.then(function () {
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
  .action(function () {
    var client = createClient();

    var p = client.listWorkerTypes();

    p = p.then(function (names) {
      return writeWorkerTypes(client, names);
    });

    p = p.then(function (filenames) {
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
  .action(function (workerType) {
    var client = createClient();

    var p = client.workerType(workerType);

    p = p.then(function (worker) {
      console.log(JSON.stringify(worker, null, 2));
    });

    p = p.catch(errorHandler);
  });

program
  .command('preview-launch-specs <workerType>')
  .description('print specified workerTypes to screen')
  .action(function (workerType) {
    var client = createClient();

    var p = client.getLaunchSpecs(workerType);

    p = p.then(function (specs) {
      console.log(JSON.stringify(specs, null, 2));
    });

    p = p.catch(errorHandler);
  });

program
  .command('fetch <workerTypes...>')
  .description('fetch specified workerTypes')
  .action(function (workerTypes) {
    var client = createClient();

    var p = writeWorkerTypes(client, workerTypes);

    p = p.then(function (filenames) {
      console.log(JSON.stringify({
        outcome: 'success',
        wrote: filenames,
      }, null, 2));
    });

    p = p.catch(errorHandler);
  });

program
  .command('setup-table')
  .option('--config <config>', 'Configuration file to use', 'development')
  .description('Assert that this provisioner has a table')
  .action(function (conf) {
    var config = Config();

    var accountName = config.azure.accountName;
    var tableName = config.app.workerTypeTableName;
    var secretTable = config.app.secretTableName;
    var workerStateTable = config.app.workerStateTableName;

    var auth = new tc.Auth();

    var p = Promise.all([
      auth.azureTableSAS(accountName, tableName),
      auth.azureTableSAS(accountName, secretTable),
      auth.azureTableSAS(accountName, workerStateTable),
    ]);

    p = p.then(function () {
      console.log(JSON.stringify({
        outcome: 'success',
        tableName: tableName,
        secretTable: secretTable,
        workerStateTable: workerStateTable,
      }, null, 2));
    });

    p = p.catch(errorHandler);

  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
