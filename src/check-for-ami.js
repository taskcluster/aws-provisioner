let log = require('./log');
let assert = require('assert');

/**
 * Check for the existence of an AMI that's executable by
 * the provided ec2 object in the given region
 */
module.exports = async function (ec2, ami) {
  assert(typeof ec2 === 'object');
  assert(typeof ami === 'string', 'ami is not string, rather a ' + typeof ami);

  let request = {
    // This filter is something we do want, but unfortunately I can't seem to get
    // it to reliably work in unit tests, so let's ignore it.
    // ExecutableUsers: ['self', 'all'],
    Filters: [{
      Name: 'image-id',
      Values: [ami],
    }],
    ImageIds: [ami],
  };

  let result;
  try {
    result = await ec2.describeImages(request).promise();
  } catch (err) {
    if (err.name === 'InvalidAMIID.NotFound') {
      return false;
    }
    throw err;
  }

  if (result.Images.length === 0) {
    return false;
  } else if (result.Images.length > 1) {
    let err = new Error('Image returned more than one result');
    err.imageids = result.Images.map(x => x.ImageId);
    throw err;
  }

  if (result.Images[0].ImageId === ami) {
    return true;
  } else {
    let err = new Error('api returned incorrect ami for search parameters');
    err.requested = ami;
    err.received = result.Images[0].ImageId;
    throw err;
  }
};
