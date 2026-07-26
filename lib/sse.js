// Server-Sent Events (SSE) — one-way server → UI push over HTTP.
// Cluster-aware from day one: publish() fans out locally AND across all
// workers via the existing `broadcast()` primitive, so a completion event
// fired on worker N reaches subscribers connected to worker M.
//
// Two handler variants:
//
//   sse.handler                     — legacy, unauthenticated.
//                                     Kept for dev, tests, private networks.
//                                     Do NOT expose on a public endpoint.
//
//   sse.createHandler({             — production. Requires a ticket.
//     validateTicket,                 Owns auth-on-connect + per-topic auth.
//     authorizeTopics?
//   })
//
// PRODUCTION FLOW (with ticket auth):
//   1. Client is authenticated by your normal auth layer (session cookie /
//      JWT / whatever). Client POSTs to a ticket endpoint provided by
//      xeplr-auth (or any provider) → gets a short-lived, single-use ticket.
//   2. Client opens EventSource('/events?ticket=<tk>&topics=user:me:jobs').
//   3. sse.createHandler calls validateTicket(tk):
//        · returns { userId, scopes } on success
//        · returns null on invalid / expired / already-consumed
//   4. authorizeTopics(payload, requestedTopics) filters the requested
//      topics against the ticket's scopes. Rewrites `user:me:*` →
//      `user:<userId>:*`. Rejects out-of-scope.
//   5. Only if any topics survive does the SSE connection open.
//
// AUTHORIZATION is where teams cut corners — the auth check on connect is
// easy; the per-topic check is where users end up subscribing to
// `user:other_user:jobs` and leaking data. Do NOT trust client-supplied
// topics verbatim. The default authorizeTopics enforces sane rules; supply
// your own only if you know why you're overriding.
//
// PUBLISH:
//   sse.publish('user:42:jobs', { jobId, status });
//   Cluster-aware: fires on this worker + relays to all others.
//
// CLIENT:
//   var events = new EventSource('/events?ticket=<tk>&topics=user:me:jobs');
//   events.onmessage = function(e) {
//     var { topic, data } = JSON.parse(e.data);
//     // ...
//   };

var cluster = require('cluster');
var { broadcast } = require('./cluster');

// topic → Set<res> — local subscribers on THIS worker/process
var _subs = new Map();

// How often to send a keep-alive comment (proxies close idle conns silently)
var HEARTBEAT_MS = 25000;

// Cluster message discriminator so we don't confuse other broadcasts
var TAG = '__xeplrSse';

/**
 * Attach a Response to an authorized set of topics. This is the shared
 * inner core — both the legacy `handler` and the auth'd `createHandler`
 * call this after they've decided which topics the client gets.
 *
 * On disconnect, all subscriptions are cleaned up automatically.
 */
function attachStream(req, res, topics) {
  res.setHeader('Content-Type',        'text/event-stream');
  res.setHeader('Cache-Control',       'no-cache, no-transform');
  res.setHeader('Connection',          'keep-alive');
  res.setHeader('X-Accel-Buffering',   'no');       // nginx: don't buffer
  res.flushHeaders();

  topics.forEach(function(t) {
    if (!_subs.has(t)) _subs.set(t, new Set());
    _subs.get(t).add(res);
  });

  // Initial comment lets the client know the stream is open
  res.write(': connected ' + Date.now() + '\n\n');

  // Heartbeat — SSE comment lines are silently ignored by EventSource
  var heartbeat = setInterval(function() {
    try { res.write(': keepalive\n\n'); }
    catch (_) { /* stream closed */ }
  }, HEARTBEAT_MS);
  if (heartbeat && heartbeat.unref) heartbeat.unref();

  var cleanedUp = false;
  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeat);
    topics.forEach(function(t) {
      var set = _subs.get(t);
      if (!set) return;
      set.delete(res);
      if (set.size === 0) _subs.delete(t);
    });
  }
  req.on('close', cleanup);
  res.on('close', cleanup);
}

function parseTopics(req) {
  var topicsParam = (req.query && req.query.topics) || '';
  return String(topicsParam).split(',').map(function(t) { return t.trim(); }).filter(Boolean);
}

/**
 * LEGACY handler — no auth. Kept for tests + private networks.
 * DO NOT expose on a public endpoint. Use createHandler() there.
 */
function handler(req, res) {
  var topics = parseTopics(req);
  if (topics.length === 0) {
    return res.status(400).json({ error: 'topics query parameter required (e.g. ?topics=job:1,movement:2)' });
  }
  return attachStream(req, res, topics);
}

/**
 * PRODUCTION handler factory. Requires a ticket. Returns an Express
 * handler that:
 *   1. Reads ?ticket=... from query
 *   2. Calls opts.validateTicket(ticket) → { userId, scopes } | null
 *   3. Calls opts.authorizeTopics(payload, requestedTopics) → allowed[]
 *      (default policy: rewrite user:me:* → user:<uid>:*, enforce scopes)
 *   4. Attaches the stream ONLY to the intersection
 *
 * @param {object}   opts
 * @param {Function} opts.validateTicket    — async (ticket) => payload | null
 * @param {Function} [opts.authorizeTopics] — (payload, requested[]) => allowed[]
 * @returns {Function} Express handler
 */
