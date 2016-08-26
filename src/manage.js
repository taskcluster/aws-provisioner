#!/usr/bin/env babel-node
process.env.DEBUG = '';

let fs = require('fs');
let path = require('path');
let tc = require('taskcluster-client');
let program = require('commander');
let pkgData = require('../package.json');
let _ = require('lodash');

let canGenerateReference = false;
let api;
let Config;
try {
  api = require('../lib/api-v1');
  Config = require('typed-env-config');
  canGenerateReference = true;
} catch (err) { }

const localhostAddress = 'http://localhost:5557/v1';
const realBaseAddress = 'https://aws-provisioner.taskcluster.net/v1';
const stagingBaseAddress = 'https://provisioner-staging.herokuapp.com/v1';

function errorHandler(err) {
  console.log(JSON.stringify({
    outcome: 'failure',
    err: err,
    stack: err.stack || 'no-stack',
  }, null, 2));
  throw err;
  process.exit(1);
}

async function writeWorkerTypes(client, workerTypes) {
  if (!fs.existsSync('workers')) {
    fs.mkdirSync('workers');
  }

  let workers = await Promise.all(workerTypes.map(async name => {
    return client.workerType(name);
  }));

  let filenames = [];

  for (let worker of workers) {
    let filename = path.join('workers', worker.workerType + '.json');
    if (!fs.existsSync(filename)) {
      fs.writeFileSync(filename.replace(' ', '_'), JSON.stringify(worker, null, 2));
      filenames.push(filename);
    } else {
      throw new Error('refusing to overwrite ' + filename);
    }
  }

  return filenames;
}

