let log = require('./log');
let debug = log.debugCompat('aws-provisioner:lib:check-for-ami');
let assert = require('assert');

/**
 * Check for the existence of an AMI that's executable by
 * the provided ec2 object in the given region
 */
module.exports = async function (ec2, ami) {
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
    result = await ec2.describeImages(request).promise();
    debug('loaded information about %s', ami);
  } catch (err) {
    debug('describe ami images for %s failed', ami);
    return false;
  }

  if (result.data.Images.length === 0) {
    debug('did not find %s', ami);
    return false;
  } else if (result.data.Images.length > 1) {
    debug(result.data);
    throw new Error('Image returned more than one result');
  }

  if (result.data.Images[0].ImageId === ami) {
    return true;
  } else {
    throw new Error('api returned incorrect ami for search parameters');
  }
};
