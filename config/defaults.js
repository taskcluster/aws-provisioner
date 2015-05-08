module.exports = {
  taskcluster: {
    queueBaseUrl: undefined,
    authBaseUrl: undefined,
  },
  pulse: {
    username: undefined,
    password: undefined,
  },
  provisioner: {
    id:                   undefined,
    workerTypeTableName:  undefined,
    publishMetaData:      'false',
    statsComponent:       undefined,
    awsKeyPrefix:         undefined,
    iterationInterval:    1000 * 10,
    awsInstancePubkey:    undefined,
    allowedRegions:       undefined, // comma seperated list
    maxInstanceLife:      '- 96 hours',
  },
  server: {
    publicUrl:  'https://localhost',
    port:       5556,
    env:        'development',
    forceSSL:   false,
    trustProxy: false,
  },
  azure: {
    accountName: undefined,
    accountKey:  undefined,
  },
  aws: {
    accessKeyId: undefined,
    secretAccessKey: undefined,
    version: '2014-10-01',
    region:  'us-west-2'
  },
  influx: {
    connectionString: undefined,
  },
};
