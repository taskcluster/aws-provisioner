module.exports = {
  taskcluster: {
    queueBaseUrl: 'https://queue.taskcluster.net/v1',
    credentials: {
      clientId:     undefined,
      accessToken:  undefined,
    }
  },
  provisioner: {
    workerTypeTableName:  'AWS-Worker-Types',
    publishMetaData:  'false',
    statsComponent:   'aws-provisioner2',
  },
  server: {
    publicUrl:  'https://aws-provisioner2.taskcluster.net',
    port:       undefined,
    env:        'development',
    forceSSL:   false,
  },
  azure: {
    accountName: undefined,
    accountKey:  undefined,
  },
  influx: {
    connectionString: undefined,
  },
};
