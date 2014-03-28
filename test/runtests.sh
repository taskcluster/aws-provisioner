#!/bin/bash -vex

./node_modules/.bin/mocha test/state_test.js;

# TODO: Fix this full test when it actually working... probably needs some
# form of authentication...
#./node_modules/.bin/mocha test/provisioning_test.js;