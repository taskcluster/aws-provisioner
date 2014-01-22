
/*
 * GET home page.
 */

exports.index = function(req, res){
  res.render('index', { title: 'Express' });
};

// Include all modules
[
  'log',
  'api'
].forEach(function(module) {
  exports[module] = require('./' + module);
});

