var express = require('express');
var cors = require('cors');
var cookieParser = require('cookie-parser');
var path = require('path');
var { createServer } = require('./lib/server');
var checkEnv = require('./lib/checkEnv');
var logs = require('@xeplr/logs');

/**
 * Create and initialize an Express application.
 * Factory function — each call returns a fresh app instance.
 *
 * @param {number|string} port       - Port or named pipe to listen on
 * @param {string}        appName    - Service name (used for debug namespace and console logs)
 * @param {object}        [options]  - Configuration options
 * @param {string[]}      [options.requiredEnv]   - Mandatory env var names; missing ones abort startup
 * @param {object}        [options.routes]        - Route map: { '/path': router }
 * @param {object|false}  [options.auth]          - THE GATE, ON BY DEFAULT.
 *   Omit it and every route requires a valid token, validated by asking the
 *   auth service at AUTH_URL. Boot fails if that address is not set, rather
 *   than serving unauthenticated.
 *     { url }            auth service base URL (default: process.env.AUTH_URL)
 *     { publicPaths }    path prefixes that skip the gate, e.g. ['/public/']
 *     { cacheSeconds }   per-process cache of validated tokens (default 5, 0 off)
 *     { middleware }     supply your own gate instead of the HTTP one
 *     false              this service is public ON PURPOSE
 * @param {Function[]}    [options.middleware]     - Middleware to apply before routes (runs AFTER the auth gate)
 * @param {object}        [options.views]         - { engine: 'pug', dir: '/abs/path' }
 * @param {string}        [options.staticDir]     - Path to static files directory
 * @param {string}        [options.corsOptions]   - Custom CORS options (default: allow all)
 * @param {Function}      [options.errorHandler]  - Custom error handler (req, res, next)
 * @param {object|false}  [options.log]           - Logger config (false to disable)
 * @param {string}        [options.log.logDir='./logs']        - Log directory
 * @param {number}        [options.log.fatalThreshold=4]       - Level >= this is fatal (4=error, 5=critical)
 * @param {number}        [options.log.emailThreshold=5]       - Level >= this triggers email
 * @param {string|string[]} [options.log.emailTo]              - Email recipient(s)
 * @param {object}        [options.log.emailService]           - Email service instance
 * @param {object}        [options.upload]        - File upload config
 * @param {string}        [options.upload.route='/internal/upload'] - Upload endpoint path
 * @param {string}        [options.upload.destination='./uploads']  - Storage directory
 * @param {string[]}      [options.upload.allowedTypes=['*']]       - MIME types
 * @param {number}        [options.upload.maxSize=5242880]          - Max file size in bytes
 * @param {string}        [options.upload.fieldName='file']         - Form field name
 * @param {number}        [options.upload.maxFiles=10]              - Max files per request
 * @param {string}        [options.upload.serveRoute='/uploads']    - Static serve path for uploaded files
 * @returns {{ app: Express, server: http.Server }}
 */
