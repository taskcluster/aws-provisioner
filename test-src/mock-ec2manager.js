const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = () => {
  const prices = fs.readFileSync(path.resolve(
    __dirname,
    '../test-src/prices.json')
  ).toString();
  const app = express();
  app.get('/v1/prices', (req, res) => res.send(prices));
  return app.listen(5555);
};
