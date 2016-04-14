let assert = require('assert');

/**
 * Check for the existence of an AMI that's executable by
 * the provided ec2 object in the given region
 */

let debug = require('debug')('aws-provisioner:lib:check-for-ami');

module.exports = async function (ec2, ami, region) {
  let request = {
    /* Not sure why this isn't working
    ExecutableUsers: [
      'self',
      'all',
    ],*/
    ImageIds: [ami],
  };

  let result;
  try {
    // If we're using the multi-region wrapper, we handle things
    // slightly differently
    if (ec2.describeImages && ec2.describeImages.inRegion) {
      result = await ec2.describeImages.inRegion(region, request);
    } else {
      assert(!region, 'this ec2 module doesnt understand region');
      result = await ec2.describeImages(request);
    }
    debug('result from ec2: %j', result);
  } catch (err) {
    debug('did not find %s', ami);
    return false;
  }

  if (result.Images.length !== 1) {
    throw new Error('found more images than expected');
  }

  if (result.Images[0].ImageId === ami) {
    return true;
  } else {
    throw new Error('api returned incorrect ami for search parameters');
  }
};
