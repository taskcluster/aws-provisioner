module.exports = {
  taskcluster: {
    queueBaseUrl: 'https://queue.taskcluster.net/v1',
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
    id:                   'aws-provisioner2',
    workerTypeTableName:  'AwsWorkerTypes',
    publishMetaData:      'false',
    statsComponent:       'aws-provisioner2',
    awsKeyPrefix:         'aws-provisioner2-managed:',
    pulseRate:            10000,
    awsInstancePubkey:    undefined,
    allowedRegions:       'us-west-1,us-west-2', // comma seperated list
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
    secretAccessKey: undefined
  },
  influx: {
    connectionString: undefined,
  },
};
