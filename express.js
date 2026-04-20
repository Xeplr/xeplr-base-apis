var express = require('express');
var cors = require('cors');
var cookieParser = require('cookie-parser');
var path = require('path');
var { createServer } = require('./lib/server');
var logs = require('@xeplr/logs');

/**
 * Create and initialize an Express application.
 * Factory function — each call returns a fresh app instance.
 *
 * @param {number|string} port       - Port or named pipe to listen on
 * @param {string}        appName    - Service name (used for debug namespace and console logs)
 * @param {object}        [options]  - Configuration options
 * @param {object}        [options.routes]        - Route map: { '/path': router }
 * @param {Function[]}    [options.middleware]     - Middleware to apply before routes (e.g. authMiddleware)
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
