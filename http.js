const { createServer } = require('./lib/server');

/**
 * Create a plain Node HTTP server (no Express).
 *
 * @param {number|string} port    - Port or named pipe to listen on
 * @param {string}        appName - Service name (debug namespace + console logs)
 * @param {Function}      handler - Request handler: function(req, res)
 * @returns {http.Server}
 */
function init(port, appName, handler) {
  return createServer(handler, port, appName);
}

module.exports = { init };
