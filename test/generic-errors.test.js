// How a save's error reaches the caller: a model hook's own ValidationError
// keeps its sentence; jsonSchema's stays "Validation failed".
// Matched by err.name, as objection's errors are (two copies in a monorepo).
var test = require('node:test');
var assert = require('node:assert');
var http = require('node:http');
var express = require('express');
var { sendError } = require('../lib/genericController');

function validationError(type, message, data) {
  var err = new Error(message);
  err.name = 'ValidationError';
  err.type = type;
  err.data = data;
  return err;
}

async function answer(err) {
  var app = express();
  app.get('/', function (req, res) { sendError(req, res, err); });
  var server = http.createServer(app).listen(0);
  try {
    var res = await fetch('http://127.0.0.1:' + server.address().port + '/');
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('a hook\'s own ValidationError keeps its message', async function () {
  var r = await answer(validationError('LicenceLimit', 'Your licence allows 2 companies.'));
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.body.message, 'Your licence allows 2 companies.');
});

test('a jsonSchema ValidationError says Validation failed', async function () {
  var r = await answer(validationError('ModelValidation', 'name: is a required property', { name: [{ message: 'is a required property' }] }));
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.body.message, 'Validation failed');
});
