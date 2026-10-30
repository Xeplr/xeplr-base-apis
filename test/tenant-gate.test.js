// THE GATE CHECKS THE COMPANY TOO. Every request of every app on createApp
// that names a company or workspace is asked about at auth's /verify, which
// refuses a caller who does not belong to it — so no route can forget, and the
// tenant every query and file path reads can be trusted. Then uploads and
// served files are each company's own: uploadRoute's default folder and
// sendTenantFile, on a real folder, with a real multipart upload.
//
// The auth service here answers as @xeplr/auth's /verify does (its own tests
// check that answer on real memberships, test/verifyTenant.test.js); this
// file checks what the GATE does with it.
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var express = require('express');
var db = require('@xeplr/db');
var createApp = require('../express');
var { uploadRoute, sendTenantFile } = require('..');

var DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'base-apis-data-')));
process.env.XEPLR_DATA_DIR = DATA;
db.registerApplication('base-apis-test');
db.registerMTs({ l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } });

// u1 belongs to acme/w1 only.
function startAuth(opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    var asked = [];
    var app = express();
    app.get('/auth/api/verify', function (req, res) {
      var tenant = req.headers['x-verify-tenant'] ? JSON.parse(req.headers['x-verify-tenant']) : null;
      asked.push(tenant);
      if (tenant && (tenant.l1 !== 'acme' || (tenant.l2 && tenant.l2 !== 'w1'))) {
        return res.status(403).json({ error: 'Not a member of l1 "' + tenant.l1 + '"', code: 'NOT_A_MEMBER' });
      }
      var body = { user: { id: 'u1' }, access: {}, state: 'enabled' };
      if (tenant && !opts.old) body.tenant = 'checked';
      res.json(body);
    });
    var server = app.listen(0, function () {
      resolve({ url: 'http://127.0.0.1:' + server.address().port, asked: function () { return asked; }, close: function () { return new Promise(function (r) { server.close(r); }); } });
    });
  });
}

var PORT = 21300;
function makeApp(authUrl, routes, cacheSeconds) {
  var port = PORT++;
  var built = createApp(port, 'tenant_test', {
    log: false, auth: { url: authUrl, cacheSeconds: cacheSeconds || 0 }, middleware: [db.mtMiddleware()], routes: routes
  });
  return { built: built, base: 'http://127.0.0.1:' + port };
}

function call(base, url, company, workspace, init) {
  var headers = Object.assign({ authorization: 'Bearer t' }, company ? { 'x-company-id': company } : {}, workspace ? { 'x-workspace-id': workspace } : {});
  return fetch(base + url, Object.assign({}, init || {}, { headers: Object.assign(headers, (init && init.headers) || {}) }));
}

test('a company the caller belongs to passes; another is refused before the app sees it', async function () {
  var auth = await startAuth();
  var reached = 0;
  var r = express.Router();
  r.get('/thing', function (req, res) { reached++; res.json({ ok: true }); });
  var app = makeApp(auth.url, { '/': r });
  try {
    assert.strictEqual((await call(app.base, '/thing', 'acme', 'w1')).status, 200);
    assert.deepStrictEqual(auth.asked()[0], { l1: 'acme', l2: 'w1' }, 'the gate named the company and workspace, by level');
    var other = await call(app.base, '/thing', 'beta', 'w1');
    assert.strictEqual(other.status, 403);
    assert.strictEqual((await other.json()).code, 'NOT_A_MEMBER');
    assert.strictEqual((await call(app.base, '/thing', 'acme', 'w2')).status, 403, 'another workspace of the same company');
    assert.strictEqual(reached, 1, 'the app never saw the refused requests');
    assert.strictEqual((await call(app.base, '/thing')).status, 200, 'a request naming none is not asked about one');
    assert.strictEqual(auth.asked()[auth.asked().length - 1], null);
  } finally { app.built.server.close(); await auth.close(); }
});

test('an auth that does not say it checked is refused, never taken as a member', async function () {
  var auth = await startAuth({ old: true });
  var r = express.Router();
  r.get('/thing', function (req, res) { res.json({ ok: true }); });
  var app = makeApp(auth.url, { '/': r });
  try {
    assert.strictEqual((await call(app.base, '/thing', 'acme', 'w1')).status, 503);
  } finally { app.built.server.close(); await auth.close(); }
});

