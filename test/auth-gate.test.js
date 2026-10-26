// The gate createApp applies by default. These tests exist because the failure
// this guards against is SILENT: a service with no auth configured used to
// boot clean, pass every health check, and serve every route to anybody.
// Nothing about a working app and a wide-open one looked different.

var test = require('node:test');
var assert = require('node:assert');
var express = require('express');
var createApp = require('../express');

var VALID = 'valid-token';

// A stand-in for @xeplr/auth's /auth/api/verify. Answers 200 (state enabled)
// for one known token and 401 for anything else, and counts how often it was
// asked — which is how the cache test observes the cache without reaching
// inside it.
function startFakeAuth() {
  return new Promise(function (resolve) {
    var calls = 0;
    var app = express();
    app.get('/auth/api/verify', function (req, res) {
      calls++;
      if (req.headers.authorization === 'Bearer ' + VALID) {
        return res.json({ user: { id: 'u1', email: 'a@b.c' }, access: { roles: ['Admin'] }, state: 'enabled' });
      }
      res.status(401).json({ error: 'Invalid or expired token' });
    });
    var server = app.listen(0, function () {
      resolve({
        url: 'http://127.0.0.1:' + server.address().port,
        calls: function () { return calls; },
        close: function () { return new Promise(function (r) { server.close(r); }); }
      });
    });
  });
}

function routes() {
  var r = express.Router();
  r.get('/', function (req, res) { res.json({ ok: true, user: req.user || null }); });
  r.get('/public/ping', function (req, res) { res.json({ ok: true }); });
  return { '/': r };
}

function makeApp(port, options) {
  // log:false — these tests are not about the logger, and leaving it on writes
  // a log directory per run.
  options.log = false;
  options.routes = routes();
  return createApp(port, 'test_api', options);
}

var PORT = 21100;
function nextPort() { return PORT++; }

test('no auth configured and no AUTH_URL → createApp REFUSES to boot', function () {
  var saved = process.env.AUTH_URL;
  delete process.env.AUTH_URL;
  try {
    assert.throws(
      function () { makeApp(nextPort(), {}); },
      /auth is on by default/,
      'an app with no auth answer must not start'
    );
  } finally {
    if (saved) process.env.AUTH_URL = saved;
  }
});

test('auth: false → public on purpose, and it actually serves', async function () {
  var port = nextPort();
  var built = makeApp(port, { auth: false });
  try {
    var res = await fetch('http://127.0.0.1:' + port + '/');
    assert.strictEqual(res.status, 200);
  } finally {
    built.server.close();
  }
});

test('gated: no token → 401', async function () {
  var auth = await startFakeAuth();
  var port = nextPort();
  var built = makeApp(port, { auth: { url: auth.url, cacheSeconds: 0 } });
  try {
    var res = await fetch('http://127.0.0.1:' + port + '/');
    assert.strictEqual(res.status, 401);
    assert.strictEqual((await res.json()).error, 'No token provided');
  } finally {
    built.server.close();
    await auth.close();
  }
});

test('gated: bad token → 401', async function () {
  var auth = await startFakeAuth();
  var port = nextPort();
  var built = makeApp(port, { auth: { url: auth.url, cacheSeconds: 0 } });
  try {
    var res = await fetch('http://127.0.0.1:' + port + '/', {
      headers: { authorization: 'Bearer nonsense' }
    });
    assert.strictEqual(res.status, 401);
  } finally {
    built.server.close();
    await auth.close();
  }
});

test('gated: valid token → 200, and req.user is populated', async function () {
  var auth = await startFakeAuth();
  var port = nextPort();
  var built = makeApp(port, { auth: { url: auth.url, cacheSeconds: 0 } });
  try {
    var res = await fetch('http://127.0.0.1:' + port + '/', {
      headers: { authorization: 'Bearer ' + VALID }
    });
    assert.strictEqual(res.status, 200);
    var body = await res.json();
    assert.strictEqual(body.user.email, 'a@b.c');
  } finally {
    built.server.close();
    await auth.close();
  }
});

test('publicPaths skip the gate', async function () {
  var auth = await startFakeAuth();
  var port = nextPort();
  var built = makeApp(port, { auth: { url: auth.url, publicPaths: ['/public/'], cacheSeconds: 0 } });
  try {
    var open = await fetch('http://127.0.0.1:' + port + '/public/ping');
    assert.strictEqual(open.status, 200, '/public/* must not need a token');

    var closed = await fetch('http://127.0.0.1:' + port + '/');
    assert.strictEqual(closed.status, 401, 'everything else still does');
  } finally {
    built.server.close();
    await auth.close();
  }
});

test('auth service unreachable → 503, NEVER served', async function () {
  var auth = await startFakeAuth();
  var url = auth.url;
  await auth.close();          // gone before the request is made

  var port = nextPort();
  var built = makeApp(port, { auth: { url: url, cacheSeconds: 0, timeoutMs: 1000 } });
  try {
    var res = await fetch('http://127.0.0.1:' + port + '/', {
      headers: { authorization: 'Bearer ' + VALID }
    });
    // The whole point: an auth outage must not become an auth bypass.
    assert.strictEqual(res.status, 503);
    assert.notStrictEqual(res.status, 200);
  } finally {
    built.server.close();
  }
});

