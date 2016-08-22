let subject = require('../lib/check-for-ami');
let assume = require('assume');
let main = require('../lib/main');

// These tests require actual access to aws and are disabled
describe('ami check', () => {
  let ec2;

  before(async () => {
    ec2 = await main('ec2', {profile: 'test', process: 'ec2'});
    ec2 = ec2['us-west-2'];
  });

  it('should see that an existing ami is really there', async () => {
    // NOTE: When amazon eventually deletes this AMI, we'll need
    // to pick a new one.  I picked one from here:
    // https://aws.amazon.com/amazon-linux-ami/
    // They still have some from 2011 there... we're fine
    let actual = await subject(ec2, 'ami-c803f1a8');
    assume(actual).is.true();
  });

  it('should see that an absent ami is not there', async () => {
    // NOTE: It's theoretically possible I guess for this to be
    // an AMI Id, but highly unlikely
    let actual = await subject(ec2, 'ami-00000000');
    assume(actual).is.false();
  });
});
