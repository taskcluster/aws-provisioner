let log = require('./log');
let assert = require('assert');

/**
 * Mainly check for the existence of a security group, but also return
 * information about that security group as well.  The return value of this
 * function will be falsy if the security group is not found.  The return value
 * will be truthy (a non-empty object) if the group is found.  It will throw an
 * aws-sdk exception if there is an error looking up the security group.  The
 * `securityGroupName` parameter is the freeform name, e.g. "livelog-direct"
 * and not the ID, e.g. "sg-123abcd".
 */
module.exports = async function (ec2, securityGroupNames) {
  assert(typeof ec2 === 'object');
  assert(securityGroupNames);
  assert(Array.isArray(securityGroupNames));
  try {
    let result = await ec2.describeSecurityGroups({
      GroupNames: securityGroupNames,
    }).promise();
    result = result.data.SecurityGroups;
    assert(!!result);
    assert(Array.isArray(result));
    if (result.length !== securityGroupNames.length) {
      log.debug({result, securityGroupNames}, 'not all security groups existed');
      return undefined;
    }
    return result[0];
  } catch (err) {
    if (err.code === 'InvalidGroup.NotFound') {
      return undefined;
    }
    throw err;
  }
}
