const http = require('http');

function normalizePort(val) {
  const port = parseInt(val, 10);
  if (isNaN(port)) return val;   // named pipe
  if (port >= 0) return port;
  return false;
}

function createServer(handler, port, name) {
  const dbg = require('debug')('architects:' + name);
  const normalizedPort = normalizePort(port);

  const server = http.createServer(handler);
  server.listen(normalizedPort);

  server.on('error', function onError(error) {
    if (error.syscall !== 'listen') throw error;
    const bind = typeof normalizedPort === 'string'
      ? 'Pipe ' + normalizedPort
      : 'Port ' + normalizedPort;
    switch (error.code) {
      case 'EACCES':
        console.error(bind + ' requires elevated privileges');
        process.exit(1);
        break;
      case 'EADDRINUSE':
        console.error(bind + ' is already in use');
        process.exit(1);
        break;
      default:
        throw error;
    }
  });

  server.on('listening', function onListening() {
    const addr = server.address();
    const bind = typeof addr === 'string' ? 'pipe ' + addr : 'port ' + addr.port;
    dbg('Listening on ' + bind);
    console.log(name + ' service listening on ' + bind);
  });

  return server;
}

module.exports = { createServer, normalizePort };
