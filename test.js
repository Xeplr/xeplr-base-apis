const assert = require('assert');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + ': ' + e.message); }
}

// ── lib/server tests ──
console.log('\nlib/server');
const { normalizePort } = require('./lib/server');

test('normalizePort parses numeric string', () => {
  assert.strictEqual(normalizePort('3000'), 3000);
});

test('normalizePort returns named pipe as-is', () => {
  assert.strictEqual(normalizePort('pipe-name'), 'pipe-name');
});

test('normalizePort returns false for negative port', () => {
  assert.strictEqual(normalizePort('-1'), false);
});

// ── express module tests ──
console.log('\nexpress module');
const app = require('./express');

test('exports an express app with init method', () => {
  assert.strictEqual(typeof app, 'function'); // express app is a function
  assert.strictEqual(typeof app.init, 'function');
  assert.strictEqual(typeof app.use, 'function');
  assert.strictEqual(typeof app.get, 'function');
});

// ── http module tests ──
console.log('\nhttp module');
const httpMod = require('./http');

test('exports init function', () => {
  assert.strictEqual(typeof httpMod.init, 'function');
});

// ── index module tests ──
console.log('\nindex module');
const pkg = require('./index');

test('index exports express and http', () => {
  assert.strictEqual(typeof pkg.express, 'function');
  assert.strictEqual(typeof pkg.http, 'object');
  assert.strictEqual(typeof pkg.http.init, 'function');
});

// ── Summary ──
console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
if (failed > 0) process.exit(1);
