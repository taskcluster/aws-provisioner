module.exports = {
  taskcluster: {
    queueBaseUrl: undefined,
    authBaseUrl: undefined,
    credentials: {
      clientId:     undefined,
      accessToken:  undefined,
    }
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
  },
  influx: {
    connectionString: undefined,
  },
};
