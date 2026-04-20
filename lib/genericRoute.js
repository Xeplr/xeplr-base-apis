var express = require('express');
var controller = require('./genericController');

/**
 * Generate CRUD routes for a model hierarchy.
 *
 * Usage:
 *
 *   var { genericRoute } = require('@xeplr/base-apis');
 *
 *   // Basic — all routes require auth
 *   var deptRoutes = genericRoute(hierarchy, { auth: authMiddleware });
 *
 *   // Per-operation auth
 *   var deptRoutes = genericRoute(hierarchy, {
 *     auth: {
 *       list:   authMiddleware,            // any authenticated user can list
 *       getById: authMiddleware,
 *       save:   [authMiddleware, adminOnly], // save needs admin
 *       delete: [authMiddleware, adminOnly]
 *     }
 *   });
 *
 *   // No auth (dev/internal only)
 *   var deptRoutes = genericRoute(hierarchy);
 *
 * Hierarchy:
 *   {
 *     key: 'department',
 *     model: Department,
 *     children: [
 *       { key: 'employees', model: Employee,
 *         children: [{ key: 'salaries', model: Salary }]
 *       }
 *     ]
 *   }
 *
 * Generated routes:
 *   GET    /              → list (paginated: ?page=1&limit=50)
 *   GET    /:id           → get by id (with eager children)
 *   POST   /save          → save changeset (transactional)
 *   POST   /delete        → soft delete by ids
 *
 * @param {object}           hierarchy     - { key, model, children? }
 * @param {object}           [options]
 * @param {Function|object}  [options.auth] - Single middleware or { list, getById, save, delete }
 * @returns {Router}
 */
function genericRoute(hierarchy, options) {
  options = options || {};
  var router = express.Router();
  var Model = hierarchy.model;
  var graph = buildGraph(hierarchy);

  var auth = resolveAuth(options.auth);

  // GET / — list (paginated)
  router.get('/', auth.list, function(req, res) {
    controller.list(req, res, Model, graph);
  });

  // GET /:id — get single with eager children
  router.get('/:id', auth.getById, function(req, res) {
    controller.getById(req, res, Model, graph);
  });

  // POST /save — process changeset
  router.post('/save', auth.save, function(req, res) {
    controller.save(req, res, hierarchy);
  });

  // POST /delete — soft delete by ids
  router.post('/delete', auth.delete, function(req, res) {
    controller.deleteByIds(req, res, Model);
  });

  return router;
}

/**
 * Resolve auth option into per-operation middleware arrays.
 *
 * Input forms:
 *   undefined              → no auth (passthrough)
 *   Function               → same middleware for all operations
 *   [Function, Function]   → same middleware chain for all operations
 *   { list, save, ... }    → per-operation middleware
 */
function resolveAuth(auth) {
  var noop = function(req, res, next) { next(); };
  var defaults = { list: [noop], getById: [noop], save: [noop], delete: [noop] };

  if (!auth) return defaults;

  // Single function or array → apply to all operations
  if (typeof auth === 'function' || Array.isArray(auth)) {
    var mw = Array.isArray(auth) ? auth : [auth];
    return { list: mw, getById: mw, save: mw, delete: mw };
  }

  // Per-operation object
  return {
    list:    toArray(auth.list) || defaults.list,
    getById: toArray(auth.getById) || defaults.getById,
    save:    toArray(auth.save) || defaults.save,
    delete:  toArray(auth.delete) || defaults.delete
  };
}

function toArray(val) {
  if (!val) return null;
  return Array.isArray(val) ? val : [val];
}

/**
 * Build an Objection.js eager graph string from the hierarchy.
 * { children: [{ key: 'employees', children: [{ key: 'salaries' }] }] }
 * → '[employees.[salaries]]'
 */
function buildGraph(hierarchy) {
  var children = hierarchy.children;
  if (!children || children.length === 0) return null;

  var parts = [];
  for (var i = 0; i < children.length; i++) {
    var child = children[i];
    var childGraph = buildGraph(child);
    if (childGraph) {
      parts.push(child.key + '.' + childGraph);
    } else {
      parts.push(child.key);
    }
  }

  if (parts.length === 1) return parts[0];
  return '[' + parts.join(', ') + ']';
}

module.exports = genericRoute;
