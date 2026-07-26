// SSE with ticket auth — tests for sse.createHandler({validateTicket, authorizeTopics}).
//
// The ticket validator is a plain async function returning { userId, scopes }
// or null. In production this is xeplr-auth's ticketService.consumeTicket
// (Redis-backed, atomic GETDEL). Here we use an in-memory fake so the
// tests don't need Redis.
//
// Coverage:
//   1. missing ticket           → 401
//   2. missing topics           → 400
//   3. invalid/expired ticket   → 401
//   4. ticket returns error     → 500
//   5. ticket OK, all topics in scope → attaches + receives events
//   6. user:me:* is rewritten to user:<uid>:*
//   7. cross-user topic (user:other:jobs) is rejected → 403 when nothing survives
//   8. mixed scoped/unscoped topics → only scoped are attached
//   9. custom authorizeTopics function is respected
//
// Run:  node --test test/sse-ticket.test.js

var test = require('node:test');
var assert = require('node:assert');
var http = require('http');
var express = require('express');
var sse = require('../lib/sse');

function inMemoryTicketStore() {
  var store = new Map();
  return {
    issue: function(payload) {
      var t = 'tk_' + Math.random().toString(36).slice(2, 14);
      store.set(t, payload);
      return t;
    },
    consume: async function(ticket) {
      if (!store.has(ticket)) return null;
      var payload = store.get(ticket);
      store.delete(ticket);              // single-use
      return payload;
    },
    _size: function() { return store.size; }
  };
}

function startServerWithTicket(opts) {
  var app = express();
  app.get('/events', sse.createHandler(opts));
  return new Promise(function(resolve) {
    var server = app.listen(0, function() { resolve({ server: server, port: server.address().port }); });
  });
}

