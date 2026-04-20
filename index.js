module.exports = {
  createApp: require('./express'),
  createHttpServer: require('./http'),
  genericRoute: require('./lib/genericRoute'),
  genericController: require('./lib/genericController'),
  runCluster: require('./lib/cluster').runCluster,
  broadcast: require('./lib/cluster').broadcast,
  isPrimary: require('./lib/cluster').isPrimary,
  isWorker: require('./lib/cluster').isWorker
};
