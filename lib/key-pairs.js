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
module.exports.createPubKeyHash = function(pubKey) {
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
module.exports.createKeyPairName = function(prefix, pubKey) {
  assert(prefix);
  // We want to support the case where we're still using a config setting
  // that ends in : as it used to
  if (prefix.charAt(prefix.length - 1) === ':') {
    prefix = prefix.slice(0, prefix.length - 1);
  }
  assert(prefix.indexOf(':') === -1, 'only up to one trailing colon allowed');
  assert(pubKey);
  return prefix + ':' + module.exports.createPubKeyHash(pubKey);
};

