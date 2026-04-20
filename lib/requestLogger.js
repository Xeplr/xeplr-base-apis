var fs = require('fs');
var path = require('path');

/**
 * Request logger middleware — logs entry and exit for every API hit to a text file.
 *
 * @param {string} appName - Service name (used in log prefix)
 * @param {object} [options]
 * @param {string} [options.logDir='./logs'] - Directory for log files
 * @param {string} [options.filename] - Log filename (default: <appName>-requests.log)
 */
function createRequestLogger(appName, options) {
  options = options || {};
  var logDir = path.resolve(options.logDir || process.env.LOG_DIR || './logs');
  var filename = options.filename || (appName + '-requests.log');

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  var logPath = path.join(logDir, filename);
  var stream = fs.createWriteStream(logPath, { flags: 'a' });

  function timestamp() {
    return new Date().toISOString();
  }

  function write(line) {
    stream.write(line + '\n');
  }

  return function requestLogger(req, res, next) {
    var id = Math.random().toString(36).slice(2, 10);
    var method = req.method;
    var url = req.originalUrl || req.url;
    var entryTime = Date.now();

    write('[' + timestamp() + '] [' + appName + '] [' + id + '] → ' + method + ' ' + url);

    var originalEnd = res.end;
    res.end = function() {
      res.end = originalEnd;
      res.end.apply(res, arguments);

      var duration = Date.now() - entryTime;
      write('[' + timestamp() + '] [' + appName + '] [' + id + '] ← ' + method + ' ' + url + ' ' + res.statusCode + ' ' + duration + 'ms');
    };

    next();
  };
}

module.exports = createRequestLogger;