function createClient() {
  var url = program.url;

  var shouldGenerateReference = false;
  if (canGenerateReference && !program.forceReleasedApi) {
    shouldGenerateReference = true;
  }

  if (program.localhost && program.production || program.localhost && program.staging) {
    console.log('--localhost, --staging and --production are mutually exclusive');
    throw new Error('Invalid environment flags provided');
  }
  
  if (program.localhost) {
    url = localhostAddress;
  } else if (program.production) {
    url = realBaseAddress;
  } else if (program.staging) {
    url = stagingBaseAddress;
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
  .option('--staging', 'Force URL' + stagingBaseAddress)
  .option('--force-released-api', 'Force usage of the API reference in taskcluster-client');

program
  .command('help')
  .description('Show help')
  .action(function() {
    program.help();
  });

program
  .command('list')
  .description('list worker types known to the host')
  .action(async () => {
    try {
      let client = createClient();
      let workerTypes = await client.listWorkerTypes();
      console.log(JSON.stringify({
        outcome: 'success',
        workerTypes: workerTypes || [],
      }, null, 2));
    } catch (err) {
      errorHandler(err);
    }
  });

program
  .command('create <files...>')
  .description('Create a workerType based on these files')
  .action(async filenames => {
    try {
      let created = [];
      let updated = [];
      let client = createClient();

      let existingWorkerTypes = await client.listWorkerTypes();

      await Promise.all(filenames.map(async filename => {
        let worker = JSON.parse(fs.readFileSync(filename));
        let name = worker.workerType;

        // These properties cannot be set in the create/update but is always
        // returned in gets.  The `input.workerType` is special beacuse it's
        // what this tool operates on to avoid parsing file names to determine
        // workerType
        delete worker.lastModified;
        delete worker.workerType;

        if (_.includes(existingWorkerTypes, worker.workerType)) {
          // Update
          await client.updateWorkerType(name, worker);
          created.push(name);
        } else {
          // Create
          await client.createWorkerType(name, worker);
          updated.push(name);
        }
      }));

      console.log(JSON.stringify({
        outcome: 'success',
        created,
        updated,
      }, null, 2));

    } catch (err) {
      errorHandler(err);
    }
  });

program
  .command('modify-all <nodeModule>')
  .description('modify all server-side worker types using the function exported by the nodeModule')
  .action(async nodeModule => {
    try {
      let modifier = require(nodeModule);
      let client = createClient();
      let modified = [];
      let unmodified = [];

      let workerTypes = await client.listWorkerTypes();

      await Promise.all(workerTypes.map(async name => {
        let worker = await client.workerType(name);
        delete worker.workerType;
        delete worker.lastModified;

        let modified = modifier(_.cloneDeep(worker));

        if (_.isEqual(modified, worker)) {
          unmodified.push(name);
        } else {
          await client.updateWorkerType(name, modified);
          modified.push(name);
        }
        console.log(JSON.stringify({
          outcome: 'success',
          modified,
          unmodified,
        }, null, 2));
      }));
    } catch (err) {
      errorHandler(err);
    }
  });

program
  .command('modify <nodeModule> <workerTypes...>')
  .description('modify specified server-side worker types using the function exported by the nodeModule')
  .action(async (nodeModule, workerTypes) => {
    try {
      let modifier = require(nodeModule);
      let client = createClient();
      let modifiedwt = [];
      let unmodified = [];
      let missing = [];

      await Promise.all(workerTypes.map(async name => {
        let worker = await client.workerType(name);
        delete worker.workerType;
        delete worker.lastModified;

        let modified = modifier(_.cloneDeep(worker));

        if (_.isEqual(modified, worker)) {
          unmodified.push(name);
        } else {
          modified.workerType = name;
          await client.updateWorkerType(name, modified);
          modifiedwt.push(name);
        }
        console.log(JSON.stringify({
          outcome: 'success',
          modified: modifiedwt,
          unmodified,
        }, null, 2));
      }));
    } catch (err) {
      errorHandler(err);
    }
  });

program
  .command('modify-file <nodeModule> <filenames...>')
  .description('modify specified local worker types using the function exported by the nodeModule')
  .action(async (nodeModule, filenames) => {
    try {
      let modifier = require(nodeModule);
      let modifiedwt = [];
      let unmodified = [];

      for (let filename of filenames) {
        let worker = JSON.parse(fs.readFileSync(filename));
        let name = worker.workerType;
        delete worker.workerType;
        delete worker.lastModified;

        let modified = modifier(_.cloneDeep(worker));

        if (_.isEqual(modified, worker)) {
          unmodified.push({name, src: filename});
        } else {
          modified.workerType = name;
          modifiedwt.push({name, src: filename, dst: filename + '_modified'});
          fs.writeFileSync(filename + '_modified', JSON.stringify(modified, null, 2));
        }
      }

      console.log(JSON.stringify({
        outcome: 'success',
        modified: modifiedwt,
        unmodified,
      }, null, 2));
    } catch (err) {
      errorHandler(err);
    }

    var modifier = require(nodeModule);
    filenames.forEach(function(filename) {
      var original = JSON.parse(fs.readFileSync(filename));
      var modified = modifier(original);
      fs.writeFileSync(filename + '_modified', JSON.stringify(modified, null, 2));
    });
  });

program
  .command('delete <workerTypes...>')
  .description('delete listed worker types')
  .action(async workerTypeNames => {
    try {
      let client = createClient();
      let workerTypes = await client.listWorkerTypes();
      let absent = [];
      let deleted = [];
      await Promise.all(workerTypes.map(async name => {
        if (_.includes(workerTypeNames, name)) {
          await client.removeWorkerType(name);
          deleted.push(name);
        } else {
          absent.push(name);
        }
      }));
      console.log(JSON.stringify({
        outcome: 'success',
        deleted: deleted,
        absent: absent,
      }, null, 2));
    } catch (err) {
      errorHandler(err);
    }
  });

program
  .command('delete-all')
  .description('Delete all workerTypes')
  .action(async () => {
    try {
      let client = createClient();
      let workerTypes = await client.listWorkerTypes();
      let deleted = [];
      await Promise.all(workerTypes.map(async name => {
        await client.removeWorkerType(name);
        deleted.push(name);
      }));
      console.log(JSON.stringify({
        outcome: 'success',
        deleted: deleted,
      }, null, 2));
    } catch (err) {
      errorHandler(err);
    }
  });

program
  .command('fetch-all')
  .description('Fetch all workerTypes')
  .action(async () => {
    try {
      let client = createClient();
      let workerTypes = await client.listWorkerTypes();
      let fetched = [];
      await Promise.all(workerTypes.map(async name => {
        let worker = await client.workerType(name);
        fs.writeFileSync(name + '.json', JSON.stringify(worker, null, 2));
        fetched.push({name, dst: name + '.json'});
      }));
      console.log(JSON.stringify({
        outcome: 'success',
        fetched: fetched,
      }, null, 2));
    } catch (err) {
      errorHandler(err);
    }
  });

program
  .command('fetch <workerTypeNames...>')
  .description('fetch specified workerTypes')
  .action(async workerTypeNames => {
    try {
      let client = createClient();
      let fetched = [];
      await Promise.all(workerTypeNames.map(async name => {
        let worker = await client.workerType(name);
        fs.writeFileSync(name + '.json', JSON.stringify(worker, null, 2));
        fetched.push({name, dst: name + '.json'});
      }));
      console.log(JSON.stringify({
        outcome: 'success',
        fetched: fetched,
      }, null, 2));
    } catch (err) {
      errorHandler(err);
    }
  });

program
  .command('show <workerType>')
  .description('print specified workerType to screen')
  .action(async workerType => {
    try {
      let client = createClient();
      let worker = await client.workerType(workerType);
      console.log(JSON.stringify(worker, null, 2)); 
    } catch (err) {
      errorHandler(err);
    }
  });

program
  .command('preview-launch-specs <workerType>')
  .description('print specified workerTypes to screen')
  .action(async workerType => {
    try {
      let client = createClient();
      let specs = await client.getLaunchSpecs(workerType);
      console.log(JSON.stringify(specs, null, 2));
    } catch (err) {
      errorHandler(err);
    }
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
