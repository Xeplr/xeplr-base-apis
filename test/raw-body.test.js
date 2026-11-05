// rawBodyPaths: a webhook's signature is computed over the bytes it sent, and
// JSON.stringify(req.body) is not those bytes. Through the real createApp, so
// the parsers are the ones every app runs.

var test = require('node:test');
var assert = require('node:assert');
var crypto = require('node:crypto');
var express = require('express');
var createApp = require('../express');

var SECRET = 'whsec_test';

function routes() {
  var r = express.Router();
  function echo(req, res) {
    res.json({
      raw: Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : null,
      body: Buffer.isBuffer(req.body) ? 'buffer' : req.body,
      signed: Buffer.isBuffer(req.rawBody) &&
        crypto.createHmac('sha256', SECRET).update(req.rawBody).digest('hex') === req.headers['x-signature']
    });
  }
  r.post('/hooks/pay', echo);
  r.post('/other', echo);
  return { '/': r };
}

var PORT = 21300;
async function withApp(fn) {
  var port = PORT++;
  var built = createApp(port, 'raw_body_test', { auth: false, log: false, rawBodyPaths: ['/hooks/'], routes: routes() });
  try {
    await new Promise(function (r) { built.server.listening ? r() : built.server.once('listening', r); });
    return await fn(function (path, body, type) {
      return fetch('http://127.0.0.1:' + port + path, {
        method: 'POST',
        headers: { 'content-type': type || 'application/json', 'x-signature': crypto.createHmac('sha256', SECRET).update(body).digest('hex') },
        body: body
      }).then(function (res) { return res.json(); });
    });
  } finally {
    built.server.close();
  }
}

// Spaced, keys out of order, a number written as 1.50: what a provider may send.
var SENT = '{ "type":"paid",  "amount": 1.50, "id":"evt_1" }';

test('a rawBodyPaths route gets the exact bytes, and the parsed body too', async function () {
  await withApp(async function (post) {
    var r = await post('/hooks/pay', SENT);
    assert.strictEqual(r.raw, SENT);
    assert.deepStrictEqual(r.body, { type: 'paid', amount: 1.5, id: 'evt_1' });
    assert.strictEqual(r.signed, true);
  });
});

test('re-serialising the parsed body would not have matched the signature', function () {
  var again = JSON.stringify(JSON.parse(SENT));
  assert.notStrictEqual(crypto.createHmac('sha256', SECRET).update(again).digest('hex'),
    crypto.createHmac('sha256', SECRET).update(SENT).digest('hex'));
});

test('a type neither parser reads is kept as rawBody', async function () {
  await withApp(async function (post) {
    var r = await post('/hooks/pay', 'event=paid&id=1;v=2', 'text/plain');
    assert.strictEqual(r.raw, 'event=paid&id=1;v=2');
    assert.strictEqual(r.signed, true);
  });
});

test('a form body is parsed and kept', async function () {
  await withApp(async function (post) {
    var r = await post('/hooks/pay', 'event=paid&id=1', 'application/x-www-form-urlencoded');
    assert.strictEqual(r.raw, 'event=paid&id=1');
    assert.deepStrictEqual(r.body, { event: 'paid', id: '1' });
  });
});

test('any other path keeps only its parsed body', async function () {
  await withApp(async function (post) {
    var r = await post('/other', SENT);
    assert.strictEqual(r.raw, null);
    assert.deepStrictEqual(r.body, { type: 'paid', amount: 1.5, id: 'evt_1' });
  });
});
