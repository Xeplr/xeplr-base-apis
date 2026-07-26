var express = require('express');
var FileUploader = require('@xeplr/utils/lib/fileUploader');

/**
 * Generic "receive a file, hand back its path" route — product/app-agnostic.
 * Every app that needs file upload (avatars, data imports, attachments, ...)
 * mounts this once instead of hand-rolling multer wiring; whatever the app
 * actually DOES with the file (parse it, load it into a DB, attach it to a
 * record) is a separate, app-specific request made AFTER this one, using the
 * returned filePath.
 *
 * Usage:
 *   var { uploadRoute } = require('@xeplr/base-apis');
 *   app.use('/uploads', uploadRoute({ destination: './uploads', auth: authMiddleware }));
 *
 * Generated route:
 *   POST /  (multipart, field name options.fieldName, default "file")
 *     → { filePath, fileName, originalName, size, mimetype }
 *
 * @param {object} [options]
 * @param {string} [options.destination='./uploads'] - disk directory to store uploaded files
 * @param {number} [options.maxSize=5MB]
 * @param {string[]} [options.allowedTypes=['*']]
 * @param {string} [options.fieldName='file']
 * @param {Function|Function[]} [options.auth] - middleware(s) to run before the upload itself
 * @returns {Router}
 */
function uploadRoute(options) {
  options = options || {};
  var router = express.Router();
  var fieldName = options.fieldName || 'file';

  var uploader = new FileUploader({
    destination: options.destination,
    maxSize: options.maxSize,
    allowedTypes: options.allowedTypes
  });

  var auth = options.auth ? (Array.isArray(options.auth) ? options.auth : [options.auth]) : [];
  var multerChain = uploader.single(fieldName);   // [authGuard(noop unless FileUploader's own auth set), multer, errorHandler]

  router.post.apply(router, ['/'].concat(auth, multerChain, [function(req, res) {
    if (!req.file) return res.status(400).json({ error: fieldName + ' is required' });
    res.json({
      filePath: req.file.path,
      fileName: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype
    });
  }]));

  return router;
}

module.exports = uploadRoute;
