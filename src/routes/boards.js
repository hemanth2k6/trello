const express = require('express');
const router = express.Router();
const db = require('../config/db');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// GET /api/boards - List all boards
router.get('/', async (req, res) => {
  try {
    const query = `
      SELECT b.id, b.title, b.created_at,
             COUNT(DISTINCT c.id)::int AS column_count,
             COUNT(DISTINCT t.id)::int AS task_count
      FROM boards b
      LEFT JOIN columns c ON c.board_id = b.id
      LEFT JOIN tasks t ON t.column_id = c.id
      GROUP BY b.id
      ORDER BY b.created_at DESC;
    `;
    const result = await db.query(query);
    return res.json(result.rows);
  } catch (err) {
    console.error('Error fetching boards:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/boards - Create a new board
router.post('/', async (req, res) => {
  try {
    const { title } = req.body;
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const result = await db.query(
      'INSERT INTO boards (title) VALUES ($1) RETURNING id, title, created_at',
      [title.trim()]
    );

    // Create default columns for convenience: "To Do", "In Progress", "Done"
    const boardId = result.rows[0].id;
    await db.query(
      `INSERT INTO columns (board_id, title, position) VALUES
       ($1, 'To Do', 1000),
       ($1, 'In Progress', 2000),
       ($1, 'Done', 3000)`,
      [boardId]
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

// POST /api/boards/:boardId/columns - Add a column to a board
router.post('/:boardId/columns', async (req, res) => {
  try {
    const { boardId } = req.params;
    const { title } = req.body;

    if (!UUID_REGEX.test(boardId)) {
      return res.status(400).json({ error: 'Invalid board UUID format' });
    }
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Column title is required' });
    }

    // Check board exists
    const bCheck = await db.query('SELECT id FROM boards WHERE id = $1', [boardId]);
    if (bCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Board not found' });
    }

    // Determine position
    const posRes = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1000 AS next_pos FROM columns WHERE board_id = $1',
      [boardId]
    );
    const position = posRes.rows[0].next_pos;

    const colRes = await db.query(
      'INSERT INTO columns (board_id, title, position) VALUES ($1, $2, $3) RETURNING id, board_id, title, position',
      [boardId, title.trim(), position]
    );

    const column = { ...colRes.rows[0], tasks: [] };

    // Real-time broadcast
    const io = req.app.get('io');
    if (io) {
      io.to(`board:${boardId}`).emit('COLUMN_CREATED', { boardId, column });
    }

    return res.status(201).json(column);
  } catch (err) {
    console.error('Error creating column:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/boards/:boardId/columns/:columnId/tasks - Add a task to a column
router.post('/:boardId/columns/:columnId/tasks', async (req, res) => {
  try {
    const { boardId, columnId } = req.params;
    const { title, description } = req.body;

    if (!UUID_REGEX.test(boardId) || !UUID_REGEX.test(columnId)) {
      return res.status(400).json({ error: 'Invalid UUID format' });
    }
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Task title is required' });
    }

    // Verify column belongs to board
    const colCheck = await db.query(
      'SELECT id, board_id FROM columns WHERE id = $1 AND board_id = $2',
      [columnId, boardId]
    );
    if (colCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Column not found on this board' });
    }

    // Determine task position
    const posRes = await db.query(
      'SELECT COALESCE(MAX(position), 0) + 1000 AS next_pos FROM tasks WHERE column_id = $1',
      [columnId]
    );
    const position = posRes.rows[0].next_pos;

    const taskRes = await db.query(
      `INSERT INTO tasks (column_id, title, description, position, version)
       VALUES ($1, $2, $3, $4, 0)
       RETURNING id, column_id, title, description, position, version, created_at, updated_at`,
      [columnId, title.trim(), description ? description.trim() : null, position]
    );

    const task = taskRes.rows[0];

    // Real-time broadcast
    const io = req.app.get('io');
    if (io) {
      io.to(`board:${boardId}`).emit('TASK_CREATED', { boardId, ...task });
    }

    return res.status(201).json(task);
  } catch (err) {
    console.error('Error creating task:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
