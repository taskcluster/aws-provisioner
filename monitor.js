let stats = require('taskcluster-lib-stats');
let config = require('taskcluster-lib-config');
let WatchDog = require('./lib/watchdog');
let profile = process.argv[2];
let postmark = require('postmark')(process.env.POSTMARK_API_TOKEN);
let irc = require('irc');

let ircClient = new irc.Client('irc.mozilla.org', 'provisioneralerts', {
  channels: ['#taskclusteralerts'],
  autoConnect: false,
});

let cfg = config({
  defaults: require('./config/defaults'),
  profile: require('./config/' + profile),
  envs: [
    'influx_connectionString',
  ],
  filename: 'taskcluster-aws-provisioner',
});

let influx = new stats.Influx({
  connectionString: cfg.get('influx:connectionString'),
  maxDelay: 100,
  maxPendingPoints: 100,
});


// Wouldn't it suck if our monitoring script itself froze!
let watchDog = new WatchDog(1000);

function doAlert(cb) {
  let body = [
    'Alert!\n',
    '=============================\n',
    `There hasn't been a provisioning iteration in at least 5 minutes`,
  ];

  try {
    ircClient.say('#taskclusteralerts', `provisioner has not iterated in over 5 minutes`);
    body.push('\n  * sent irc message to #taskclusteralerts');
  } catch (err) {
    console.log(err.stack || err);
    body.push('\n  * failed to send an irc message');
  }
  let email = {
    // TODO: use the tools-taskcluster email when it's confirmed
    From: 'taskcluster-alerts@mozilla.com',
    To: 'jhford@mozilla.com',
    Subject: `Provisioner Alert!  No iteration for >5m`,
    TextBody: body.join(''),
    Tag: 'tc-alert',
  };
  postmark.send(email, function (err, s) {
    if (err) {
      console.log(err.stack || err);
      return cb(err);
    }
    console.log('Email sent!');
    return cb();
  });
}

function imcrashing() {
  try {
    ircClient.say('#taskclusteralerts', `provisioner monitor crashing!`);
  } catch (err) {
    console.log(err.stack || err);
  }
  let email = {
    // TODO: use the tools-taskcluster email when it's confirmed
    From: 'taskcluster-alerts@mozilla.com',
    To: 'jhford@mozilla.com',
    Subject: `Provisioner monitor crashed`,
    TextBody: body.join(''),
    Tag: 'tc-alert',
  };
  postmark.send(email, function (err, s) {
    if (err) {
      console.log(err.stack || err);
      return cb(err);
    }
    console.log('Email sent!');
    return cb();
  });

}

async function oogyboogy() {
  watchDog.touch();
  console.log('What\'s happening?');

 // let query = 'select time from AwsProvisioner.ProvisioningIteration where workerType = \'gecko-decision\' and provisionerId = \'aws-provisioner-v1\' limit 1';
  let query = "select count(provisionerId) from AwsProvisioner.ProvisioningIteration where time > now() - 5m and provisionerId = 'aws-provisioner-v1' and workerType = 'gecko-decision'";
  console.log('Running query ' + query);

  let attempts = 0;

  while (attempts < 5) {
    try {
      res = await influx.query(query);
      console.log('query done');
      let now = new Date();
      let count = res[0].points[0][1];

      if (count < 1) {
        console.log('Gosh golly');
        doAlert(() => { });
      } else {
        console.log('No provisioning iterations in 5m!');
      }
      setTimeout(oogyboogy, 1000 * 30);
      // let's be double sure that we exit this loop.
      attempts = 10000;
      break;
    } catch (err) {
      attempts++;
    }
  }
}


ircClient.on('error', err => {
  console.log('irc error');
  console.log(err.stack || err);
  process.exit(1);
});

//oogyboogy();
ircClient.connect(err => {
  watchDog.start();
  if (err) {
    console.log(err.stack || err);
  }
  console.log('irc connected');
  ircClient.join('#taskclusteralerts', err => {
    if (err) {
      console.log(err.stack || err);
    }
    console.log('irc channel joined');
    oogyboogy();
  });
});
