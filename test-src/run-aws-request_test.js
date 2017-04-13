var subject = require('../lib/aws-manager').runAWSRequest;
var assume = require('assume');
var aws = require('aws-sdk');

describe.only('aws-runner', function() {
  let goodEc2;
  let badEc2;

  before(() => {
    goodEc2 = new aws.EC2({region: 'us-east-1'});
    badEc2 = new aws.EC2({region: 'us-east-1', credentials: {}});
  });

  it('should work', async () => {
    let result = await subject(goodEc2, 'describeRegions', {});
    assume(result).has.property('Regions');
  });

  it('should throw an error with bad credentails', async () => {
    try {
      let result = await subject(badEc2, 'describeRegions', {});
      return Promise.reject('nuh-uh');
    } catch (err) {
      assume(err).to.be.an('Error');
    }
  });
  
  it('should throw an error with dry run', async () => {
    try {
      await subject(goodEc2, 'describeRegions', {DryRun: true});
      return Promise.reject('nuh-uh');
    } catch (err) {
      assume(err).has.property('requestId');
      assume(err).has.property('region', 'us-east-1');
      assume(err).has.property('service', 'ec2');
      assume(err).has.property('method', 'describeRegions');
    }
  });

});