function openClient(port, query) {
  return new Promise(function(resolve, reject) {
    var req = http.request({ port: port, path: '/events?' + query, headers: { Accept: 'text/event-stream' } }, function(res) {
      var buffer = '', events = [];
      res.setEncoding('utf8');
      res.on('data', function(chunk) {
        buffer += chunk;
        var idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          var frame = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
          if (frame.startsWith(':')) continue;
          var lines = frame.split('\n').filter(function(l) { return l.startsWith('data:'); });
          if (!lines.length) continue;
          events.push(JSON.parse(lines.map(function(l) { return l.slice(5).trim(); }).join('\n')));
        }
      });
      resolve({
        statusCode: res.statusCode,
        events:     events,
        close:      function() { req.destroy(); res.destroy(); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Simple HTTP status probe — for endpoints we expect to reject before
// upgrading to SSE. Returns the status code.
function probeStatus(port, query) {
  return new Promise(function(resolve, reject) {
    http.get({ port: port, path: '/events?' + query, headers: { Accept: 'text/event-stream' } }, function(res) {
      resolve(res.statusCode);
      res.resume();
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
function waitFor(fn, timeoutMs) {
  timeoutMs = timeoutMs || 2000;
  var deadline = Date.now() + timeoutMs;
  return new Promise(function(resolve, reject) {
    (function loop() {
      if (fn()) return resolve();
      if (Date.now() > deadline) return reject(new Error('timeout'));
      setTimeout(loop, 10);
    })();
  });
}

test('createHandler requires validateTicket in opts', function() {
  assert.throws(function() { sse.createHandler({}); }, /validateTicket is required/);
});

test('missing ticket query param → 401', async function() {
  sse._reset();
  var tickets = inMemoryTicketStore();
  var { server, port } = await startServerWithTicket({ validateTicket: tickets.consume });
  try {
    var status = await probeStatus(port, 'topics=user:me:jobs');
    assert.strictEqual(status, 401);
  } finally { server.close(); }
});

test('missing topics query param → 400', async function() {
  sse._reset();
  var tickets = inMemoryTicketStore();
  var tk = tickets.issue({ userId: 'u42', scopes: ['user:me:*'] });
  var { server, port } = await startServerWithTicket({ validateTicket: tickets.consume });
  try {
    var status = await probeStatus(port, 'ticket=' + tk);
    assert.strictEqual(status, 400);
  } finally { server.close(); }
});

test('invalid / expired / already-consumed ticket → 401', async function() {
  sse._reset();
  var tickets = inMemoryTicketStore();
  var { server, port } = await startServerWithTicket({ validateTicket: tickets.consume });
  try {
    var status = await probeStatus(port, 'ticket=nonexistent&topics=user:me:jobs');
    assert.strictEqual(status, 401);
  } finally { server.close(); }
});

test('validator throws → 500', async function() {
  sse._reset();
  var { server, port } = await startServerWithTicket({
    validateTicket: async function() { throw new Error('redis down'); }
  });
  try {
    var status = await probeStatus(port, 'ticket=any&topics=user:me:jobs');
    assert.strictEqual(status, 500);
  } finally { server.close(); }
});

test('valid ticket + in-scope topic → attaches + receives events', async function() {
  sse._reset();
  var tickets = inMemoryTicketStore();
  var tk = tickets.issue({ userId: 'u42', scopes: ['user:me:*'] });
  var { server, port } = await startServerWithTicket({ validateTicket: tickets.consume });
  try {
    var client = await openClient(port, 'ticket=' + tk + '&topics=user:me:jobs');
    await sleep(20);
    // user:me:jobs was rewritten to user:u42:jobs — publish to that:
    sse.publish('user:u42:jobs', { jobId: 'j_1', status: 'complete' });
    await waitFor(function() { return client.events.length >= 1; });
    assert.strictEqual(client.events[0].topic, 'user:u42:jobs');
    assert.deepStrictEqual(client.events[0].data, { jobId: 'j_1', status: 'complete' });
    client.close();
  } finally { server.close(); }
});

test('ticket is single-use — a second connect with the same ticket fails', async function() {
  sse._reset();
  var tickets = inMemoryTicketStore();
  var tk = tickets.issue({ userId: 'u42', scopes: ['user:me:*'] });
  var { server, port } = await startServerWithTicket({ validateTicket: tickets.consume });
  try {
    var a = await openClient(port, 'ticket=' + tk + '&topics=user:me:jobs');
    await sleep(20);
    assert.strictEqual(a.statusCode, 200);

    // Same ticket, second connect
    var status = await probeStatus(port, 'ticket=' + tk + '&topics=user:me:jobs');
    assert.strictEqual(status, 401);

    a.close();
  } finally { server.close(); }
});

test('cross-user topic (user:other:...) is stripped → 403 when nothing survives', async function() {
  sse._reset();
  var tickets = inMemoryTicketStore();
  var tk = tickets.issue({ userId: 'u42', scopes: ['user:me:*'] });
  var { server, port } = await startServerWithTicket({ validateTicket: tickets.consume });
  try {
    var status = await probeStatus(port, 'ticket=' + tk + '&topics=user:evil:jobs');
    assert.strictEqual(status, 403);
  } finally { server.close(); }
});

test('mixed topics: only in-scope survive; unauthorized are dropped silently', async function() {
  sse._reset();
  var tickets = inMemoryTicketStore();
  var tk = tickets.issue({ userId: 'u42', scopes: ['user:me:*'] });
  var { server, port } = await startServerWithTicket({ validateTicket: tickets.consume });
  try {
    // user:me:jobs is allowed (rewritten to user:u42:jobs)
    // user:evil:jobs is dropped
    var client = await openClient(port, 'ticket=' + tk + '&topics=user:me:jobs,user:evil:jobs');
    await sleep(20);

    // Publish to the allowed topic — client receives
    sse.publish('user:u42:jobs', { hi: 'there' });
    // Publish to the disallowed topic — client does NOT receive
    sse.publish('user:evil:jobs', { should: 'not arrive' });

    await waitFor(function() { return client.events.length >= 1; });
    await sleep(60);  // let any leaked events land

    assert.strictEqual(client.events.length, 1);
    assert.strictEqual(client.events[0].topic, 'user:u42:jobs');

    client.close();
  } finally { server.close(); }
});

test('custom authorizeTopics is respected', async function() {
  sse._reset();
  var tickets = inMemoryTicketStore();
  var tk = tickets.issue({ userId: 'u42', scopes: ['whatever'] });
  var { server, port } = await startServerWithTicket({
    validateTicket:  tickets.consume,
    authorizeTopics: function(payload, requested) {
      // Custom policy: only allow topics starting with 'ok:'
      return requested.filter(function(t) { return t.startsWith('ok:'); });
    }
  });
  try {
    var client = await openClient(port, 'ticket=' + tk + '&topics=ok:foo,bad:bar');
    await sleep(20);

    sse.publish('ok:foo', { ok: true });
    sse.publish('bad:bar', { bad: true });

    await waitFor(function() { return client.events.length >= 1; });
    await sleep(60);
    assert.strictEqual(client.events.length, 1);
    assert.strictEqual(client.events[0].topic, 'ok:foo');

    client.close();
  } finally { server.close(); }
});
