var { respond } = require('@xeplr/utils/lib/response');
var { HTTP, STATUS } = require('@xeplr/utils/isomorphic');
var { generateId } = require('@xeplr/utils/lib/helpers');

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

  if (!Array.isArray(changeSet) || changeSet.length === 0) {
    return respond(res, HTTP.BAD_REQUEST, STATUS.BAD_REQUEST, 'bad_request', {
      message: 'Expected a non-empty changeset array'
    });
  }

  var rootDef = hierarchy;
  var knex = rootDef.model.knex();
  var updatedIds = [];

  var trx = await knex.transaction();

  try {
    for (var i = 0; i < changeSet.length; i++) {
      var ids = await processEntry(changeSet[i], rootDef, trx);
      updatedIds = updatedIds.concat(ids);
    }

    await trx.commit();
    respond(res, HTTP.OK, STATUS.UPDATED, 'updated', { updatedIds: updatedIds });
  } catch (err) {
    await trx.rollback();
    respond(res, HTTP.SERVER_ERROR, STATUS.SERVER_ERROR, 'server_error', { error: err });
  }
}

/**
 * Process a single changeset entry (recursive for children).
 * @param {object} entry      - The changeset row
 * @param {object} def        - Hierarchy definition { key, model, children, foreignKey }
 * @param {object} trx        - Knex transaction
 * @param {string} [parentId] - Parent record ID (set automatically for children)
 */
async function processEntry(entry, def, trx, parentId) {
  var Model = def.model;
  var children = def.children || [];
  var ids = [];

  // ── SOFT DELETE ──
  if (entry.deleted === true) {
    await Model.query(trx).findById(entry.id).patch({ isActive: false });
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

  // ── INSERT ──
  if (!recordId) {
    recordId = generateId();
    ownFields.id = recordId;
    await Model.query(trx).insert(ownFields);
    ids.push(recordId);
  } else {
    // ── PATCH ──
    var patchFields = Object.assign({}, ownFields);
    delete patchFields.id;

    if (Object.keys(patchFields).length > 0) {
      await Model.query(trx).findById(recordId).patch(patchFields);
      ids.push(recordId);
    }
  }

  // ── Process children recursively ──
  for (var c = 0; c < children.length; c++) {
    var cDef = children[c];
    var childEntries = childData[cDef.key];
    if (!childEntries || !Array.isArray(childEntries)) continue;

    for (var j = 0; j < childEntries.length; j++) {
      var childIds = await processEntry(childEntries[j], cDef, trx, recordId);
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
    respond(res, HTTP.SERVER_ERROR, STATUS.SERVER_ERROR, 'server_error', { error: err });
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
    respond(res, HTTP.SERVER_ERROR, STATUS.SERVER_ERROR, 'server_error', { error: err });
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
    respond(res, HTTP.SERVER_ERROR, STATUS.SERVER_ERROR, 'server_error', { error: err });
  }
}

module.exports = { save, deleteByIds, getById, list };
