// requireApi: a route answers only a caller whose access names it. Through the
// real createApp, with its gate supplied as middleware that sets req.access as
// the auth gate does.

var test = require('node:test');
var assert = require('node:assert');
var express = require('express');
var createApp = require('../express');
var { requireApi } = require('..');

function gate(req, res, next) {
  var who = req.headers['x-test-apis'];
  if (who !== undefined) req.access = { apis: who ? who.split(',') : [] };
  next();
}

async function withApp(fn) {
  var r = express.Router();
  r.get('/things', requireApi('List things'), function(req, res) { res.json({ ok: true }); });
  var built = createApp(0, 'require_api_test', { auth: { middleware: gate }, log: false, routes: { '/api': r } });
  await new Promise(function(done) { built.server.listening ? done() : built.server.once('listening', done); });
  try {
    await fn(function(apis) {
      var headers = apis === undefined ? {} : { 'x-test-apis': apis };
      return fetch('http://127.0.0.1:' + built.server.address().port + '/api/things', { headers: headers })
        .then(async function(res) { return { status: res.status, body: await res.json() }; });
    });
  } finally { built.server.close(); }
}

test('a caller whose access names the route is let through', async function() {
  await withApp(async function(call) {
    assert.deepEqual(await call('List things,Other'), { status: 200, body: { ok: true } });
  });
});

test('a caller without it is refused, naming the permission', async function() {
  await withApp(async function(call) {
    var r = await call('Other');
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'Access denied: List things');
  });
});

test('no access information (mounted outside the gate) is refused, never let through', async function() {
  await withApp(async function(call) {
    var r = await call(undefined);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'NO_ACCESS_INFO');
  });
});

test('a route without a name is a mistake at startup', function() {
  assert.throws(function() { requireApi(); }, /apis row name is required/);
});
