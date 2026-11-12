// options.host: a service that only a proxy on the same machine should reach
// listens on 127.0.0.1, not on every address. Through the real createApp.

var test = require('node:test');
var assert = require('node:assert');
var createApp = require('../express');

function listening(server) {
  return new Promise(function (r) { server.listening ? r() : server.once('listening', r); });
}

test('host: listens on that address only', async function () {
  var built = createApp(0, 'host_test', { auth: false, log: false, host: '127.0.0.1' });
  try {
    await listening(built.server);
    assert.equal(built.server.address().address, '127.0.0.1');
    var res = await fetch('http://127.0.0.1:' + built.server.address().port + '/nothing');
    assert.equal(res.status, 404);
  } finally {
    built.server.close();
  }
});

test('no host: every address, as before', async function () {
  var built = createApp(0, 'host_test', { auth: false, log: false });
  try {
    await listening(built.server);
    assert.ok(['::', '0.0.0.0'].indexOf(built.server.address().address) > -1, built.server.address().address);
  } finally {
    built.server.close();
  }
});
