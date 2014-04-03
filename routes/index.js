
/*
 * GET home page.
 */

exports.index = function(req, res){
  res.render('index', { title: null });
};

// Include all modules
[
  'unauthorized',
  'workertype'
].forEach(function(module) {
  exports[module] = require('./' + module);
});

