'use strict';

var assert = require('assert');
var lodash = require('lodash');

/**
 * Pick keys recursively from objects.  Obj is
 * the source object, and keys is an array of strings.
 * Each string in this array is colon seperated keys
 * of the source object.
 * Examples:

  var source = {a: {b: {c: 1, e: 2}}, d: 3}

  recursiveObjectPicker(source, ["a"]) # --> { a: { b: { c: 1, e: 2 } } }
  recursiveObjectPicker(source, ["a:b:c"]) # --> { a: { b: { c: 1 } } }
  recursiveObjectPicker(source, ["d"]) # --> { d: 3 }

 */
function recursiveObjectFilter (obj, keys) {
  assert(typeof obj === 'object');
  assert(Array.isArray(keys));
  var newObj = {};
  keys.forEach(function (key) {
    var props = key.split(':');

    var p = obj;
    var d = newObj;

    // Probably should merge these two loops into one...
    props.forEach(function (prop) {
      p = p[prop];
    });

    props.forEach(function (prop, idx, arr) {
      if (d[prop]) {
        if (typeof d[prop] !== 'object') {
          throw new Error('trying to assign property to non-object (%j)', d[prop]);
        }
      } else {
        d[prop] = {};
      }

      // We have to do this here so that we're assinging to a property and not
      // overwriting a temporary reference to the pointed-to-value
      if (idx === arr.length -1) {
        // We want to deepcopy things which are objects.  If a property
        // name refers to an object, we take the whole thing
        if (typeof p === 'object') {
          d[prop] = lodash.cloneDeep(p);
        } else {
          d[prop] = p;
        }
      } else {
        d = d[prop];
      }
    });

  });

  return newObj;
}

module.exports = recursiveObjectFilter;
