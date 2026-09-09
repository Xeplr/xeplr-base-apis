var { respond } = require('@xeplr/utils/lib/response');
var { HTTP, STATUS } = require('@xeplr/utils/isomorphic');
var { generateId } = require('@xeplr/utils/lib/helpers');

/**
 * Map an Objection / DB error to a clean, client-friendly HTTP response instead
 * of a blanket 500. Matched by `err.name` (not instanceof) so it survives two
 * copies of objection in a linked monorepo. Unknown errors still fall to 500.
 *
 *   ValidationError        → 422  { fields }   (jsonSchema: required/format/…)
 *   UniqueViolationError   → 409  already exists
 *   NotNullViolationError  → 400  <column> is required
 *   ForeignKeyViolationError → 409 referenced record missing / in use
 *   Check/DataError        → 400  invalid data
 *   NotFoundError          → 404
 */
function sendError(req, res, err) {
  if (req && req.log && req.log.error) req.log.error((err && err.message) || 'error', { stack: err && err.stack });

  switch (err && err.name) {
    case 'ValidationError':
      return respond(res, HTTP.VALIDATION_ERROR, STATUS.VALIDATION_ERROR, 'validation_error', {
        message: 'Validation failed', fields: err.data || {}
      });
    case 'UniqueViolationError':
      return respond(res, HTTP.CONFLICT, STATUS.CONFLICT, 'conflict', {
        message: 'A record with these values already exists', columns: err.columns
      });
    case 'NotNullViolationError':
      return respond(res, HTTP.BAD_REQUEST, STATUS.BAD_REQUEST, 'bad_request', {
        message: (err.column || 'A required field') + ' is required', column: err.column
      });
    case 'ForeignKeyViolationError':
      return respond(res, HTTP.CONFLICT, STATUS.CONFLICT, 'conflict', {
        message: 'A referenced record is missing or still in use'
      });
    case 'CheckViolationError':
    case 'DataError':
      return respond(res, HTTP.BAD_REQUEST, STATUS.BAD_REQUEST, 'bad_request', {
        message: 'Invalid data for one or more fields'
      });
    case 'NotFoundError':
      return respond(res, HTTP.NOT_FOUND, STATUS.NOT_FOUND, 'not_found');
    default:
      return respond(res, HTTP.SERVER_ERROR, STATUS.SERVER_ERROR, 'server_error', { error: err });
  }
}

/**
 * Generic CRUD controller.
 * Processes the changeset from xeplr-ui-table in a single transaction.
 *
 * Changeset rules:
 *   - No id           → INSERT (new record)
 *   - Has id, deleted  → SOFT DELETE (isActive = false)
 *   - Has id           → PATCH (only changed fields)
 *   - Children nested inside parent follow same rules, recursively
 */

/**
 * Save handler — processes a changeset array in a single transaction.
 *
 * @param {object} req       - Express request. Body: changeset array.
 * @param {object} res       - Express response.
 * @param {object} hierarchy - { key, model, children: [...] }
 */
async function save(req, res, hierarchy) {
  var changeSet = req.body;
console.log('bruh: ', 1);
  if (!Array.isArray(changeSet) || changeSet.length === 0) {
    return respond(res, HTTP.BAD_REQUEST, STATUS.BAD_REQUEST, 'bad_request', {
      message: 'Expected a non-empty changeset array'
    });
  }

  var rootDef = hierarchy;
  var knex = rootDef.model.knex();
  var updatedIds = [];

  var trx = await knex.transaction();

  // Threaded onto every query in this save via .context(...) — lets a
  // model's own Objection lifecycle hooks (e.g. $afterInsert(queryContext))
  // know who made the request, without genericController needing to know
  // anything about what a specific model does with that. { user: req.user }
  // only (not the whole req) — keep this small and serializable-shaped.
  //
  // afterCommit: a hook that needs a side effect on ANOTHER connection (e.g.
  // a cross-DB write — see xeplr-bi's Company.$afterInsert granting the
  // creator access in the auth DB) must not run it inline: this trx hasn't
  // committed yet, so a later entry in the same changeset failing would roll
  // this row back while the other connection's write already landed —
  // orphaned data pointing at a record that no longer exists. Instead the
  // hook pushes a callback here; genericController drains it only once
  // trx.commit() has actually succeeded. genericController itself stays
  // generic — it never knows what a callback does, only that it's safe to
  // run now.
  var queryContext = req.user ? { user: req.user, afterCommit: [] } : { afterCommit: [] };

  try {
    for (var i = 0; i < changeSet.length; i++) {
      var ids = await processEntry(changeSet[i], rootDef, trx, null, queryContext);
      updatedIds = updatedIds.concat(ids);
    }
console.log('bruh: ', 2);

    await trx.commit();

    for (var c = 0; c < queryContext.afterCommit.length; c++) {
      try {
        await queryContext.afterCommit[c]();
      } catch (err) {
        if (req && req.log && req.log.error) req.log.error('afterCommit callback failed', { message: err.message, stack: err.stack });
        else console.error('[genericController] afterCommit callback failed:', err.message);
      }
    }
console.log('bruh: ', 3);

    respond(res, HTTP.OK, STATUS.UPDATED, 'updated', { updatedIds: updatedIds });
  } catch (err) {
    await trx.rollback();
    sendError(req, res, err);
  }
}

