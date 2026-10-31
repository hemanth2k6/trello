const express = require('express');
const router = express.Router();
const db = require('../config/db');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// PATCH /api/tasks/:taskId - Update title and/or description
router.patch('/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { title, description } = req.body;

    if (!UUID_REGEX.test(taskId)) {
      return res.status(400).json({ error: 'Invalid task UUID format' });
    }

    // Get board_id
    const taskInfo = await db.query(
      `SELECT t.id, t.column_id, c.board_id
       FROM tasks t
       JOIN columns c ON c.id = t.column_id
       WHERE t.id = $1`,
      [taskId]
    );

    if (taskInfo.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const { board_id } = taskInfo.rows[0];

    const updateRes = await db.query(
      `UPDATE tasks
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           updated_at = now()
       WHERE id = $3
       RETURNING id, column_id, title, description, position, version, created_at, updated_at`,
      [title !== undefined ? title.trim() : null, description !== undefined ? description.trim() : null, taskId]
    );

    const updatedTask = updateRes.rows[0];

    const io = req.app.get('io');
    if (io) {
      io.to(`board:${board_id}`).emit('TASK_UPDATED', { boardId: board_id, ...updatedTask });
    }

    return res.json(updatedTask);
  } catch (err) {
    console.error('Error updating task:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/tasks/:taskId - Delete a task
router.delete('/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;

    if (!UUID_REGEX.test(taskId)) {
      return res.status(400).json({ error: 'Invalid task UUID format' });
    }

    const taskInfo = await db.query(
      `SELECT t.id, t.column_id, c.board_id
       FROM tasks t
       JOIN columns c ON c.id = t.column_id
       WHERE t.id = $1`,
      [taskId]
    );

    if (taskInfo.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const { board_id, column_id } = taskInfo.rows[0];

    await db.query('DELETE FROM tasks WHERE id = $1', [taskId]);

    const io = req.app.get('io');
    if (io) {
      io.to(`board:${board_id}`).emit('TASK_DELETED', {
        boardId: board_id,
        columnId: column_id,
        taskId,
      });
    }

    return res.json({ message: 'Task deleted successfully', taskId });
  } catch (err) {
    console.error('Error deleting task:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
