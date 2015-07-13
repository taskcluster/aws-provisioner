#!/bin/bash -ve
# USAGE: Run this file using `npm test` (must run from repository root)

# Run linter
if [ "$NOLINT" != 1 ] ; then
  eslint \
    bin/server.js \
    bin/provisioner.js \
    bin/manage.js \
    lib/*.js \
    lib/routes/*.js \
    test/*.js
fi

# Run tests
mocha                                   \
  test/*_test.js            \
  ;

