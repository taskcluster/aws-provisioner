#!/bin/bash -ve
# USAGE: Run this file using `npm test` (must run from repository root)

# Run linter
if [ "$NOLINT" != 1 ] ; then
  eslint \
    bin/server.js \
    bin/provisioner.js \
    bin/manage.js \
    lib/*.js \
    routes/*.js \
    test/*.js \
    provisioner/*.js
fi

# Run tests
mocha                                   \
  test/badworkertype_test.js            \
  test/manageworkertype_test.js         \
  test/test_workertype.js               \
  ;

