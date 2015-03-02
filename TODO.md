## TODO

* Add datapoints in provisioning logic for Influx
* Be more specific in JSON Schema
* Load things from NextToken when retreiving spot price history
* Overwrite UserData with temporary taskcluster credentials
  * Include the API endpoint for the slave to hit the hello
    endpoint
  * include the instanceId scope!
* Encrypt UserData using opengpg.js
* Send pulse messages for
  * killing an instance
  * cancelling a spot request
  * creating a spot request
* Use Joi/assert to better control the input into functions
* Verify that errors in provisioning don't kill the entire
  provisioner
* Kill capacity which exceeds maxCapacity
* Provide facilities for copying AMIs between regions
* Api endpoints for
  * cancelling spot requests
  * checking on status of spot request
  * metrics on current state
* insert into influx when the hello endpoint is hit
* Ensure that UserData is valid JSON
* Write tests for all the provisioning logic
