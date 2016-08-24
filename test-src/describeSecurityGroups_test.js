let subject = require('../lib/describe-security-group');
let assume = require('assume');
let main = require('../lib/main');

// These tests require actual access to aws and are disabled
describe('security group check', () => {
  let ec2;

  before(async () => {
    ec2 = await main('ec2', {profile: 'test', process: 'ec2'});
    ec2 = ec2['us-west-2'];
  });

  it('should see that an existing security group is really there', async () => {
    let actual = await subject(ec2, ['livelog-direct']);
    assume(actual).is.ok();
    assume(actual).is.an.Object;
  });

  it('should see that multiple existing security group is really there', async () => {
    let actual = await subject(ec2, ['livelog-direct', 'ssh-only']);
    assume(actual).is.ok();
    assume(actual).is.an.Object;
  });
  
  it('should see that an absent security group is not there', async () => {
    let actual = await subject(ec2, ['haha']);
    assume(actual).is.not.ok();
  });

  it('it should error if not all groups are there', async () => {
    let actual = await subject(ec2, ['livelog-direct', 'haha']);
    assume(actual).is.not.ok();
  });
});
