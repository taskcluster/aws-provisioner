#!/bin/bash

# Here's a simple script to make sure that everything
# goes roughly as planned.  This would be much better
# if it were JS, in Mocha, started the server
# and checked output.

set -xe

url="http://localhost:5556/v1"

run () {
  node bin/manage-worker-types.js --url $url $@
}

run help
run list
run create gaia.json
run delete test
run create gaia.json
run delete-all
run create gaia.json
run fetch test
run fetch-all
run all-stop
