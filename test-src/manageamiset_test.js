var slugid = require('slugid');
var assume = require('assume');
var debug = require('debug')('test');
var _ = require('lodash');
var mock = require('./mock-amisets');
var base = require('taskcluster-base');

var makeAmiSet = mock.makeAmiSet;

var main = require('../lib/main');
var helper = require('./helper');

describe('AMI Set api', () => {

  var id = slugid.nice();
  var amiSetDefinition = makeAmiSet();
  var amiSetChanged = _.clone(amiSetDefinition);

  let AmiSet;

  let client;

  let testAmiSet = makeAmiSet({
    lastModified: new Date(),
  });

  before(async () => {
    AmiSet = await main('Amiset', {process: 'AmiSet', profile: 'test'});

    client = helper.getClient();
  });

  beforeEach(async () => {
    await main('tableCleaner', {process: 'tableCleaner', profile: 'test'});
  });

  it('should be able to create an AMI set (idempotent)', async () => {
    debug('### Create AMI Set');
    await client.createAmiSet(id, amiSetDefinition);

    debug('### Create AMI Set (again)');
    await client.createAmiSet(id, amiSetDefinition);
  });

  it('should be able to remove an AMI set (idempotent)', async () => {
    debug('### Remove AMI Set');
    await client.removeAmiSet(id);
    await client.removeAmiSet(id);

    debug('### Try to load AMI Set');
    try {
      await client.amiSet(id);
      throw new Error('Expected and error');
    } catch (err) {
      assume(err.statusCode).equals(404);
    }
  });
});