test('cacheSeconds collapses repeat validations into one', async function () {
  var auth = await startFakeAuth();
  var port = nextPort();
  var built = makeApp(port, { auth: { url: auth.url, cacheSeconds: 30 } });
  try {
    for (var i = 0; i < 5; i++) {
      var res = await fetch('http://127.0.0.1:' + port + '/', {
        headers: { authorization: 'Bearer ' + VALID }
      });
      assert.strictEqual(res.status, 200);
    }
    assert.strictEqual(auth.calls(), 1, '5 requests, one validation');
  } finally {
    built.server.close();
    await auth.close();
  }
});

test('cacheSeconds: 0 validates every time', async function () {
  var auth = await startFakeAuth();
  var port = nextPort();
  var built = makeApp(port, { auth: { url: auth.url, cacheSeconds: 0 } });
  try {
    for (var i = 0; i < 3; i++) {
      await fetch('http://127.0.0.1:' + port + '/', {
        headers: { authorization: 'Bearer ' + VALID }
      });
    }
    assert.strictEqual(auth.calls(), 3);
  } finally {
    built.server.close();
    await auth.close();
  }
});

test('auth.middleware: a caller-supplied gate replaces the HTTP one', async function () {
  var port = nextPort();
  var seen = false;
  var built = makeApp(port, {
    auth: {
      middleware: function (req, res, next) {
        seen = true;
        if (req.headers['x-secret'] === 'ok') { req.user = { id: 'custom' }; return next(); }
        res.status(401).json({ error: 'nope' });
      }
    }
  });
  try {
    var denied = await fetch('http://127.0.0.1:' + port + '/');
    assert.strictEqual(denied.status, 401);

    var allowed = await fetch('http://127.0.0.1:' + port + '/', { headers: { 'x-secret': 'ok' } });
    assert.strictEqual(allowed.status, 200);
    assert.strictEqual((await allowed.json()).user.id, 'custom');
    assert.ok(seen);
  } finally {
    built.server.close();
  }
});

test('AUTH_URL from the environment is used when no url is passed', async function () {
  var auth = await startFakeAuth();
  var saved = process.env.AUTH_URL;
  process.env.AUTH_URL = auth.url;
  var port = nextPort();
  var built = makeApp(port, { auth: { cacheSeconds: 0 } });
  try {
    var res = await fetch('http://127.0.0.1:' + port + '/', {
      headers: { authorization: 'Bearer ' + VALID }
    });
    assert.strictEqual(res.status, 200);
  } finally {
    built.server.close();
    await auth.close();
    if (saved) process.env.AUTH_URL = saved; else delete process.env.AUTH_URL;
  }
});

// ── sliding refresh ──────────────────────────────────────────────────────
//
// The auth service can serve an expired-but-recent token and mint a
// replacement, returned as X-New-Token. Validating over HTTP puts that header
// on the auth service's reply to the GATE, not to the browser — so it has to
// be forwarded, and the failure if it isn't is silent: everything works until
// the tolerance window closes and the user is logged out mid-session.

var SLIDING = 'sliding-token';

function startSlidingAuth() {
  return new Promise(function (resolve) {
    var calls = 0;
    var app = express();
    app.get('/auth/api/verify', function (req, res) {
      calls++;
      res.setHeader('X-New-Token', 'refreshed-token');
      res.setHeader('Access-Control-Expose-Headers', 'X-New-Token');
      // Slow enough that a burst is all in flight together.
      setTimeout(function () { res.json({ user: { id: 'u1' }, access: { roles: [] }, state: 'enabled' }); }, 50);
    });
    var server = app.listen(0, function () {
      resolve({
        url: 'http://127.0.0.1:' + server.address().port,
        calls: function () { return calls; },
        close: function () { return new Promise(function (r) { server.close(r); }); }
      });
    });
  });
}

