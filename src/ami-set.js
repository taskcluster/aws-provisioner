let Entity = require('azure-entities');

const KEY_CONST = 'ami-set';

 /**
 * An AMI Set is a collection of AMIs with a single name (its AMI Set ID).
 * Each AMI in the set is keyed by its virtualization type (PV or HVM) and
 * by its AWS region.
 */

let AmiSet = Entity.configure({
  version: 1,

  partitionKey: Entity.keys.ConstantKey(KEY_CONST),
  rowKey: Entity.keys.StringKey('id'),

  properties: {

    id: Entity.types.String,
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
    amis: Entity.types.JSON,
    // Store the date of last modification for this entity
    lastModified: Entity.types.Date,

  },
});

/**
 * Load the names of all the known Amis
 */
AmiSet.listAmiSets = async function () {
  let names = [];

  await Entity.scan.call(this, {}, {
    handler: function(item) {
      names.push(item.id);
    },
  });

  return names;
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
