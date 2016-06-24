var _ = require('lodash');

var baseAmiSet = {
  amis:
  [
    {
      region: 'us-west-1',
      hvm: 'ami-1111',
      pv: 'ami-2222',
    },
    {
      region: 'us-east-2',
      hvm: 'ami-1234',
      pv: 'ami-5678',
    },
  ],
};

function makeAmiSet(overwrites) {
  return _.defaults(overwrites || {}, baseAmiSet);
}

module.exports = {
  baseAmiSet: baseAmiSet,
  makeAmiSet: makeAmiSet,
};
