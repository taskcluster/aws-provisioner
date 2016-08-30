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

  let amiSetDefinition = makeAmiSet();
  let amiSetChanged = _.clone(amiSetDefinition);
  amiSetChanged.amis.push({
    region: 'us-east-1',
    hvm: '',
    pv: '',
  });

  let id = slugid.nice();
  let lastModified;

  let AmiSet;
  let amiSet;

  let client;

  before(async () => {
    AmiSet = await main('AmiSet', {process: 'AmiSet', profile: 'test'});

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
          hvm: 'ami-eee31781',
          pv: 'ami-7fe81c10',
          region: 'eu-central-1',
        },
        {
          hvm: 'ami-fb54dcec',
          pv: 'ami-656be372',
          region: 'us-east-1',
        },
        {
          hvm: '',
          pv: '',
          region: 'us-east-1',
        },
      ],
      id: id,
      lastModified: lastModified,
    });
  });

  it('should be able to check if the AMIs from an AMI set are valid', async () => {
    let invalidAmiSet = amiSetChanged;
    let amiSet;
    invalidAmiSet.amis.push({
      region: 'us-east-1',
      hvm: 'ami123',
      pv: 'ami345',
    });
    try {
      amiSet = await client.createAmiSet(id, invalidAmiSet);
      // throw new Error('Expected and error');
    } catch (err) {
      console.log(err);
      assume(err.statusCode).is.between(400, 499);
    };
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
