const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticateToken, optionalAuth } = require('../middleware/auth');

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
router.post('/', optionalAuth, async (req, res) => {
  try {
    const { title } = req.body;
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const result = await db.query(
      'INSERT INTO boards (title) VALUES ($1) RETURNING id, title, created_at',
      [title.trim()]
    );

    const boardId = result.rows[0].id;

    // Create default columns for convenience: "To Do", "In Progress", "Done"
    await db.query(
      `INSERT INTO columns (board_id, title, position) VALUES
       ($1, 'To Do', 1000),
       ($1, 'In Progress', 2000),
       ($1, 'Done', 3000)`,
      [boardId]
    );

    // If authenticated user created the board, make them owner
    if (req.user && req.user.id) {
      await db.query(
        `INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'owner')
         ON CONFLICT (board_id, user_id) DO NOTHING`,
        [boardId, req.user.id]
      );
    }

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating board:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/boards/:boardId - Returns aggregated board state with columns and tasks (members only)
router.get('/:boardId', authenticateToken, async (req, res) => {
  try {
    const { boardId } = req.params;

    if (!UUID_REGEX.test(boardId)) {
      return res.status(400).json({ error: 'Invalid board UUID format' });
    }

    // Check board existence
    const bCheck = await db.query('SELECT id FROM boards WHERE id = $1', [boardId]);
    if (bCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Board not found' });
    }

    // Check board membership
    const memberCheck = await db.query(
      'SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2',
      [boardId, req.user.id]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied: not a board member' });
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

    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching board:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/boards/:boardId/members - Add a user to a board
router.post('/:boardId/members', authenticateToken, async (req, res) => {
  try {
    const { boardId } = req.params;
    const { userId, email, role = 'member' } = req.body || {};

    if (!UUID_REGEX.test(boardId)) {
      return res.status(400).json({ error: 'Invalid board UUID format' });
    }

    // Verify requester is a board member
    const reqMember = await db.query(
      'SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2',
      [boardId, req.user.id]
    );
    if (reqMember.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied: not a board member' });
    }

    let targetUserId = userId;
    if (!targetUserId && email) {
      const uRes = await db.query('SELECT id FROM users WHERE email = $1', [email.trim().toLowerCase()]);
      if (uRes.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      targetUserId = uRes.rows[0].id;
    }

    if (!targetUserId || !UUID_REGEX.test(targetUserId)) {
      return res.status(400).json({ error: 'Valid userId or email is required' });
    }

    const validRole = role === 'owner' ? 'owner' : 'member';
    const insRes = await db.query(
      `INSERT INTO board_members (board_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (board_id, user_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING board_id, user_id, role, created_at`,
      [boardId, targetUserId, validRole]
    );

    return res.status(201).json(insRes.rows[0]);
  } catch (err) {
    console.error('Error adding board member:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/boards/:boardId/events - Returns activity event log (member-only)
router.get('/:boardId/events', authenticateToken, async (req, res) => {
  try {
    const { boardId } = req.params;
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 100);

    if (!UUID_REGEX.test(boardId)) {
      return res.status(400).json({ error: 'Invalid board UUID format' });
    }

    // Verify requester is a board member
    const reqMember = await db.query(
      'SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2',
      [boardId, req.user.id]
    );
    if (reqMember.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied: not a board member' });
    }

    const query = `
      SELECT id, board_id, event_type, payload, actor_user_id, created_at
      FROM board_events
      WHERE board_id = $1
      ORDER BY created_at DESC
      LIMIT $2;
    `;
    const result = await db.query(query, [boardId, limit]);
    return res.json(result.rows);
  } catch (err) {
    console.error('Error fetching board events:', err);
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
