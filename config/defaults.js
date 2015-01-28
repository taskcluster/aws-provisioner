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
    awsKeyPrefix:         'taskcluster-aws-provisioner-managed:',
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
  influx: {
    connectionString: undefined,
  },
};
