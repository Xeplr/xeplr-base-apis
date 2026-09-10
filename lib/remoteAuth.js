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

var DEFAULT_ENDPOINT = '/auth/api/me';

// Five seconds. Long enough that a busy endpoint stops making a round trip per
// request; short enough that a logout takes effect before anyone notices.
//
// This is the one real trade in the design: a revoked token keeps working for
// up to this long in THIS process. Set 0 to check every time.
var DEFAULT_CACHE_SECONDS = 5;

// A request that hangs must not hang the caller's request with it. Failing
// closed after 5s is bad; failing closed after forever is an outage.
var DEFAULT_TIMEOUT_MS = 5000;

/**
 * @param {object} config
 * @param {string} config.url - base URL of the auth service, e.g.
 *   http://localhost:19141. NEVER defaulted: a wrong-but-present address
 *   means every request 503s, and a guessed one is worse — it could be a
 *   service that answers 200 to anything.
 * @param {string[]} [config.publicPaths] - path PREFIXES that skip the gate.
 * @param {number} [config.cacheSeconds=5] - per-process cache of validated
 *   tokens. 0 disables.
 * @param {string} [config.endpoint='/auth/api/me'] - the validation route.
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

  // token → { expires, user, access }. Per-process and deliberately not
  // shared: a cache in Redis would put back the dependency this exists to
  // remove, to save a hop it already saves.
  var cache = new Map();

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

  return async function remoteAuthMiddleware(req, res, next) {
    if (isPublic(req.path)) return next();

    var header = req.headers.authorization;
    if (!header || header.indexOf('Bearer ') !== 0) {
      return res.status(401).json({ error: 'No token provided' });
    }
    var token = header.slice('Bearer '.length);

    if (cacheSeconds > 0) {
      var hit = cache.get(token);
      if (hit && hit.expires > Date.now()) {
        req.user = hit.user;
        req.access = hit.access;
        return next();
      }
    }

    var response;
    try {
      response = await fetch(url + endpoint, {
        headers: { authorization: header },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      // FAIL CLOSED, ALWAYS. An unreachable auth service means we cannot
      // establish who this is — and "cannot establish" must never resolve to
      // "let them in". Failing open here would turn one service's outage into
      // an authentication bypass across every app that trusts this gate.
      if (req.log) req.log.error('auth unreachable: ' + err.message);
      return res.status(503).json({ error: 'Authentication service unavailable' });
    }

    if (!response.ok) {
      // The auth service's own answer, passed through unchanged. A 401 is a
      // bad token; anything else is the auth service having a problem, and
      // relabelling that as 401 would send the caller looking at their token.
      if (response.status === 401 || response.status === 403) {
        return res.status(response.status).json({ error: 'Invalid or expired token' });
      }
      if (req.log) req.log.error('auth returned ' + response.status);
      return res.status(503).json({ error: 'Authentication service unavailable' });
    }

    var body;
    try {
      body = await response.json();
    } catch (err) {
      return res.status(503).json({ error: 'Authentication service unavailable' });
    }

    req.user = body.user;
    // Permissions arrive with identity, in the same answer — so a route that
    // needs to know what this caller may do does not make a second call for
    // it.
    req.access = body.access;

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
    if (newToken) {
      res.setHeader('X-New-Token', newToken);
      // Without this a browser cannot READ the header, so forwarding it would
      // be invisible anyway — same pair @xeplr/auth sets locally.
      res.setHeader('Access-Control-Expose-Headers', 'X-New-Token');
    }

    // NOT CACHED WHEN THE TOKEN SLID. The caller is being told to switch to a
    // replacement, and caching the old one would answer its next few requests
    // from memory — without the header telling it to switch. A client that
    // missed the first one would never be told again, and would be cut off
    // when the window closed.
    if (cacheSeconds > 0 && !newToken) {
      cache.set(token, {
        user: body.user,
        access: body.access,
        expires: Date.now() + cacheSeconds * 1000
      });
    }

    next();
  };
}

module.exports = remoteAuth;
