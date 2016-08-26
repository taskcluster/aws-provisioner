TaskCluster AWS Provisioner
===========================

[![Build Status](https://travis-ci.org/taskcluster/aws-provisioner.svg?branch=master)](https://travis-ci.org/taskcluster/taskcluster-aws-provisioner)
*NOTE* Travis being green does not mean that we're good to deploy to production!

The AWS Provisioner is responsible for starting Amazon EC2 instances to perform
tasks in the TaskCluster queue.  It monitors queue lengths and uses spot
bidding to maximize the cost-effectiveness of its resources.

Hacking AWS Provisioner
-----------------------

You will need Node 4 to run the AWS provisioner.  With this in place, a simple
`npm install` should fetch the prerequisites.

### Testing

To test, you will need a set of credentials.  The best way to find these is to
ask another developer for a copy of theirs.  The configuration should look
something like that in ``user-config-example.yml``.

You can create your own `pulse` credentials at https://pulseguardian.mozilla.org.
You'll need to get the Azure configuration from another TaskCluster developer.
The AWS user can be found in the shared notes in Lastpass.

The unit test suite only covers the API of the provisioner.  Changes to the
backend require manual testing.  Do not take travis status to mean that changes
are working.

### Running Locally

To run the provisioner locally, you will need a similar set of configuration.
Then run

npm run compile && NODE_ENV=development DEBUG=* node lib/main.js server # just web server
npm run compile && NODE_ENV=development DEBUG=* node lib/main.js all    # web + provisioner
```

Note that this is not usually the best way to test the provisioner.  Be careful
that you manually destroy any resources the provisioner creates while it is
running (EC2 instances, spot bids, and SSH keypairs).

Deploying AWS Provisioner
-------------------------

This app is part of the 'provisioner' pipeline.


Post Deployment Verification
---------------------------

The provisioner is deployed on heroku as a worker process and a web process.  A
deployment of the provisioner is made by pushing a commit to the master branch,
either through the command line or through merging a pull request.  Before
doing a deployment, you should run the unit tests locally.

Once the deployment is made, you should use the `heroku logs -t` command to
verify that no exceptions are being thrown and that a complete provisioning
iteration happens.  If the deployment is about adding a new feature or
correcting a bug, it would be a good idea to ensure that logging messages
confirm the fix.

The unit test suite in the provisioner is limited to the web component.  The
EC2 api's eventual consistency as well as it taking sometimes more than 20
minutes to launch an instance mean that integration tests for the EC2
interactions are not very feasible.
