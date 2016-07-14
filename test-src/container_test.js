let log = require('../lib/log');
let debug = log.debugCompat('container-tests');
let subject = require('../lib/container');
let main = require('../lib/main');
let assume = require('assume');
let uuid = require('uuid');

describe('Azure Blob Container', () => {
  let cfg;
  let containerName = uuid.v4();
  debug('container name: ' + containerName);
  let container;

  before(async () => {
    cfg = await main('cfg', {profile: 'test', process: 'test'});
    container = await subject(cfg.azureBlob.accountName, cfg.azureBlob.accountKey, containerName);
  });

  after(async () => {
    await container.removeContainer();
  });

  it('should be able to create, read, update and delete a blob', async () => {
    let blobName = uuid.v4();
    debug('blob name: ' + blobName);
    let expected = {
      a: uuid.v4(),
    };

    await container.write(blobName, expected);

    let readValue = await container.read(blobName);

    assume(readValue).deeply.equals(expected);

    container.remove(blobName);
  });

  it('should allow overwriting', async () => {
    let blobName = uuid.v4();
    debug('blob name: ' + blobName);
    let expected = {
      a: uuid.v4(),
    };
    await container.write(blobName, expected);
    expected.a = uuid.v4();
    await container.write(blobName, expected);
    let readValue = await container.read(blobName);
    assume(readValue).deeply.equals(expected);
    container.remove(blobName);
  });

  it('should cause error when reading missing blob', async done => {
    try {
      await container.read(uuid.v4());
      done(new Error('shouldnt reach here'));
    } catch (err) {
      assume(err.code).equals('BlobNotFound');
      done();
    }
  });

  it('should not fail to delete an absent blob', async () => {
    await container.remove(uuid.v4());
  });

});
