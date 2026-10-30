// SEND A FILE BACK — only from the requesting tenant's own folder.
//
// The one way an app serves a stored file: the name is resolved inside the
// tenant's folder under XEPLR_DATA_DIR (@xeplr/db's dataDir), so another
// company's name finds nothing here, and a path that climbs out (../, a link,
// an absolute path elsewhere) is refused before anything is opened. The
// tenant is the request's, checked by the gate (createApp asks auth whether
// the caller belongs to it) — never what the client names.
//
//   router.get('/files/:name', function(req, res) { sendTenantFile(res, 'uploads/' + req.params.name); });
//
// 404 when there is nothing there; 400 when the name is not one in the
// tenant's folder. Never express.static over a shared folder.
var fs = require('fs');

/**
 * @param res      the Express response
 * @param name     a name in the tenant's folder, e.g. 'report-assets/logo.png'
 * @param options  { download: true | '<file name>' } to send as an attachment
 */
function sendTenantFile(res, name, options) {
  options = options || {};
  var file;
  try {
    file = require('@xeplr/db').dataDir.resolve(String(name || ''), 'The file');
  } catch (err) {
    var status = err.code === 'DATA_DIR_UNSET' ? 500 : 400;
    return res.status(status).json({ error: status === 500 ? 'Files are not set up on this server' : err.message, code: err.code });
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return res.status(404).json({ error: 'No such file' });
  if (options.download) return res.download(file, options.download === true ? undefined : options.download);
  return res.sendFile(file);
}

module.exports = sendTenantFile;
