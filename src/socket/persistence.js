const { pool } = require('../config/db');

/**
 * Persists a task move with optimistic concurrency control.
 *
 * Transaction flow:
 * 1. BEGIN
 * 2. UPDATE tasks SET column_id = ..., position = ..., version = version + 1
 *    WHERE id = $3 AND version = $4
 * 3. If rowCount === 0: ROLLBACK and return null (optimistic lock failure)
 * 4. Otherwise: COMMIT and return updated task row
 */
async function persistTaskMove({ taskId, columnId, position, version }) {
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
  const res = await pool.query(
    'SELECT id, column_id, title, description, position, version, created_at, updated_at FROM tasks WHERE id = $1',
    [taskId]
  );
  return res.rows[0] || null;
}

module.exports = {
  persistTaskMove,
  getTaskById,
};
