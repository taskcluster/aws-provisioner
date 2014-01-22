var log                             = require('../provisioner/log');

/** Display action log */
module.exports = function(req, res){
  res.json(log.entries());
};
