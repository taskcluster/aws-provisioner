let subject = require('../lib/check-for-ami');
let assume = require('assume');
var libConfig = require('taskcluster-lib-config');
let aws = require('aws-sdk');

describe('ami check', () => {
  let ec2;

  before(() => {
    let cfg = libConfig({
      defaults: require('../config/defaults'),
      profile: require('../config/test'),
      filename: 'taskcluster-aws-provisioner',
    });
    let ec2conf = cfg.get('aws');
    ec2conf.region = 'us-west-2';
    ec2 = new aws.EC2(cfg.get('aws'));
  });

  it('should see that an existing ami is really there', async () => {
    // NOTE: When amazon eventually deletes this AMI, we'll need
    // to pick a new one.  I picked one from here:
    // https://aws.amazon.com/amazon-linux-ami/
    // They still have some from 2011 there... we're fine
    let actual = await subject(ec2, 'ami-c229c0a2');
    assume(actual).is.true();
  });

  it('should see that an absent ami is not there', async () => {
    // NOTE: It's theoretically possible I guess for this to be
    // an AMI Id, but highly unlikely
    let actual = await subject(ec2, 'ami-00000000');
    assume(actual).is.false();
  });
});
