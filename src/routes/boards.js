const express = require('express');
const router = express.Router();
const db = require('../config/db');

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Create a new board (convenience helper)
router.post('/', async (req, res) => {
  try {
    const { title } = req.body;
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'Title is required' });
    }

    const result = await db.query(
      'INSERT INTO boards (title) VALUES ($1) RETURNING id, title, created_at',
      [title.trim()]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating board:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/boards/:boardId - Returns aggregated board state with columns and tasks
router.get('/:boardId', async (req, res) => {
  try {
    const { boardId } = req.params;

    if (!UUID_REGEX.test(boardId)) {
      return res.status(400).json({ error: 'Invalid board UUID format' });
    }

    const query = `
      SELECT
        b.id AS board_id,
        b.title AS board_title,
        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'id', c.id,
                'title', c.title,
                'position', c.position,
                'tasks', COALESCE(
                  (
                    SELECT json_agg(
                      json_build_object(
                        'id', t.id,
                        'title', t.title,
                        'description', t.description,
                        'position', t.position,
                        'version', t.version,
                        'created_at', t.created_at,
                        'updated_at', t.updated_at
                      ) ORDER BY t.position ASC
                    )
                    FROM tasks t
                    WHERE t.column_id = c.id
                  ),
                  '[]'::json
                )
              ) ORDER BY c.position ASC
            )
            FROM columns c
            WHERE c.board_id = b.id
          ),
          '[]'::json
        ) AS columns
      FROM boards b
      WHERE b.id = $1;
    `;

    const result = await db.query(query, [boardId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Board not found' });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching board:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
