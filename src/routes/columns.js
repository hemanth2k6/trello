const express = require('express');
const router = express.Router();
const db = require('../config/db');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// PATCH /api/columns/:columnId - Rename column
router.patch('/:columnId', async (req, res) => {
  try {
    const { columnId } = req.params;
    const { title } = req.body;

    if (!UUID_REGEX.test(columnId)) {
      return res.status(400).json({ error: 'Invalid column UUID format' });
    }
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Column title is required' });
    }

    const colRes = await db.query(
      'UPDATE columns SET title = $1 WHERE id = $2 RETURNING id, board_id, title, position',
      [title.trim(), columnId]
    );

    if (colRes.rows.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    const column = colRes.rows[0];

    const io = req.app.get('io');
    if (io) {
      io.to(`board:${column.board_id}`).emit('COLUMN_UPDATED', {
        boardId: column.board_id,
        column,
      });
    }

    return res.json(column);
  } catch (err) {
    console.error('Error updating column:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/columns/:columnId - Delete column and its tasks
router.delete('/:columnId', async (req, res) => {
  try {
    const { columnId } = req.params;

    if (!UUID_REGEX.test(columnId)) {
      return res.status(400).json({ error: 'Invalid column UUID format' });
    }

    const colRes = await db.query(
      'DELETE FROM columns WHERE id = $1 RETURNING id, board_id',
      [columnId]
    );

    if (colRes.rows.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    const { id, board_id } = colRes.rows[0];

    const io = req.app.get('io');
    if (io) {
      io.to(`board:${board_id}`).emit('COLUMN_DELETED', {
        boardId: board_id,
        columnId: id,
      });
    }

    return res.json({ message: 'Column deleted successfully', columnId: id });
  } catch (err) {
    console.error('Error deleting column:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
