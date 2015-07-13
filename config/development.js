module.exports = {
  provisioner: {
    id:                   'aws-provisioner2-dev',
    workerTypeTableName:  'AwsWorkerTypesDev2',
    secretTableName:      'ProvisionerSecretsDev',
    workerStateTableName: 'ProvisionerWorkerStateDev1',
    publishMetaData:      'false',
    statsComponent:       'aws-provisioner2-dev',
    awsKeyPrefix:         'aws-provisioner2-dev-managed:',
    allowedRegions:       'us-west-2',
  },
  server: {
    publicUrl:  'http://localhost:5557',
    port:       5557,
    env:        'development',
    forceSSL:   false,
    trustProxy: false,
  },
};
