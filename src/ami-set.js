let base = require('taskcluster-base');
let debug = require('debug')('aws-provisioner:AmiSet');
let amiExists = require('./check-for-ami');
let getVirtualizationType = require('./get-virtualization-type');

const KEY_CONST = 'ami-set';

 /**
 * An AMI Set is a collection of AMIs with a single name (its AMI Set ID).
 * Each AMI in the set is keyed by its virtualization type (PV or HVM) and
 * by its AWS region.
 */

let AmiSet = base.Entity.configure({
  version: 1,

  partitionKey: base.Entity.keys.ConstantKey(KEY_CONST),
  rowKey: base.Entity.keys.StringKey('id'),

  properties: {

    id: base.Entity.types.String,
    /* This is a JSON object which contains the AMIs of an AMI set keyed by
     * their virtualization type and region. It is in the shape:
     * [
     *   {
     *     region: us-west-1,
     *     hvm: ami-2222,
     *     pv: ami-3333
     *   }
     * ]
     */
    amis: base.Entity.types.JSON,
    // Store the date of last modification for this entity
    lastModified: base.Entity.types.Date,

  },
  context: ['ec2'],
});

/**
 * Load the names of all the known Amis
 */
AmiSet.listAmiSets = async function () {

  let names = [];

  await base.Entity.scan.call(this, {}, {
    handler: function(item) {
      names.push(item.id);
    },
  });

  return names;
};

/**
 * Checks if the AMIs from the amiSet are valid or not.
 */

async function checkAmi(ctx, region, ami, vtype) {
  let request;
  let missing = [];
  let virtualizationType = '';

  if (ami) {
    request = {
      ImageIds: [ami],
    };
    let exists = await amiExists(ctx.ec2[region], ami);
    if (exists) {
      virtualizationType = await getVirtualizationType(ctx.ec2[region], ami);
      if (virtualizationType !== vtype) {
        missing.push({imageId: ami, region: region, virtualizationType: virtualizationType});
      }
    } else {
      missing.push({imageId: ami, region: region, virtualizationType: virtualizationType});
    };
  }
  return missing;
};

AmiSet.validate = async function (ctx, amiSet) {
  let missing = [];
  let exists = false;

  await Promise.all(amiSet.amis.map(async (def) => {

    if (def.hvm) {
      missing = missing.concat(await checkAmi(ctx, def.region, def.hvm, 'hvm'));
    }
    if (def.pv) {
      missing = missing.concat(await checkAmi(ctx, def.region, def.pv, 'paravirtual'));
    }
  }));

  return missing;
};

/**
 * Return an Object for JSON encoding which represents
 * the data associated with this AMI Set.  This is a
 * method intended for use in displaying the data associated
 * with a given amiSet
 */
AmiSet.prototype.json = function() {
  return JSON.parse(JSON.stringify(this._properties));
};

module.exports = AmiSet;
