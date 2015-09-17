/* Take a taskcluster.base.config config file and generate a command that will
   upload all values to heroku */

var file = process.argv[2];
var fs = require('fs');
var util = require('util');

try {
  var data = JSON.parse(fs.readFileSync(file));
} catch(e) {
  console.error('Error parsing JSON');
  if (e.stack) {
    console.log(e.stack);
  }
}

function visitNode(root) {
  var kvp = [];

  function _visitNode(node, parNames, name) {
    if (typeof node !== 'object') {
      kvp.push({
        name: parNames.join('_') + '_' + name,
        value: node
      })
    } else {
      Object.keys(node).map(function(x) {
        var nParNames = [].concat(parNames);
        nParNames.push(name);
        _visitNode(node[x], nParNames.filter(function(y) { return !!y; }), x);
      });
    }
  }

  _visitNode(root, '', '');
  return kvp;
}

var sep = ' \\\n    '
var vars = visitNode(data, '', '').map(function(x) {
  return '"' + x['name'] + '=' + x['value'] + '"';
}).join(sep);

console.log('  heroku config:set%s%s', sep, vars);

