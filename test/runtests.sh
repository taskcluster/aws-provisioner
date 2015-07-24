#!/bin/bash -ve

# Run linter
if [ "$NOLINT" != 1 ] ; then
  eslint --rulesdir eslint-rules \
    bin/server.js \
    bin/provisioner.js \
    bin/manage.js \
    lib/*.js \
    lib/routes/*.js \
    test/*.js
fi

# Run tests
if [ "$NOMOCHA" != 1 ] ; then
  mocha test/*_test.js
fi

