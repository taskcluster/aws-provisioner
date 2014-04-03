TaskCluster AWS Provisioner
============================
This repository contains a EC2 instance provisioner for a TaskCluster instance.
For the time being it has a focus on submitting and canceling spot instance
requests, as well as terminating instance should be create too many.
This server basically monitors the number of pending tasks, running instances
and pending spot requests, then submits, cancels or terminates AWS resources
according to the configuration. Initial implementation is quite naive.

Quick Start
-----------
  1. Install dependencies `npm install`,
  2. Configure AWS with `node utils/setup-aws.js`, this will create a local
     config file.
  2. Configure the server (see `config.js`),
  3. Run the server with `node server.js`
  4. Cleanup AWS with `node utils/cleanup-aws.js`.


AWS Configuration and Clean-up
------------------------------
This provisioner relies on a special key-name to find and identify spot requests
and instances managed by this provisioner. Consequently, if other processes or
**people** creates spot request or EC2 instances with this special key-name,
then behavior is undefined.

The special key-name is configured in any config-file read by `nconf`, see
`config.js` for where these can be put. The utility `utils/setup-aws.js` will
create a unique key-name and save it in a local config file. The utility
`utils/cleanup-aws.js` will delete all AWS resources associated with the
key-name and delete the key-name from local config file.

For testing purposes, run `utils/setup-aws.js` to create a key-name and when
testing is done clean up with `utils/cleanup-aws.js`. In production, it's
recommended that a special key-name in constructed and configured manually.

Expected Queue Interface
------------------------
The provisioner expects that it is able query the queue for pending jobs. These
jobs are returned a JSON list of JSON task objects. The URL for this request is 
`http://<queue:host>:<queue:port>/<queue:version>/jobs?state=PENDING`, where
all bracket encapsulated variables referes to configuration keys, see
`config.js` for default configuration.

IAM Role Policy
---------------
In order to allow the provisioner to launch instances, kill them and assign
IAM roles, the following profile is useful. As we continue development, we might
want to restrict it even further. Whether or not `iam::ListInstanceProfiles` is
still to be determined.

```js
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect":"Allow",
      "Action":"iam:PassRole",
      "Resource":"*"
    },
    {
      "Effect":"Allow",
      "Action":"iam:ListInstanceProfiles",
      "Resource":"*"
    },
    {
      "Effect":"Allow",
      "Action":"ec2:*",
      "Resource":"*"
    }
  ]
}
```

Third-Party Libraries and Tools
-------------------------------
The TaskCluster AWS Provisioner wouldn't have been so awesome without the
without these amazing libraries and tools, upon which it is built.

**Libraries**,

 * Files in `ace/` are from [Ace](http://ace.c9.io/) is licensed under the
   BSD license.
 * Files in `bootstrap/` from [Bootstrap](http://getbootstrap.com/) is licensed
   under the MIT license.
 * `prism.js` and `prism.css` from [PRISM](http://prismjs.com/) is licensed
   under the MIT license.