test('X-New-Token is forwarded to the caller', async function () {
  var auth = await startSlidingAuth();
  var port = nextPort();
  var built = makeApp(port, { auth: { url: auth.url, cacheSeconds: 30 } });
  try {
    var res = await fetch('http://127.0.0.1:' + port + '/', {
      headers: { authorization: 'Bearer ' + SLIDING }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-new-token'), 'refreshed-token',
      'the replacement token must reach the caller, not stop at the gate');
    assert.match(res.headers.get('access-control-expose-headers') || '', /X-New-Token/,
      'without this a browser cannot read the header at all');
  } finally {
    built.server.close();
    await auth.close();
  }
});

test('a slid token is NOT cached — every request keeps being told to refresh', async function () {
  var auth = await startSlidingAuth();
  var port = nextPort();
  var built = makeApp(port, { auth: { url: auth.url, cacheSeconds: 30 } });
  try {
    for (var i = 0; i < 3; i++) {
      var res = await fetch('http://127.0.0.1:' + port + '/', {
        headers: { authorization: 'Bearer ' + SLIDING }
      });
      assert.strictEqual(res.headers.get('x-new-token'), 'refreshed-token');
    }
    // Cached, the 2nd and 3rd would have been served from memory with no
    // header — and a client that missed the first would never be told again.
    assert.strictEqual(auth.calls(), 3, 'a sliding response must not be cached');
  } finally {
    built.server.close();
    await auth.close();
  }
});

test('a burst of requests with a sliding token makes ONE call, and every one gets the new token', async function () {
  var auth = await startSlidingAuth();
  var port = nextPort();
  var built = makeApp(port, { auth: { url: auth.url, cacheSeconds: 30 } });
  try {
    var all = await Promise.all(Array.from({ length: 10 }, function () {
      return fetch('http://127.0.0.1:' + port + '/', { headers: { authorization: 'Bearer ' + SLIDING } });
    }));
    all.forEach(function (res) {
      assert.strictEqual(res.status, 200, 'none rejected because the token changed');
      assert.strictEqual(res.headers.get('x-new-token'), 'refreshed-token');
    });
    assert.strictEqual(auth.calls(), 1, 'ten at once, one refresh');
  } finally {
    built.server.close();
    await auth.close();
  }
});

// ── access, on every request ─────────────────────────────────────────────
//
// The gate never asks "who is this" alone: it names the request it is
// serving, and auth answers the access state for it.

function startAccessAuth(answer) {
  return new Promise(function (resolve) {
    var seen = [];
    var app = express();
    app.get('/auth/api/verify', function (req, res) {
      seen.push([req.headers['x-verify-method'], req.headers['x-verify-path']]);
      setTimeout(function () { answer(req, res); }, 30);
    });
    var server = app.listen(0, function () {
      resolve({
        url: 'http://127.0.0.1:' + server.address().port,
        seen: function () { return seen; },
        close: function () { return new Promise(function (r) { server.close(r); }); }
      });
    });
  });
}

test('the gate names the request it is serving', async function () {
  var auth = await startAccessAuth(function (req, res) { res.json({ user: { id: 'u1' }, access: {}, state: 'enabled' }); });
  var port = nextPort();
  var built = makeApp(port, { auth: { url: auth.url, cacheSeconds: 0 } });
  try {
    await fetch('http://127.0.0.1:' + port + '/?x=1', { headers: { authorization: 'Bearer ' + VALID } });
    assert.deepStrictEqual(auth.seen(), [['GET', '/']]);
  } finally {
    built.server.close();
    await auth.close();
  }
});

test('disabled, hidden and unlicensed are refused with their codes', async function () {
  var code = 'DISABLED';
  var auth = await startAccessAuth(function (req, res) { res.status(403).json({ error: 'no', code: code }); });
  var port = nextPort();
  var built = makeApp(port, { auth: { url: auth.url, cacheSeconds: 0 } });
  try {
    var res = await fetch('http://127.0.0.1:' + port + '/', { headers: { authorization: 'Bearer ' + VALID } });
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await res.json()).code, 'DISABLED');
    code = 'HIDDEN';
    res = await fetch('http://127.0.0.1:' + port + '/', { headers: { authorization: 'Bearer ' + VALID } });
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await res.json()).code, 'HIDDEN');
    code = 'UNLICENSED';
    res = await fetch('http://127.0.0.1:' + port + '/', { headers: { authorization: 'Bearer ' + VALID } });
    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(await res.json(), { error: 'no', code: 'UNLICENSED' }, 'passed on, not relabelled as a bad token');
  } finally {
    built.server.close();
    await auth.close();
  }
});

test('an auth that answers without an access state is refused, never taken as allowed', async function () {
  var auth = await startAccessAuth(function (req, res) { res.json({ user: { id: 'u1' }, access: {} }); });
  var port = nextPort();
  var built = makeApp(port, { auth: { url: auth.url, cacheSeconds: 0 } });
  try {
    var res = await fetch('http://127.0.0.1:' + port + '/', { headers: { authorization: 'Bearer ' + VALID } });
    assert.strictEqual(res.status, 503);
  } finally {
    built.server.close();
    await auth.close();
  }
});

test('a burst of the same request shares one check, even with the cache off', async function () {
  var auth = await startAccessAuth(function (req, res) { res.json({ user: { id: 'u1' }, access: {}, state: 'enabled' }); });
  var port = nextPort();
  var built = makeApp(port, { auth: { url: auth.url, cacheSeconds: 0 } });
  try {
    var all = await Promise.all(Array.from({ length: 10 }, function () {
      return fetch('http://127.0.0.1:' + port + '/', { headers: { authorization: 'Bearer ' + VALID } });
    }));
    all.forEach(function (res) { assert.strictEqual(res.status, 200); });
    assert.strictEqual(auth.seen().length, 1);
  } finally {
    built.server.close();
    await auth.close();
  }
});
