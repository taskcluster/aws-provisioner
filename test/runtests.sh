#!/bin/bash -ve

# Run linter
if [ "$NOLINT" != 1 ] ; then
  eslint --rulesdir eslint-rules \
    src/bin/server.js \
    src/bin/provisioner.js \
    src/bin/manage.js \
    src/lib/*.js \
    src/lib/routes/*.js \
    test/*.js
fi

# Run tests
if [ "$NOMOCHA" != 1 ] ; then
  mocha test/*_test.js
fi

