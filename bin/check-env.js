#!/usr/bin/env node

// xeplr-check-env — build-time env validation. Reads the app's required list
// and checks it against the environment. Same check createApp runs at startup.
//
//   xeplr-check-env                       # reads ./env.required.js
//   xeplr-check-env --file ./env.list.js  # custom list module (exports string[])
//
// Reads process.env ONLY. The consuming app loads its .env (e.g. via dotenv-cli
// in the npm script) — @xeplr/* packages never read .env files.

var path = require('path');

function argOf(name, fallback) {
  var i = process.argv.indexOf('--' + name);
  return (i !== -1 && process.argv[i + 1]) ? process.argv[i + 1] : fallback;
}

var file = argOf('file', './env.required.js');
var required;
try {
  required = require(path.resolve(process.cwd(), file));
} catch (err) {
  console.error('xeplr-check-env: could not load required list "' + file + '": ' + err.message);
  process.exit(1);
}

require('../lib/checkEnv')(required, { appName: argOf('name', 'check-env') });
