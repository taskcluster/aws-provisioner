var nconf   = require('nconf')

nconf.argv();

console.log(nconf.get('test'))