/**
 * Process a single changeset entry (recursive for children).
 * @param {object} entry      - The changeset row
 * @param {object} def        - Hierarchy definition { key, model, children, foreignKey }
 * @param {object} trx        - Knex transaction
 * @param {string} [parentId] - Parent record ID (set automatically for children)
 * @param {object} [queryContext] - Passed to .context(...) on every query — see save()
 */
async function processEntry(entry, def, trx, parentId, queryContext) {
  var Model = def.model;
  var children = def.children || [];
  var ids = [];
  queryContext = queryContext || {};

  // ── SOFT DELETE ──
  if (entry.deleted === true) {
    await Model.query(trx).context(queryContext).findById(entry.id).patch({ isActive: false });
    ids.push(entry.id);
    return ids;
  }

  // Separate own fields from child arrays
  var ownFields = {};
  var childData = {};
  var keys = Object.keys(entry);

  for (var k = 0; k < keys.length; k++) {
    var key = keys[k];
    if (key === 'deleted') continue;

    var childDef = findChildDef(children, key);
    if (childDef) {
      childData[key] = entry[key];
    } else {
      ownFields[key] = entry[key];
    }
  }

  // Auto-set foreign key if this is a child record
  if (def.foreignKey && parentId) {
    ownFields[def.foreignKey] = parentId;
  }

  var recordId = ownFields.id;

  // ── INSERT (no id provided) ──
  if (!recordId) {
    recordId = generateId();
    ownFields.id = recordId;
    await Model.query(trx).context(queryContext).insert(ownFields);
    ids.push(recordId);
  } else {
    // ── UPSERT (id provided): patch if exists, else insert with given id ──
    var existing = await Model.query(trx).findById(recordId);
    if (existing) {
      var patchFields = Object.assign({}, ownFields);
      delete patchFields.id;
      if (Object.keys(patchFields).length > 0) {
        await Model.query(trx).context(queryContext).findById(recordId).patch(patchFields);
      }
      ids.push(recordId);
    } else {
      await Model.query(trx).context(queryContext).insert(ownFields);
      ids.push(recordId);
    }
  }

  // ── Process children recursively ──
  for (var c = 0; c < children.length; c++) {
    var cDef = children[c];
    var childEntries = childData[cDef.key];
    if (!childEntries || !Array.isArray(childEntries)) continue;

    for (var j = 0; j < childEntries.length; j++) {
      var childIds = await processEntry(childEntries[j], cDef, trx, recordId, queryContext);
      ids = ids.concat(childIds);
    }
  }

  return ids;
}

function findChildDef(children, key) {
  for (var i = 0; i < children.length; i++) {
    if (children[i].key === key) return children[i];
  }
  return null;
}

/**
 * Delete handler — soft delete by ids.
 */
async function deleteByIds(req, res, Model) {
  var ids = req.body.ids;

  if (!Array.isArray(ids) || ids.length === 0) {
    return respond(res, HTTP.BAD_REQUEST, STATUS.BAD_REQUEST, 'bad_request', {
      message: 'Expected a non-empty ids array'
    });
  }

  try {
    await Model.query().whereIn('id', ids).patch({ isActive: false });
    respond(res, HTTP.OK, STATUS.DELETED, 'deleted', { updatedIds: ids });
  } catch (err) {
    sendError(req, res, err);
  }
}

/**
 * Get by ID — single record with eager children.
 */
async function getById(req, res, Model, graph) {
  try {
    var query = Model.query().findById(req.params.id);
    if (graph) {
      query = query.withGraphFetched(graph);
    }
    var record = await query;

    if (!record) {
      return respond(res, HTTP.NOT_FOUND, STATUS.NOT_FOUND, 'not_found');
    }

    respond(res, HTTP.OK, STATUS.SUCCESS, 'success', { dataArray: [record] });
  } catch (err) {
    sendError(req, res, err);
  }
}

/**
 * List — paginated, with optional eager graph.
 *
 * Query params:
 *   ?page=1&limit=50    — pagination (default: page 1, limit 50)
 *   ?limit=0            — no pagination, return all (use carefully)
 *
 * Response includes pagination metadata in dataArray wrapper:
 *   { dataArray: [...], pagination: { page, limit, total, totalPages } }
 */
async function list(req, res, Model, graph) {
  try {
    var page = parseInt(req.query.page) || 1;
    var limit = req.query.limit !== undefined ? parseInt(req.query.limit) : 50;

    var query = Model.query();
    if (graph) {
      query = query.withGraphFetched(graph);
    }

    // limit=0 means no pagination (return all)
    if (limit > 0) {
      var countResult = await Model.query().count('* as total').first();
      var total = countResult.total || 0;
      var totalPages = Math.ceil(total / limit);
      var offset = (page - 1) * limit;

      query = query.limit(limit).offset(offset);
      var records = await query;

      respond(res, HTTP.OK, STATUS.SUCCESS, 'success', {
        dataArray: records,
        pagination: { page: page, limit: limit, total: total, totalPages: totalPages }
      });
    } else {
      var records = await query;
      respond(res, HTTP.OK, STATUS.SUCCESS, 'success', { dataArray: records });
    }
  } catch (err) {
    sendError(req, res, err);
  }
}

module.exports = { save, deleteByIds, getById, list };