test('the cached answer is per company: the same token naming another is asked about afresh', async function () {
  var auth = await startAuth();
  var r = express.Router();
  r.get('/thing', function (req, res) { res.json({ ok: true }); });
  var app = makeApp(auth.url, { '/': r }, 30);
  try {
    assert.strictEqual((await call(app.base, '/thing', 'acme', 'w1')).status, 200);
    assert.strictEqual((await call(app.base, '/thing', 'acme', 'w1')).status, 200);
    assert.strictEqual(auth.asked().length, 1, 'the same company: answered from the cache');
    assert.strictEqual((await call(app.base, '/thing', 'beta', 'w1')).status, 403, 'not let through on acme\'s cached answer');
  } finally { app.built.server.close(); await auth.close(); }
});

test('an upload with no folder named lands in the company\'s own uploads/, and comes back only to it', async function () {
  var auth = await startAuth();
  var r = express.Router();
  r.use('/up', uploadRoute());
  r.get('/files/:name', function (req, res) { sendTenantFile(res, 'uploads/' + req.params.name); });
  var app = makeApp(auth.url, { '/': r });
  try {
    var form = new FormData();
    form.append('file', new Blob(['plan']), 'plan.pdf');
    var up = await (await call(app.base, '/up', 'acme', 'w1', { method: 'POST', body: form })).json();
    assert.strictEqual(path.dirname(up.filePath), path.join(DATA, 'base-apis-test', 'acme', 'w1', 'uploads'), up.filePath);
    var mine = await call(app.base, '/files/' + up.fileName, 'acme', 'w1');
    assert.strictEqual(mine.status, 200);
    assert.strictEqual(await mine.text(), 'plan');
  } finally { app.built.server.close(); await auth.close(); }
});

test('createApp\'s own upload: no longer served to anyone — signed in, from the company\'s own uploads/', async function () {
  var auth = await startAuth();
  var port = PORT++;
  var built = createApp(port, 'tenant_test', {
    log: false, auth: { url: auth.url, cacheSeconds: 0 }, middleware: [db.mtMiddleware()], upload: {}, routes: { '/': express.Router() }
  });
  var base = 'http://127.0.0.1:' + port;
  try {
    var form = new FormData();
    form.append('file', new Blob(['roadmap']), 'roadmap.pdf');
    var up = await (await call(base, '/internal/upload', 'acme', 'w1', { method: 'POST', body: form })).json();
    assert.ok(fs.existsSync(path.join(DATA, 'base-apis-test', 'acme', 'w1', 'uploads', up.filename)), 'in the company\'s own uploads/');
    assert.strictEqual((await fetch(base + '/uploads/' + up.filename)).status, 401, 'with no sign-in: refused (it used to be served to anyone)');
    assert.strictEqual((await call(base, '/uploads/' + up.filename, 'beta', 'w1')).status, 403, 'another company: refused at the gate');
    var mine = await call(base, '/uploads/' + up.filename, 'acme', 'w1');
    assert.strictEqual(mine.status, 200);
    assert.strictEqual(await mine.text(), 'roadmap');
  } finally { built.server.close(); await auth.close(); }
});

test('sendTenantFile: another company\'s name finds nothing; a path out is refused; no company has no files', async function () {
  var acme = db.runWithMt({ mtId1: 'acme', mtId2: 'w1' }, function () { return db.dataDir.tenantFolder(); });
  fs.mkdirSync(path.join(acme, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(acme, 'uploads', 'secret.pdf'), 'acme');
  function serve(mt, name) {
    return new Promise(function (resolve) {
      var res = {
        _s: 200,
        status: function (s) { this._s = s; return this; },
        json: function (b) { resolve({ status: this._s, body: b }); },
        sendFile: function (f) { resolve({ status: 200, file: f }); },
        download: function (f) { resolve({ status: 200, file: f, download: true }); }
      };
      if (mt) db.runWithMt(mt, function () { sendTenantFile(res, name); }); else sendTenantFile(res, name);
    });
  }
  assert.strictEqual((await serve({ mtId1: 'acme', mtId2: 'w1' }, 'uploads/secret.pdf')).file, path.join(acme, 'uploads', 'secret.pdf'));
  assert.strictEqual((await serve({ mtId1: 'beta', mtId2: 'w1' }, 'uploads/secret.pdf')).status, 404, 'the same name is not acme\'s file');
  assert.strictEqual((await serve({ mtId1: 'beta', mtId2: 'w1' }, '../../acme/w1/uploads/secret.pdf')).status, 400);
  assert.strictEqual((await serve({ mtId1: 'beta', mtId2: 'w1' }, path.join(acme, 'uploads', 'secret.pdf'))).status, 400);
  var none = await serve(null, 'uploads/secret.pdf');
  assert.strictEqual(none.status, 400);
  assert.strictEqual(none.body.code, 'NO_TENANT');
});

test.after(function () { fs.rmSync(DATA, { recursive: true, force: true }); });
