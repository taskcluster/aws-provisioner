let assert = require('assert');
let crypto = require('crypto');
/** 
 * We want to ensure that the KeyPairs that we create are unique-ish-ly
 * named so that when we rotate keys that we can ensure that new instances
 * use the new keys.  Because we don't really care about the comment used
 * when the pubkey was created, we just take the algorithm and the data
 * and create a sha256 key.  Because this is not important from a security
 * perspective, we just take the first 7 chars
 */
module.exports.createPubKeyHash = function (pubKey) {
  assert(pubKey);
  let keyData = pubKey.split(' ');
  assert(keyData.length >= 2, 'pub key must be in a valid format');
  keyData = keyData[0] + ' ' + keyData[1];
  keyData = crypto.createHash('sha256').update(keyData).digest('hex');
  return keyData.slice(0, 7);
};

/**
 * Create a KeyPair name
 */
module.exports.createKeyPairName = function (prefix, pubKey, workerName) {
  assert(prefix);
  assert(pubKey);
  assert(workerName);
  return prefix + workerName + ':' + module.exports.createPubKeyHash(pubKey);
};

/**
 * Parse a KeyPair name into an object with a prefix, workerType and
 * keyHash properties on the returned object
 */
module.exports.parseKeyPairName = function (name) {
  assert(name);
  let parts = name.split(':');
  let rv = {
    prefix: parts[0],
    workerType: parts[1],
  };

  if (parts.length == 2) {
    rv.keyHash = '';
  } else if (parts.length === 3) {
    rv.keyHash = parts[2];
  } else {
    throw new Error('KeyPair name is not parseable: ' + name);

  }
  return rv;
};
