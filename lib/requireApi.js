// A route's own permission: the caller's access (put on the request by the
// auth gate as req.access.apis — the names of the `apis` rows their roles are
// mapped to) must name this route. One implementation, for every app and
// package; mount it after createApp's gate:
//
//   var { requireApi } = require('@xeplr/base-apis');
//   router.post('/services', requireApi('Add monitored service'), handler);
//
// The name is the `apis` row's name, inserted with its group and role
// mappings in the app's migrations-auth. No access information on the request
// means the route was mounted outside the gate: refused, never let through.
function requireApi(name) {
  if (!name) throw new Error('requireApi: the apis row name is required');
  return function(req, res, next) {
    var apis = req.access && req.access.apis;
    if (!Array.isArray(apis)) {
      return res.status(403).json({ error: 'No access information on the request — mount this route behind the auth gate', code: 'NO_ACCESS_INFO' });
    }
    if (apis.indexOf(name) === -1) {
      return res.status(403).json({ error: 'Access denied: ' + name, code: 'ACCESS_DENIED' });
    }
    next();
  };
}

module.exports = requireApi;
