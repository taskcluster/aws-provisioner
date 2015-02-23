module.exports = {
  provisioner: {
    id:                   'aws-provisioner2',
    workerTypeTableName:  'AWSWorkerTypesV2',
    publishMetaData:      'false',
    statsComponent:       'aws-provisioner2',
    awsKeyPrefix:         'aws-provisioner2-managed:',
  },
  server: {
    publicUrl:  'https://aws-provisioner2.herokuapp.com',
    port:       5556,
    env:        'production',
    forceSSL:   false,
    trustProxy: false,
  },
};
