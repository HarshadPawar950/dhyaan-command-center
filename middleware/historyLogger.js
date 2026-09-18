// =============================================================
// middleware/historyLogger.js — v2 REAL SCHEMA
//
// Reads actor identity from req.session.user. The session is set by
// routes/auth.js with both external_id (real) and legacy aliases.
// We prefer external_id; fall back to employee_code if older session.
// =============================================================

const pool = require('../db');

async function logChange({
    entityType,
    entityId = null,
    action,
    fieldName = null,
    oldValue = null,
    newValue = null,
    actor = {},
    ip = null,
    userAgent = null,
    notes = null,
} = {}) {
    try {
        if (!entityType || !action) {
            console.warn('[historyLogger] missing entityType or action — skipping');
            return;
        }

        const sql = `
            INSERT INTO private.history_log
                (entity_type, entity_id, action, field_name, old_value, new_value,
                 changed_by_code, changed_by_name, changed_by_role,
                 ip_address, user_agent, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `;
        const values = [
            entityType,
            entityId !== null && entityId !== undefined ? String(entityId) : null,
            action,
            fieldName,
            oldValue !== null && oldValue !== undefined ? String(oldValue) : null,
            newValue !== null && newValue !== undefined ? String(newValue) : null,
            actor.code || null,
            actor.name || null,
            actor.role || null,
            ip,
            userAgent,
            notes,
        ];

        await pool.query(sql, values);
    } catch (err) {
        // NEVER block main flow on logging failure
        console.error('[historyLogger] failed to log change:', err.message);
    }
}

function logFromRequest(req, payload = {}) {
    const sessionUser = req && req.session && req.session.user ? req.session.user : null;

    const actor = sessionUser
        ? {
              code: sessionUser.external_id || sessionUser.employee_code || null,
              name: sessionUser.name || null,
              role: sessionUser.access_role || sessionUser.role || null,
          }
        : {};

    const ip = req
        ? (req.ip ||
              (req.headers && req.headers['x-forwarded-for']
                  ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
                  : null))
        : null;

    const userAgent =
        req && req.headers ? req.headers['user-agent'] || null : null;

    return logChange({ ...payload, actor, ip, userAgent });
}

async function logDiff(req, entityType, entityId, oldRow, newRow, fieldsToTrack = null) {
    if (!oldRow || !newRow) return;

    const fields = fieldsToTrack || Object.keys(newRow);
    const tasks = [];

    for (const f of fields) {
        const oldV = oldRow[f];
        const newV = newRow[f];
        const oldStr = oldV === null || oldV === undefined ? '' : String(oldV);
        const newStr = newV === null || newV === undefined ? '' : String(newV);

        if (oldStr !== newStr) {
            tasks.push(
                logFromRequest(req, {
                    entityType,
                    entityId,
                    action: 'update',
                    fieldName: f,
                    oldValue: oldV,
                    newValue: newV,
                })
            );
        }
    }

    await Promise.all(tasks);
}

module.exports = { logChange, logFromRequest, logDiff };
