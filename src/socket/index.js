const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
const { pool } = require('../config/db');
const { pubClient, subClient } = require('../config/redis');
const { persistTaskMove, getTaskById, recordBoardEvent } = require('./persistence');

function setupSocket(server) {
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  io.adapter(createAdapter(pubClient, subClient));

  // Connection middleware to validate JWT token
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      (socket.handshake.headers?.authorization?.startsWith('Bearer ')
        ? socket.handshake.headers.authorization.slice(7)
        : socket.handshake.headers?.authorization);

    if (!token) {
      return next(new Error('Authentication error: invalid or missing token'));
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.user = decoded;
      return next();
    } catch (err) {
      return next(new Error('Authentication error: invalid or missing token'));
    }
  });

  io.on('connection', (socket) => {
    // Client joins a specific board room after verifying membership
    socket.on('join_board', async (boardId) => {
      try {
        if (!boardId) return;

        const userId = socket.user?.id;
        const memberCheck = await pool.query(
          'SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2',
          [boardId, userId]
        );

        if (memberCheck.rows.length === 0) {
          socket.emit('error', { message: 'Not a board member', boardId });
          socket.emit('join_board_error', { error: 'Not a board member', boardId });
          return;
        }

        socket.join(`board:${boardId}`);
      } catch (err) {
        console.error('Error handling join_board:', err);
        socket.emit('error', { message: 'Internal server error', boardId });
      }
    });

    // Client leaves a specific board room
    socket.on('leave_board', (boardId) => {
      if (boardId) {
        socket.leave(`board:${boardId}`);
      }
    });

    // Handle task move event with optimistic concurrency
    socket.on('TASK_MOVED', async (data) => {
      try {
        const {
          boardId,
          taskId,
          columnId,
          targetColumnId,
          position,
          targetPosition,
          version,
          clientVersion,
        } = data || {};

        const colId = columnId || targetColumnId;
        const pos = position !== undefined ? position : targetPosition;
        const ver = version !== undefined ? version : clientVersion;

        // Persist the move using optimistic concurrency check
        const updatedTask = await persistTaskMove({
          taskId,
          columnId: colId,
          position: pos,
          version: ver,
        });

        // If version check failed (rowCount === 0), reject ONLY to originating socket
        if (!updatedTask) {
          const latestTask = await getTaskById(taskId);
          socket.emit('TASK_MOVE_REJECTED', {
            taskId,
            message: 'Conflict: Task version mismatch',
            clientVersion: ver,
            latestTask,
          });
          return;
        }

        const movedBy = socket.user?.id;
        const payload = {
          boardId,
          ...updatedTask,
          moved_by: movedBy,
        };

        // Record in board_events table
        await recordBoardEvent({
          boardId,
          eventType: 'TASK_MOVED',
          payload,
          actorUserId: movedBy,
        });

        // Fire-and-forget broadcast to all clients in the board room
        io.to(`board:${boardId}`).emit('TASK_MOVED', payload);
      } catch (err) {
        console.error('Error handling TASK_MOVED:', err);
        socket.emit('TASK_MOVE_REJECTED', {
          taskId: data?.taskId,
          error: 'Internal server error',
        });
      }
    });
  });

  return io;
}

module.exports = {
  setupSocket,
};
