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

Deployment Setup
----------------

  1. [Install node.js](https://github.com/joyent/node/wiki/Installing-Node.js-via-package-manager#wiki-build-from-source)
  2. Install packages `sudo apt-get install build-essential python-pip git`
  3. Clone [github-auto-deploy](https://github.com/logsol/Github-Auto-Deploy/) `git clone https://github.com/logsol/Github-Auto-Deploy.git`.
  4. Clone the provisioner `git clone https://github.com/taskcluster/aws-provisioner.git`
  5. Create upstart script for Github-Auto-Deploy in `/etc/init/github-auto-deploy.conf`:

    #!upstart
    description   "Github Auto Deploy"
    author        "Jonas Finnemann Jensen <jopsen@gmail.com>"

    setuid ubuntu

    stop on shutdown

    script
      cd /home/ubuntu/Github-Auto-Deploy/;
      exec bash --login -c 'python GitAutoDeploy.py';
    end script

  6. Create upstart script for aws-provisioner in `/etc/init/taskcluster-aws-provisioner.conf`:

    #!upstart
    description   "TaskCluster AWS Provisioner"
    author        "Jonas Finnemann Jensen <jopsen@gmail.com>"

    setuid ubuntu

    stop on shutdown

    script
      cd /home/ubuntu/aws-provisioner/;
      exec bash --login -c 'forever --minUptime 5000 --spinSleepTime 10000 server.js';
    end script

  7. Setup iptables to forward port 80:

    iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 3001
    iptables -t nat -I OUTPUT -p tcp -d 127.0.0.1 --dport 80 -j REDIRECT --to-ports 3001

  8. Write config file to `/etc/taskcluster-aws-provisioner.conf.json`
    ```js
    {
      "server": {
        "hostname":         "aws-provisioner.taskcluster.net",
        "port":             3001,
        "cookie-secret":    "Ha, ha, as if I'm going to tell you!"
      },
      "queue": {
        "host":             "queue.taskcluster.net",
        "port":             80,
        "version":          "v1"
      },
      "provisioning": {
        "provisioner-id":   "aws-provisioner",
        "interval":         60,
        "key-name":         "aws-provisioner-managed"
      }
    }
    ```
  9. Configure Github-Auto-Deploy, set `.../Github-Auto-Deploy/GitAutoDeploy.conf.json`
    ```js
    {
      "port": 8001,
      "repositories":
      [
        {
          "url": "https://github.com/taskcluster/aws-provisioner",
          "path": "/home/ubuntu/aws-provisioner",
          "deploy": "sudo service taskcluster-aws-provisioner restart"
        }
      ]
    }
    ```

  10. Install forever `sudo npm -g install forever`
  11. Configure github post hook for `aws-provisioner.taskcluster.net:8001`
  12. Start server `sudo start taskcluster-aws-provisioner`
  13. Start Github-Auto-deploy `sudo start github-auto-deploy`