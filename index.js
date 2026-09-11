// Only for apps that use createApp's DEFAULT gate. Deliberately NOT a plain
// `requiredEnv`: an app that answers the auth question another way — auth:false
// for the auth service itself, or auth:{middleware} for its own check — never
// reaches AUTH_URL, and forcing it to set one would be a variable it must
// invent a value for. Same split as @xeplr/email's requiredEnv vs
// templatesRequiredEnv: one list per capability, spread only if you use it.
var gateRequiredEnv = ['AUTH_URL'];

module.exports = {
  gateRequiredEnv: gateRequiredEnv,
  createApp: require('./express'),
  createHttpServer: require('./http'),
  checkEnv: require('./lib/checkEnv'),
  genericRoute: require('./lib/genericRoute'),
  remoteAuth: require('./lib/remoteAuth'),
  genericController: require('./lib/genericController'),
  uploadRoute: require('./lib/uploadRoute'),
  runCluster: require('./lib/cluster').runCluster,
  broadcast: require('./lib/cluster').broadcast,
  isPrimary: require('./lib/cluster').isPrimary,
  isWorker: require('./lib/cluster').isWorker,
  sse: require('./lib/sse')
};
