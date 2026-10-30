// THE GATE EVERY SERVICE GETS WITHOUT ASKING FOR IT.
//
// Validates the caller's token by asking the auth service, rather than by
// verifying the signature in-process. That is the whole design decision, and
// it buys three things:
//
//   • No dependency on @xeplr/auth. It cannot be one — @xeplr/auth requires
//     THIS package to build its own server, so requiring it back would be a
//     cycle. An HTTP call needs nothing but a URL, which is what lets
//     createApp gate by default at all.
//   • No AUTH_JWT_SECRET in every app. A service that only needs to READ a
//     token no longer has to hold the secret used to MINT one, so rotating it
//     is one edit instead of one per service.
//   • No Redis in every app. Session liveness is the auth service's business.
//
// The cost is a network hop per request, which `cacheSeconds` exists to blunt
// (see below). The auth service also becomes a hard runtime dependency for
// everything — deliberately, because the alternative to "auth is down so
// nothing serves" is "auth is down so everything serves unauthenticated".

// Who the caller is AND whether they may call the API being served, in one
// answer. Every request asks both: there is no identity-only check, so an app
// cannot forget to ask about access. See @xeplr/auth's GET /verify.
var DEFAULT_ENDPOINT = '/auth/api/verify';

// Five seconds. Long enough that a busy endpoint stops making a round trip per
// request; short enough that a logout takes effect before anyone notices.
//
// This is the one real trade in the design: a revoked token keeps working for
// up to this long in THIS process. Set 0 to check every time.
var DEFAULT_CACHE_SECONDS = 5;

// A request that hangs must not hang the caller's request with it. Failing
// closed after 5s is bad; failing closed after forever is an outage.
var DEFAULT_TIMEOUT_MS = 5000;

// The 403 codes auth gives for a signed-in caller this API is refused to. Any
// other 403 is a token problem. UNLICENSED: the API's module is not in the
// caller's licence (@xeplr/auth's licence.use).
// NOT_A_MEMBER: the request names a company or workspace the caller does not
// belong to (see tenantOf).
var REFUSALS = ['DISABLED', 'HIDDEN', 'UNLICENSED', 'NOT_A_MEMBER'];
var LEVELS = ['l1', 'l2', 'l3', 'l4'];

/**
 * THE COMPANY AND WORKSPACE THIS REQUEST NAMES, for auth to check membership
 * of — in this gate, so it is checked for every request of every app built on
 * createApp, and no route can forget it (@xeplr/db's mtMiddleware would
 * otherwise trust whatever the header says). By level, as auth keeps
 * memberships: '{"l1":"<company>","l2":"<workspace>"}', or null when the app
 * registered no tenancy or the request names none. Read from the app's own
 * registerMTs(), per request.
 */
function tenantOf(req) {
  var mt;
  try { mt = require('@xeplr/db').getMtConfig(); } catch (e) { return null; }
  if (!mt || !mt.enabled) return null;
  var named = {};
  var any = false;
  LEVELS.forEach(function (level) {
    var slot = mt.slots && mt.slots[level];
    var value = slot && req.headers[slot.header];
    if (value) { named[level] = String(value); any = true; }
  });
  return any ? JSON.stringify(named) : null;
}

/**
 * @param {object} config
 * @param {string} config.url - base URL of the auth service, e.g.
 *   http://localhost:19141. NEVER defaulted: a wrong-but-present address
 *   means every request 503s, and a guessed one is worse — it could be a
 *   service that answers 200 to anything.
 * @param {string[]} [config.publicPaths] - path PREFIXES that skip the gate.
 * @param {number} [config.cacheSeconds=5] - per-process cache of validated
 *   tokens. 0 disables.
 * @param {string} [config.endpoint='/auth/api/verify'] - the validation route.
 *   It must answer the access state; one that does not (an older auth, or
 *   /me) is refused, never taken as "allowed".
 * @param {number} [config.timeoutMs=5000]
 * @returns {Function} express middleware
 */
