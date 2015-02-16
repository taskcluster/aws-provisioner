module.exports = {
  provisioner: {
    id:                   'aws-provisioner2-dev',
    workerTypeTableName:  'AwsWorkerTypesDev',
    publishMetaData:      'false',
    statsComponent:       'aws-provisioner2-dev',
    awsKeyPrefix:         'aws-provisioner2-dev-managed:',
  },
  server: {
    publicUrl:  'https://aws-provisioner2.herokuapp.com',
    port:       5556,
    env:        'development',
    forceSSL:   false,
    trustProxy: false,
  },
};
