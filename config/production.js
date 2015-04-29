module.exports = {
  provisioner: {
    id:                   'aws-provisioner-v1',
    workerTypeTableName:  'AWSWorkerTypesV2',
    publishMetaData:      'false',
    statsComponent:       'aws-provisioner-v1',
    awsKeyPrefix:         'aws-provisioner-v1-managed:',
    iterationInterval:    1000 * 75,
    allowedRegions:       'us-west-2', // comma seperated list
  },
  server: {
    publicUrl:  'https://aws-provisioner2.herokuapp.com',
    port:       5557,
    env:        'production',
    forceSSL:   true,
    trustProxy: true,
  },
};
