module.exports = {
  provisioner: {
    id:                   'aws-provisioner2-test',
    workerTypeTableName:  'AwsWorkerTypesTest2',
    publishMetaData:      'false',
    statsComponent:       'aws-provisioner2-test',
    awsKeyPrefix:         'aws-provisioner2-test-managed:',
  },
  server: {
    publicUrl:  'https://aws-provisioner2-test.herokuapp.com',
    port:       5556,
    env:        'development',
    forceSSL:   false,
    trustProxy: false,
  },
  taskcluster: {
    authBaseUrl:    'http://localhost:60407/v1',
    credentials: {
      clientId:     'test-server',
      accessToken:  'none'
    }
  }
};
