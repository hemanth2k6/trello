const { pool } = require('../config/db');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Persists a task move with optimistic concurrency control.
 *
 * Transaction flow:
 * 1. Validate UUIDs
 * 2. BEGIN
 * 3. UPDATE tasks SET column_id = ..., position = ..., version = version + 1
 *    WHERE id = $3 AND version = $4
 * 4. If rowCount === 0: ROLLBACK and return null (optimistic lock failure)
 * 5. Otherwise: COMMIT and return updated task row
 */
async function persistTaskMove({ taskId, columnId, position, version }) {
  if (!taskId || !UUID_REGEX.test(taskId)) {
    return null;
  }
  if (columnId && !UUID_REGEX.test(columnId)) {
    return null;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const updateQuery = `
      UPDATE tasks
      SET column_id = COALESCE($1, column_id),
          position = $2,
          version = version + 1,
          updated_at = now()
      WHERE id = $3 AND version = $4
      RETURNING id, column_id, title, description, position, version, created_at, updated_at;
    `;

    const parsedVersion = parseInt(version, 10);
    const parsedPosition = parseFloat(position);

    const result = await client.query(updateQuery, [
      columnId || null,
      parsedPosition,
      taskId,
      parsedVersion,
    ]);

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query('COMMIT');
    return result.rows[0];
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      console.error('Error rolling back transaction:', rbErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

async function getTaskById(taskId) {
  if (!taskId || !UUID_REGEX.test(taskId)) {
    return null;
  }
  const res = await pool.query(
    'SELECT id, column_id, title, description, position, version, created_at, updated_at FROM tasks WHERE id = $1',
    [taskId]
  );
  return res.rows[0] || null;
}

async function recordBoardEvent({ boardId, eventType, payload, actorUserId }) {
  if (!boardId || !UUID_REGEX.test(boardId)) {
    return null;
  }
  const query = `
    INSERT INTO board_events (board_id, event_type, payload, actor_user_id)
    VALUES ($1, $2, $3, $4)
    RETURNING id, board_id, event_type, payload, actor_user_id, created_at;
  `;
  const res = await pool.query(query, [
    boardId,
    eventType,
    JSON.stringify(payload),
    actorUserId && UUID_REGEX.test(actorUserId) ? actorUserId : null,
  ]);
  return res.rows[0];
}

module.exports = {
  persistTaskMove,
  getTaskById,
  recordBoardEvent,
};
