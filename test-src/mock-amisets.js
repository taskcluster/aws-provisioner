var _ = require('lodash');

var baseAmiSet = {
  amis:
  [
    {
      region: 'eu-central-1',
      hvm: 'ami-eee31781',
      pv: 'ami-7fe81c10',
    },
    {
      region: 'us-east-1',
      hvm: 'ami-fb54dcec',
      pv: 'ami-656be372',
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
