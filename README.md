TaskCluster AWS Provisioner
===========================

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
something like this:

```
{
  "aws": {
    "accessKeyId": "fake",
    "secretAccessKey": "fake"
  },
  "pulse": {
    "username": "...",
    "password": "..."
  },
  "azure": {
    "accountName":        "taskclusterdev",
    "accountKey":         "..."
  }
}
```

The `aws` configuration must be present, but its value is ignored.  You can
create your own `pulse` credentials at https://pulseguardian.mozilla.org.
You'll need to get the Azure configuration from another TaskCluster developer.

### Running Locally

To run the provisioner locally, you will need a similar set of configuration.
Then run

```
npm compile && DEBUG=* node lib/server.js development
```

Note that this is not usually the best way to test the provisioner.  Be careful
that you manually destroy any resources the provisioner creates while it is
running (EC2 instances, spot bids, and SSH keypairs).

Deploying AWS Provisioner
-------------------------

AWS provisioner is automatically deployed on push to master, without waiting for CI to pass.
