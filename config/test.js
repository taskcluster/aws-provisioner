module.exports = {
  provisioner: {
    id:                   'aws-provisioner2-test',
    workerTypeTableName:  'atablefortesting',
    workerStateTableName: 'workerstatetesting',
    secretTableName:      'ProvisionerSecretTest',
    publishMetaData:      'false',
    statsComponent:       'aws-provisioner2-test',
    allowedRegions:       'us-west-2',
    awsKeyPrefix:         'aws-provisioner2-test-managed:',
    awsInstancePubkey:    'fake-pubkey'
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
  },
  influx: {
    connectionString: 'https://fake.mozilla.com',
  }
};
