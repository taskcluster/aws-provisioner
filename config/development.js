module.exports = {
  provisioner: {
    id:                   'aws-provisioner2-dev',
    workerTypeTableName:  'AwsWorkerTypesDev2',
    publishMetaData:      'false',
    statsComponent:       'aws-provisioner2-dev',
    awsKeyPrefix:         'aws-provisioner2-dev-managed:',
    allowedRegions:       'us-west-2',
  },
  server: {
    publicUrl:  'https://aws-provisioner2.herokuapp.com',
    port:       5556,
    env:        'development',
    forceSSL:   false,
    trustProxy: false,
  },
};
