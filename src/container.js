let assert = require('assert');
let azure = require('azure-storage');

/**
 * Wrap an Azure Blob Storage container and provide convenience methods.  Note
 * that you must call and wait for the init(); method after creating an
 * instance of this class.
 *
 * TODO: implement listing blobs
 */
class Container {
  /**
   * Static initialization code
   */
  constructor(accountName, accountKey, container) {
    assert(typeof accountName === 'string');
    assert(typeof accountKey === 'string');
    assert(typeof container === 'string');

    this.svc = azure.createBlobService(accountName, accountKey);
    this.container = container;
  }

  /**
   * Mandatory async init operations
   */
  async init() {
    return new Promise((res, rej) => {
      this.svc.createContainerIfNotExists(this.container, (err, result, response) => {
        if (err) {
          return rej(err);
        }
        return res();
      });
    });
  }

  /**
   * Serialize `contents` into JSON and store it as a BlockBlob named
   * `blobName`
   */
  async write(blobName, contents) {
    assert(typeof blobName === 'string');
    assert(typeof contents !== 'undefined');
    return new Promise((res, rej) => {
      let data = JSON.stringify({
        content: contents,
        version: 1,
      });
      this.svc.createBlockBlobFromText(this.container, blobName, data, (err, result, response) => {
        if (err) {
          return rej(err);
        }
        return res();
      });
    });
  }
  
  /**
   * Read `blobName` and parse it as JSON and provide that value as the
   * resolution value
   */
  async read(blobName) {
    assert(typeof blobName === 'string');
    return new Promise((res, rej) => {
      this.svc.getBlobToText(this.container, blobName, (err, text) => {
        if (err) {
          return rej(err);
        }
        let data = JSON.parse(text);
        assert(data.version === 1, 'Unexpected Blob Storage format');
        return res(data.content);
      });
    });
  }

  /**
   * Remove `blobName`
   */
  async remove(blobName) {
    assert(typeof blobName === 'string');
    return new Promise((res, rej) => {
      this.svc.deleteBlob(this.container, blobName, (err, response) => {
        if (err && err.code !== 'BlobNotFound') {
          return rej(err);
        }
        return res();
      });
    });
  }

  /**
   * Remove the Container associated with this instance
   */
  async removeContainer() {
    return new Promise((res, rej) => {
      this.svc.deleteContainer(this.container, (err, response) => {
        if (err) {
          return rej(err);
        }
        return res();
      });
    });
  }

}

async function ContainerFactory(accountName, accountKey, container) {
  let c = new Container(accountName, accountKey, container);
  await c.init();
  return c;
}

module.exports = ContainerFactory;
