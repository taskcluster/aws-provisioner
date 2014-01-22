TaskCluster Spot Provisioner
============================

This repository contains a EC2 spot instance provisioner for a TaskCluster
instance. Basically, this server monitors the number of pending tasks, number
running instances and pending spot requests, based on these number spot requests
are submitted to AWS.

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
