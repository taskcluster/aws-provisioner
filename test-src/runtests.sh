#!/bin/bash -ve

# Run linter
if [ "$NOLINT" != 1 ] ; then
  eslint src/*.js test-src/*.js
fi

# Run tests
if [ "$NOMOCHA" != 1 ] ; then
  mocha test/*_test.js
fi

