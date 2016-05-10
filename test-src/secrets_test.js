var helper = require('./helper');
var slugid = require('slugid');
var assume = require('assume');
var taskcluster = require('taskcluster-client');

describe('secrets api', () => {

  var token = slugid.v4();
  var secretToAdd = {
    workerType: 'workerType',
    region: 'us-west-1',
    secrets: {
      key1: true,
      key2: 123,
      key3: 'sample',
      key4: {a: 123},
    },
    token: token,
    expiration: taskcluster.fromNow('1 day'),
  };

  it('should be able to create a secret (idempotent)', async () => {
    await helper.awsProvisioner.createSecret(token, secretToAdd);
    await helper.awsProvisioner.createSecret(token, secretToAdd);
  });

  it('should be able to load a secret', async () => {
    var loadedSecret = await helper.awsProvisioner.getSecret(token);
    console.log(JSON.stringify(loadedSecret, null, 2));
    assume(loadedSecret.workerId).is.ok();
    assume(loadedSecret.workerGroup).is.ok();
    assume(loadedSecret.data).to.eql(secretToAdd.secrets);
  });

  it('should be able to remove a secret (idempotent)', async () => {
    await helper.awsProvisioner.removeSecret(token);
    await helper.awsProvisioner.removeSecret(token);

    try {
      await helper.awsProvisioner.getSecret(token);
    } catch (err) {
      assume(err.statusCode).equals(404);
    }
  });
});
