module.exports = {
  provisioner: {
    id:                   'aws-provisioner-v1',
    workerTypeTableName:  'AWSWorkerTypesV2',
    publishMetaData:      'false',
    statsComponent:       'aws-provisioner-v1',
    awsKeyPrefix:         'aws-provisioner-v1-managed:',
    iterationInterval:    1000 * 75,
    allowedRegions:       'us-west-2,us-east-1,us-west-1', // comma seperated list
    maxInstanceLife:      '- 31 days', // Until bug 1148097 lands
  },
  server: {
    publicUrl:  'https://taskcluster-aws-provisioner2.herokuapp.com',
    port:       5557,
    env:        'production',
    forceSSL:   true,
    trustProxy: true,
  },
};
