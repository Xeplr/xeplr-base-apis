// Validate that a required set of env vars is present. ONE implementation,
// used two ways:
//   • at startup — createApp({ requiredEnv: [...] }) runs it before booting
//   • at build   — the `xeplr-check-env` CLI runs it against the same list
// The app supplies the list; the framework owns the check.
//
//   checkEnv(['JWT_SECRET', 'XEPLR_BI_CONNECTION'], { appName: 'bi' })
//
// Options:
//   appName  label in the message (default 'app')
//   exit     process.exit(1) on failure (default true)  — set false to just return
//   throw    throw instead of logging/exiting (default false)
//   silent   suppress the success line (default false)

function checkEnv(required, options) {
  options = options || {};
  required = required || [];
  var appName = options.appName || 'app';

  var missing = required.filter(function (v) { return !process.env[v]; });

  if (missing.length > 0) {
    var msg = '[' + appName + '] Missing required env vars:\n' +
      missing.map(function (v) { return '  - ' + v; }).join('\n') +
      '\n\n' + missing.length + ' env var(s) missing. Add them to your .env or CI secrets.';
    if (options.throw) throw new Error(msg);
    console.error('\n' + msg + '\n');
    if (options.exit !== false) process.exit(1);
    return { ok: false, missing: missing };
  }

  if (!options.silent) console.log('[' + appName + '] All required env vars present.');
  return { ok: true, missing: [] };
}

module.exports = checkEnv;
