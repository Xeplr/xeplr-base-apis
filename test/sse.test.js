// Single-process SSE tests. Cluster-IPC path is best tested by spawning
// child processes — deferred; the code path is small and lifted directly
// from the existing `broadcast()` pattern which already has real-world use.
//
// Run:  node --test test/sse.test.js

var test = require('node:test');
var assert = require('node:assert');
var http = require('http');
var express = require('express');
var sse = require('../lib/sse');

// Boot a fresh tiny Express server on a random port. Returns { server, port }.
function startServer() {
  var app = express();
  app.get('/events', sse.handler);
  return new Promise(function(resolve) {
    var server = app.listen(0, function() {
      resolve({ server: server, port: server.address().port });
    });
  });
}

// Open an SSE client. Resolves with an object that exposes .events (array
// of parsed JSON payloads) and .close(). Waits up to `waitMs` after each
// expected event for it to arrive.
function openClient(port, topics) {
  return new Promise(function(resolve, reject) {
    var req = http.request({
      port: port,
      path: '/events?topics=' + encodeURIComponent(topics),
      headers: { Accept: 'text/event-stream' }
    }, function(res) {
      var buffer = '';
      var events = [];
      res.setEncoding('utf8');
      res.on('data', function(chunk) {
        buffer += chunk;
        // SSE frames end with \n\n. Parse each complete frame.
        var idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          var frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          // Skip comment-only frames (heartbeats + open marker)
          if (frame.startsWith(':')) continue;
          // Extract `data:` lines
          var dataLines = frame.split('\n').filter(function(l) { return l.startsWith('data:'); });
          if (dataLines.length === 0) continue;
          var raw = dataLines.map(function(l) { return l.slice(5).trim(); }).join('\n');
          events.push(JSON.parse(raw));
        }
      });
      resolve({
        events: events,
        close: function() { req.destroy(); res.destroy(); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Wait until `test()` returns truthy, or timeout.
function waitFor(test, timeoutMs) {
  timeoutMs = timeoutMs || 2000;
  var deadline = Date.now() + timeoutMs;
  return new Promise(function(resolve, reject) {
    (function loop() {
      if (test()) return resolve();
      if (Date.now() > deadline) return reject(new Error('timeout waiting for condition'));
      setTimeout(loop, 10);
    })();
  });
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

test('subscribe, publish, receive', async function() {
  sse._reset();
  var { server, port } = await startServer();
  try {
    var client = await openClient(port, 'movement:mv1');
    await sleep(20);   // let handshake settle so the sub is registered before we publish

    sse.publish('movement:mv1', { status: 'complete', progress: 1 });
    await waitFor(function() { return client.events.length >= 1; });

    assert.strictEqual(client.events.length, 1);
    assert.strictEqual(client.events[0].topic, 'movement:mv1');
    assert.deepStrictEqual(client.events[0].data, { status: 'complete', progress: 1 });

    client.close();
  } finally {
    server.close();
  }
});

test('publish to a topic no one is subscribed to → silent no-op', async function() {
  sse._reset();
  var { server, port } = await startServer();
  try {
    var client = await openClient(port, 'movement:mv1');
    await sleep(20);
    sse.publish('movement:mv_other', { irrelevant: true });
    await sleep(60);
    assert.strictEqual(client.events.length, 0);
    client.close();
  } finally {
    server.close();
  }
});

test('two clients on the same topic both receive', async function() {
  sse._reset();
  var { server, port } = await startServer();
  try {
    var a = await openClient(port, 'job:1');
    var b = await openClient(port, 'job:1');
    await sleep(20);

    sse.publish('job:1', { hello: 'world' });
    await waitFor(function() { return a.events.length && b.events.length; });

    assert.deepStrictEqual(a.events[0].data, { hello: 'world' });
    assert.deepStrictEqual(b.events[0].data, { hello: 'world' });

    a.close(); b.close();
  } finally {
    server.close();
  }
});

test('client subscribed to multiple topics receives events from any of them', async function() {
  sse._reset();
  var { server, port } = await startServer();
  try {
    var client = await openClient(port, 'job:1,job:2,movement:9');
    await sleep(20);

    sse.publish('job:2',      { at: 'j2' });
    sse.publish('movement:9', { at: 'mv9' });
    sse.publish('job:1',      { at: 'j1' });
    await waitFor(function() { return client.events.length >= 3; });

    assert.strictEqual(client.events.length, 3);
    var topics = client.events.map(function(e) { return e.topic; }).sort();
    assert.deepStrictEqual(topics, ['job:1', 'job:2', 'movement:9']);

    client.close();
  } finally {
    server.close();
  }
});

test('client disconnect removes subscription (stats reflect zero)', async function() {
  sse._reset();
  var { server, port } = await startServer();
  try {
    var client = await openClient(port, 'ephemeral:x');
    await sleep(20);
    assert.strictEqual(sse._stats().totalConnections, 1);

    client.close();
    // Wait for the close event to fire + cleanup to run
    await waitFor(function() { return sse._stats().totalConnections === 0; });

    assert.strictEqual(sse._stats().totalConnections, 0);
  } finally {
    server.close();
  }
});

test('missing topics query param → 400', async function() {
  sse._reset();
  var { server, port } = await startServer();
  try {
    var status = await new Promise(function(resolve, reject) {
      http.get({ port: port, path: '/events', headers: { Accept: 'text/event-stream' } }, function(res) {
        resolve(res.statusCode);
        res.resume();
      }).on('error', reject);
    });
    assert.strictEqual(status, 400);
  } finally {
    server.close();
  }
});
