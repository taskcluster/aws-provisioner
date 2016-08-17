let log = require('./log');
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
  } catch (err) {
    return false;
  }

  if (result.data.Images.length === 0) {
    throw new Error('Image does not exist');
  } else if (result.data.Images.length > 1) {
    let err = new Error('Image returned more than one result');
    err.images = result.data.Images;
    throw err;
  }

  if (result.data.Images[0].ImageId === ami) {
    return true;
  } else {
    let err = new Error('api returned incorrect ami for search parameters');
    err.requested = ami;
    err.received = result.data.Images[0].ImageId;
    throw err;
  }
};