function remoteAuth(config) {
  config = config || {};
  if (!config.url) {
    throw new Error('remoteAuth: config.url is required — the base URL of the auth service');
  }

  var url = String(config.url).replace(/\/+$/, '');
  var endpoint = config.endpoint || DEFAULT_ENDPOINT;
  var publicPaths = config.publicPaths || [];
  var timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  var cacheSeconds = config.cacheSeconds == null ? DEFAULT_CACHE_SECONDS : config.cacheSeconds;

  // token + request → { expires, outcome }. Per-process and deliberately not
  // shared: a cache in Redis would put back the dependency this exists to
  // remove, to save a hop it already saves. Keyed by the request too, because
  // the answer is about one API, not just about the token.
  var cache = new Map();

  // The same key while its answer is on the way → the same promise. A burst
  // (a dashboard firing ten widget requests at once) makes ONE call to auth,
  // and all ten get its answer: the same user, the same state, and the same
  // replacement token if it slid.
  var pending = new Map();

  if (cacheSeconds > 0) {
    // Bounded growth. Without this a process that sees many distinct tokens
    // (every user, every rotation) keeps every one of them forever.
    var sweep = setInterval(function () {
      var now = Date.now();
      cache.forEach(function (entry, token) {
        if (entry.expires <= now) cache.delete(token);
      });
    }, Math.max(cacheSeconds, 1) * 1000);
    // House rule: a timer must never be the reason a process stays alive.
    if (sweep.unref) sweep.unref();
  }

  function isPublic(path) {
    for (var i = 0; i < publicPaths.length; i++) {
      if (path === publicPaths[i] || path.indexOf(publicPaths[i]) === 0) return true;
    }
    return false;
  }

  // One call to auth → an outcome every waiter can apply.
  async function ask(header, method, path, tenant) {
    var response;
    var headers = { authorization: header, 'x-verify-method': method, 'x-verify-path': path };
    if (tenant) headers['x-verify-tenant'] = tenant;
    try {
      response = await fetch(url + endpoint, {
        headers: headers,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      // FAIL CLOSED, ALWAYS. An unreachable auth service means we cannot
      // establish who this is — and "cannot establish" must never resolve to
      // "let them in". Failing open here would turn one service's outage into
      // an authentication bypass across every app that trusts this gate.
      return { kind: 'unavailable', why: 'auth unreachable: ' + err.message };
    }

    // SLIDING REFRESH, FORWARDED.
    //
    // With a tolerance configured, the auth service serves an expired-but-
    // recent token AND mints a replacement, handing it back as X-New-Token.
    // Validating over HTTP puts that header on the auth service's reply to
    // US, where the browser will never see it — so it has to be copied onto
    // the response the caller actually receives.
    //
    // Dropping it does not fail loudly: every request keeps working until the
    // tolerance window closes, and then the user is logged out mid-session
    // with nothing in any log to connect the two.
    var newToken = response.headers.get('x-new-token');

    var body = null;
    try { body = await response.json(); } catch (err) { body = null; }

    if (response.status === 403 && body && REFUSALS.indexOf(body.code) !== -1) {
      // Signed in, but not allowed this API. The code says which, so a UI can
      // grey a disabled item out rather than treat it as missing, and tell
      // "not in your licence" from "not for your role".
      return { kind: 'refused', newToken: newToken, body: { error: body.error || 'Access denied', code: body.code } };
    }

    if (!response.ok) {
      // The auth service's own answer, passed through unchanged. A 401 is a
      // bad token; anything else is the auth service having a problem, and
      // relabelling that as 401 would send the caller looking at their token.
      if (response.status === 401 || response.status === 403) {
        return { kind: 'invalid', status: response.status };
      }
      return { kind: 'unavailable', why: 'auth returned ' + response.status };
    }

    // 200 but no access answer: this auth does not check access (an older
    // version, or an endpoint that only says who the caller is). Refused,
    // because "did not say no" is not "said yes".
    if (!body || body.state !== 'enabled') {
      return { kind: 'unavailable', why: 'auth answered without an access state; update @xeplr/auth' };
    }
    // Asked about a company and not told it was checked: an older auth that
    // ignored the question. Refused for the same reason — "did not say no" is
    // not "is a member".
    if (tenant && body.tenant !== 'checked') {
      return { kind: 'unavailable', why: 'auth did not check membership of the company named; update @xeplr/auth to 1.4 or later' };
    }

    return { kind: 'ok', newToken: newToken, user: body.user, access: body.access };
  }

  function apply(outcome, req, res, next) {
    if (outcome.newToken) {
      res.setHeader('X-New-Token', outcome.newToken);
      // Without this a browser cannot READ the header, so forwarding it would
      // be invisible anyway — same pair @xeplr/auth sets locally.
      res.setHeader('Access-Control-Expose-Headers', 'X-New-Token');
    }
    if (outcome.kind === 'ok') {
      req.user = outcome.user;
      // Permissions arrive with identity, in the same answer — so a route that
      // needs to know what this caller may do does not make a second call for
      // it.
      req.access = outcome.access;
      return next();
    }
    if (outcome.kind === 'refused') return res.status(403).json(outcome.body);
    if (outcome.kind === 'invalid') return res.status(outcome.status).json({ error: 'Invalid or expired token' });
    if (req.log) req.log.error(outcome.why);
    return res.status(503).json({ error: 'Authentication service unavailable' });
  }

  return async function remoteAuthMiddleware(req, res, next) {
    if (isPublic(req.path)) return next();

    var header = req.headers.authorization;
    if (!header || header.indexOf('Bearer ') !== 0) {
      return res.status(401).json({ error: 'No token provided' });
    }
    var token = header.slice('Bearer '.length);
    var method = req.method;
    var path = (req.baseUrl || '') + req.path;
    var tenant = tenantOf(req);
    // The answer is about this token, this request AND this company: another
    // company named with the same token is asked about afresh.
    var key = token + '\n' + method + ' ' + path + '\n' + (tenant || '');

    if (cacheSeconds > 0) {
      var hit = cache.get(key);
      if (hit && hit.expires > Date.now()) return apply(hit.outcome, req, res, next);
    }

    var inFlight = pending.get(key);
    if (!inFlight) {
      inFlight = ask(header, method, path, tenant);
      pending.set(key, inFlight);
      inFlight.then(function (outcome) {
        pending.delete(key);
        // NOT CACHED WHEN THE TOKEN SLID. The caller is being told to switch
        // to a replacement, and caching the old one would answer its next few
        // requests from memory — without the header telling it to switch. A
        // client that missed the first one would never be told again, and
        // would be cut off when the window closed.
        //
        // Only a real answer is cached: an outage or a bad token is asked
        // again next time.
        var answer = outcome.kind === 'ok' || outcome.kind === 'refused';
        if (cacheSeconds > 0 && answer && !outcome.newToken) {
          cache.set(key, { outcome: outcome, expires: Date.now() + cacheSeconds * 1000 });
        }
      });
    }
    apply(await inFlight, req, res, next);
  };
}

module.exports = remoteAuth;
module.exports.tenantOf = tenantOf;
