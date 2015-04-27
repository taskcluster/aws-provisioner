#!/bin/bash -ve
# USAGE: Run this file using `npm test` (must run from repository root)

# Run linter
#eslint \
#  bin/server.js \
#  bin/provisioner.js \
#  bin/manage.js \
#  lib/*.js \
#  routes/*.js \
#  test/*.js \
#  provisioner/*.js

# Run tests
mocha                     \
  test/test_server.js          \
  ;