function createHandler(opts) {
  opts = opts || {};
  if (typeof opts.validateTicket !== 'function') {
    throw new Error('sse.createHandler: opts.validateTicket is required (pass ticketService.consumeTicket from xeplr-auth, or your own).');
  }
  var validateTicket  = opts.validateTicket;
  var authorizeTopics = opts.authorizeTopics || defaultAuthorizeTopics;

  return async function(req, res) {
    var ticket = req.query && req.query.ticket;
    if (!ticket) {
      return res.status(401).json({ error: 'ticket query parameter required' });
    }
    var requested = parseTopics(req);
    if (requested.length === 0) {
      return res.status(400).json({ error: 'topics query parameter required (e.g. ?topics=user:me:jobs)' });
    }

    var payload;
    try { payload = await validateTicket(ticket); }
    catch (_) { return res.status(500).json({ error: 'ticket validation failed' }); }
    if (!payload) return res.status(401).json({ error: 'invalid or expired ticket' });

    var allowed;
    try { allowed = authorizeTopics(payload, requested) || []; }
    catch (_) { return res.status(500).json({ error: 'topic authorization failed' }); }
    if (!allowed.length) {
      return res.status(403).json({ error: 'no requested topics are authorized' });
    }

    return attachStream(req, res, allowed);
  };
}

// ── default authorization policy ─────────────────────────────────────────
//
// Consumers pass a `scopes` array in the ticket payload. Scopes are glob
// patterns; `user:me:*` is a well-known shorthand for "the authenticated
// user's own namespace" and is rewritten to `user:<userId>:*`.
//
// Every requested topic must:
//   · match at least ONE scope pattern (after rewrite), AND
//   · if the topic starts with `user:`, the userId segment must match
//     the authenticated user (defense in depth against a scope that
//     accidentally allows `user:*:jobs`)
//
// Returns the allowed subset. Topics that fail either check are dropped
// silently — the handler decides how to respond when the result is empty.
function defaultAuthorizeTopics(payload, requested) {
  var uid = String(payload && payload.userId);
  if (!uid) return [];
  var scopes = (payload && Array.isArray(payload.scopes) && payload.scopes.length)
    ? payload.scopes
    : ['user:me:*'];

  var rewrittenScopes = scopes.map(function(s) {
    return s.replace(/user:me:/g, 'user:' + uid + ':');
  });

  return requested
    .map(function(t) { return t.replace(/^user:me:/, 'user:' + uid + ':'); })
    .filter(function(t) {
      // Never allow accessing another user's namespace, regardless of scope.
      var m = t.match(/^user:([^:]+):/);
      if (m && m[1] !== uid) return false;
      return rewrittenScopes.some(function(scope) { return globMatch(scope, t); });
    });
}

function globMatch(pattern, topic) {
  var parts = pattern.split('*').map(escapeRegExp);
  return new RegExp('^' + parts.join('.*') + '$').test(topic);
}

function escapeRegExp(s) { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Push an event to every subscriber of `topic`, on this worker AND across
 * the cluster. Same API whether you're in a single-process app, a worker,
 * or the primary.
 */
function publish(topic, data) {
  publishLocal(topic, data);

  if (cluster.isPrimary) {
    // If workers exist, hand the event to each one. If they don't (single
    // process), this loop is a no-op.
    var workers = cluster.workers || {};
    Object.keys(workers).forEach(function(id) {
      var w = workers[id];
      if (w && !w.isDead()) {
        try { w.send(taggedMessage(topic, data)); } catch (_) {}
      }
    });
  } else if (process.send) {
    // In a worker: relay through the primary to all OTHER workers.
    // (This process's local subscribers were already written above.)
    broadcast(taggedMessage(topic, data));
  }
}

// Fan out to LOCAL subscribers only. Used by both publish() and the
// cluster-message receiver below.
function publishLocal(topic, data) {
  var set = _subs.get(topic);
  if (!set || set.size === 0) return;
  var payload = 'data: ' + JSON.stringify({ topic: topic, data: data }) + '\n\n';
  set.forEach(function(res) {
    try { res.write(payload); }
    catch (_) { /* write failed — cleanup runs on close */ }
  });
}

function taggedMessage(topic, data) {
  var msg = { topic: topic, data: data };
  msg[TAG] = true;
  return msg;
}

// Install the cluster message receiver once at module load. Idempotent.
// Runs in every worker (and harmlessly in single-process mode where
// process.on('message') never fires without a parent).
var _installed = false;
function installReceiver() {
  if (_installed) return;
  _installed = true;
  process.on('message', function(msg) {
    if (msg && msg[TAG]) publishLocal(msg.topic, msg.data);
  });
}
installReceiver();

// ── test-only helpers ────────────────────────────────────────────────────
function _reset() {
  _subs.forEach(function(set) {
    set.forEach(function(res) { try { res.end(); } catch (_) {} });
  });
  _subs.clear();
}
function _stats() {
  var out = { topics: {}, totalConnections: 0 };
  _subs.forEach(function(set, topic) {
    out.topics[topic] = set.size;
    out.totalConnections += set.size;
  });
  return out;
}

module.exports = {
  handler:                 handler,           // legacy — unauthenticated
  createHandler:           createHandler,     // production — ticket auth
  defaultAuthorizeTopics:  defaultAuthorizeTopics,  // exported for reuse in custom policies
  publish:                 publish,
  _reset:                  _reset,
  _stats:                  _stats
};
