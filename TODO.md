## TODO

* Add datapoints in provisioning logic for Influx
* Be more specific in JSON Schema
* Load things from NextToken when retreiving spot price history
* Store the requested spot instances so that we can monitor for the
  result of the spot request as well as how long it took for fulfilment
* Provide metrics on how long it takes for spot requests to be processed
* Overwrite UserData with temporary taskcluster credentials
* Encrypt UserData using opengpg.js
* Send pulse messages for
  * creating a workerType
  * updating a workerType
  * deleting a workerType
  * killing an instance
  * cancelling a spot request
  * creating a spot request
* Use Joi/assert to better control the input into functions
* Verify that errors in provisioning don't kill the entire
  provisioner
* Kill capacity which exceeds maxCapacity
* Provide facilities for copying AMIs between regions
* Api endpoints for
  * list all instances
  * list all spot requests
  * shutting down instances
  * cancelling spot requests
  * checking on status of spot request
  * metrics on current state
* Provide an API endpoint that's passed to Instances that they
  can hit when they come up to tell us that they started.  This
  lets us track how long it takes for a machine to go from Request
  Submitted to on.
* Write tests for all the provisioning logic
