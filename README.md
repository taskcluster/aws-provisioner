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
  2. Configure the server (see `config.js`), and
  3. Run the server with `node server.js`


Instance Management
-------------------
This provisioner relies on a special key-name to find and identify spot requests
and instances managed by this provisioner. Consequently, if other processes or
**people** creates spot request or EC2 instances with this special key-name,
then behavior is undefined.