function createApp(port, appName, options) {
  options = options || {};

  // Fail fast if the app's mandatory env vars are missing (same check the
  // xeplr-check-env build step runs — one implementation).
  if (options.requiredEnv) checkEnv(options.requiredEnv, { appName: appName });

  var app = express();

  // ── Logger ──
  if (options.log !== false) {
    var logCfg = options.log || {};
    logs.configure({
      appName: appName,
      logDir: logCfg.logDir || './logs',
      fatalThreshold: logCfg.fatalThreshold,
      emailThreshold: logCfg.emailThreshold,
      emailTo: logCfg.emailTo,
      emailService: logCfg.emailService,
      isDev: (process.env.NODE_ENV || 'development') !== 'production'
    });
    app.use(logs.requestLogger());
  }

  // ── View engine ──
  if (options.views) {
    app.set('views', options.views.dir);
    app.set('view engine', options.views.engine || 'pug');
  }

  // ── Standard middleware ──
  app.use(cors(options.corsOptions));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  // ── Static files ──
  if (options.staticDir) {
    app.use(express.static(options.staticDir));
  }

  // ── File upload (static serve before auth, upload route after auth) ──
  if (options.upload) {
    var serveRoute = options.upload.serveRoute || '/uploads';
    var destination = path.resolve(options.upload.destination || process.env.UPLOAD_DIR || './uploads');
    app.use(serveRoute, express.static(destination));
  }

  // ── Auth gate ──
  //
  // ON BY DEFAULT. A service that forgets to configure auth must not answer
  // as though it has none — that failure is silent, boots clean, passes every
  // health check, and is indistinguishable from a working service until
  // somebody notices the whole API is public.
  //
  // Every app answers the question, one of four ways:
  //   auth omitted             → gated, via AUTH_URL from the environment
  //   auth: { url, ... }       → gated, configured here
  //   auth: { middleware: fn } → gated by a gate you supply. This is how
  //                              @xeplr/auth's own server gates itself: it
  //                              cannot ask itself over HTTP.
  //   auth: false              → public, ON PURPOSE and visible in the diff
  //
  // BEFORE options.middleware, so anything injected below — mtMiddleware and
  // friends — runs with req.user already established.
  if (options.auth !== false) {
    var authCfg = (options.auth === true || options.auth == null) ? {} : options.auth;

    if (authCfg.middleware) {
      app.use(authCfg.middleware);
    } else {
      var authUrl = authCfg.url || process.env.AUTH_URL;
      if (!authUrl) {
        // Refuse, naming the variable. The alternative is guessing an address
        // — and a wrong-but-present one either 503s everything or points at
        // something that answers 200 to anything.
        throw new Error(
          '[' + appName + '] createApp: auth is on by default and needs the auth service address.\n' +
          '  Set AUTH_URL (e.g. http://localhost:19141), or pass options.auth = { url },\n' +
          '  or pass options.auth = false if this service is genuinely public.'
        );
      }
      app.use(require('./lib/remoteAuth')({
        url: authUrl,
        publicPaths: authCfg.publicPaths,
        cacheSeconds: authCfg.cacheSeconds,
        endpoint: authCfg.endpoint,
        timeoutMs: authCfg.timeoutMs
      }));
    }
  }

  // ── Injected middleware (auth, etc.) ──
  if (options.middleware) {
    options.middleware.forEach(function(mw) { app.use(mw); });
  }

  // ── File upload (upload endpoint — behind auth) ──
  if (options.upload) {
    var FileUploader = require('@xeplr/utils').FileUploader;
    var uploadCfg = options.upload;
    var destination = path.resolve(uploadCfg.destination || process.env.UPLOAD_DIR || './uploads');
    var uploader = new FileUploader({
      auth: uploadCfg.auth || null,
      allowedTypes: uploadCfg.allowedTypes || ['*'],
      maxSize: uploadCfg.maxSize || 5 * 1024 * 1024,
      destination: destination
    });

    var uploadRoute = uploadCfg.route || '/internal/upload';
    var fieldName = uploadCfg.fieldName || 'file';
    var maxFiles = uploadCfg.maxFiles || 10;

    app.post(uploadRoute, uploader.array(fieldName, maxFiles), function(req, res) {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }
      var files = req.files.map(function(f) {
        return {
          filename: f.filename,
          originalName: f.originalname,
          size: f.size,
          mimetype: f.mimetype
        };
      });
      res.json(files.length === 1 ? files[0] : files);
    });
  }

  // ── SSE endpoint (server→client push) ──
  // Enable with `sse: true` for the default '/events' path, or
  // `sse: { path: '/api/events' }` for a custom one. Mounts AFTER the
  // middleware chain, so any auth middleware you passed in still applies.
  if (options.sse) {
    var sseCfg = options.sse === true ? {} : options.sse;
    var ssePath = sseCfg.path || '/events';
    app.get(ssePath, require('./lib/sse').handler);
  }

  // ── Routes ──
  if (options.routes) {
    Object.keys(options.routes).forEach(function(routePath) {
      app.use(routePath, options.routes[routePath]);
    });
  }

  // ── 404 handler ──
  if (options.views) {
    var createError = require('http-errors');
    app.use(function(req, res, next) { next(createError(404)); });
  } else {
    app.use(function(req, res) { res.status(404).json({ error: 'Not found' }); });
  }

  // ── Error handler ──
  if (options.errorHandler) {
    app.use(options.errorHandler);
  } else if (options.views) {
    app.use(function(err, req, res, next) {
      res.locals.message = err.message;
      res.locals.error = req.app.get('env') === 'development' ? err : {};
      res.status(err.status || 500);
      res.render('error');
    });
  } else {
    app.use(function(err, req, res, next) {
      res.status(err.status || 500).json({ error: err.message });
    });
  }

  // ── Start HTTP server ──
  app.set('port', port);
  var server = createServer(app, port, appName);

  return { app: app, server: server };
}

module.exports = createApp;
