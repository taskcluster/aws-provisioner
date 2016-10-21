var slugid = require('slugid');
var assume = require('assume');
var debug = require('debug')('test');
var _ = require('lodash');
var mock = require('./mock-amisets');

var makeAmiSet = mock.makeAmiSet;

var main = require('../lib/main');
var helper = require('./helper');

describe('AMI Set api', () => {

  let amiSetDefinition = makeAmiSet();
  let amiSetChanged = _.clone(amiSetDefinition);
  amiSetChanged.amis.push({
    region: 'us-east-1',
    hvm: 'ami-0123',
    pv: 'ami-0345',
  });

  let id = slugid.nice();
  let lastModified;

  let amiSet;

  let client;

  before(async () => {
    amiSet = await main('AmiSet', {process: 'AmiSet', profile: 'test'});

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

  it('should be able to update an AMI Set', async () => {
    debug('### Load amiSet');
    await client.createAmiSet(id, amiSetDefinition);

    amiSet = await client.amiSet(id);

    debug('### Update amiSet');
    try {
      await client.updateAmiSet(id, amiSetChanged);
    } catch (e) {
      console.log(JSON.stringify(e));
      throw e;
    }

    debug('### Load amiSet (again)');
    amiSet = await client.amiSet(id);
    lastModified = amiSet.lastModified;
    assume(amiSet).to.deeply.equal({
      amis: [
        {
          hvm: 'ami-1111',
          pv: 'ami-2222',
          region: 'us-west-1',
        },
        {
          hvm: 'ami-1234',
          pv: 'ami-5678',
          region: 'us-east-2',
        },
        {
          hvm: 'ami-0123',
          pv: 'ami-0345',
          region: 'us-east-1',
        },
      ],
      id: id,
      lastModified: lastModified,
    });
  });

  it('should return a list of AMI sets', async () => {
    await client.createAmiSet(id, amiSetDefinition);
    assume(await client.listAmiSets()).to.deeply.equal([id]);
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
