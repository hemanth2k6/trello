const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
const { pool } = require('../config/db');
const { pubClient, subClient, redisClient } = require('../config/redis');
const { persistTaskMove, getTaskById } = require('./persistence');
const { asyncEventWriter } = require('./asyncWriter');

/**
 * Initializes and configures the WebSocket server with Redis Pub/Sub adapter.
 *
 * @param {import('http').Server} server - Native HTTP server instance
 * @returns {Server} Configured Socket.io server instance
 */
function setupSocket(server) {
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  // ---------------------------------------------------------------------------
  // REDIS PUB/SUB ADAPTER: The multi-server broadcast backbone
  // ---------------------------------------------------------------------------
  // When io.to(room).emit() is called on this server instance (e.g. Server 1):
  // 1. Redis adapter serializes the event packet.
  // 2. pubClient publishes the packet to Redis channel: "socket.io#/<room>#"
  // 3. Redis fans out the packet to all subscribed server replicas (e.g. Server 2).
  // 4. subClient on Server 2 receives the packet and emits it to local sockets in that room.
  io.adapter(createAdapter(pubClient, subClient));

  // ---------------------------------------------------------------------------
  // Connection Authentication Middleware
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // Socket Connection Lifecycle & Events
  // ---------------------------------------------------------------------------
  io.on('connection', (socket) => {
    socket.boards = new Set();
    const serverInstance = process.env.INSTANCE_ID || 'server-node-1';

    // Client requests to join a board room
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
        socket.boards.add(boardId);

        // Track presence across cluster in Redis sorted set
        const presenceKey = `presence:${boardId}`;
        let onlineUsers = [];
        if (redisClient.isOpen) {
          const now = Date.now();
          await redisClient.zAdd(presenceKey, [{ score: now, value: userId }]);
          onlineUsers = await redisClient.zRange(presenceKey, 0, -1);
        }

        // Emit current online users to joining socket
        socket.emit('online_users', { boardId, users: onlineUsers });
        socket.emit('presence_current', { boardId, users: onlineUsers });

        // Deliver presence of existing members
        for (const existingUserId of onlineUsers) {
          if (existingUserId !== userId) {
            socket.emit('presence_update', {
              boardId,
              users: onlineUsers,
              userId: existingUserId,
              action: 'join',
            });
          }
        }

        // Broadcast join across cluster via Redis Pub/Sub adapter
        io.to(`board:${boardId}`).emit('presence_update', {
          boardId,
          users: onlineUsers,
          userId,
          action: 'join',
        });
      } catch (err) {
        console.error('Error handling join_board:', err);
        socket.emit('error', { message: 'Internal server error', boardId });
      }
    });

    // Client explicitly leaves a board room
    socket.on('leave_board', async (boardId) => {
      try {
        if (!boardId) return;
        socket.leave(`board:${boardId}`);
        if (socket.boards) {
          socket.boards.delete(boardId);
        }

        const userId = socket.user?.id;
        if (userId && redisClient.isOpen) {
          const presenceKey = `presence:${boardId}`;
          await redisClient.zRem(presenceKey, userId);
          const remainingUsers = await redisClient.zRange(presenceKey, 0, -1);

          io.to(`board:${boardId}`).emit('presence_update', {
            boardId,
            users: remainingUsers,
            userId,
            action: 'leave',
          });
        }
      } catch (err) {
        console.error('Error handling leave_board:', err);
      }
    });

    // Client heartbeat ping every 25s-30s to maintain presence
    socket.on('heartbeat', async (data) => {
      try {
        const userId = socket.user?.id;
        if (!userId || !redisClient.isOpen) return;

        const boardId = typeof data === 'string' ? data : data?.boardId;
        const now = Date.now();

        if (boardId) {
          await redisClient.zAdd(`presence:${boardId}`, [{ score: now, value: userId }]);
        } else if (socket.boards && socket.boards.size > 0) {
          for (const bId of socket.boards) {
            await redisClient.zAdd(`presence:${bId}`, [{ score: now, value: userId }]);
          }
        }
      } catch (err) {
        console.error('Error handling heartbeat:', err);
      }
    });

    // Client disconnecting (tab closed or network dropped)
    socket.on('disconnecting', async () => {
      try {
        const userId = socket.user?.id;
        if (!userId || !redisClient.isOpen) return;

        const rooms = Array.from(socket.rooms);
        for (const room of rooms) {
          if (room.startsWith('board:')) {
            const boardId = room.replace(/^board:/, '');
            const presenceKey = `presence:${boardId}`;
            await redisClient.zRem(presenceKey, userId);
            const remainingUsers = await redisClient.zRange(presenceKey, 0, -1);

            socket.to(room).emit('presence_update', {
              boardId,
              users: remainingUsers,
              userId,
              action: 'leave',
            });
          }
        }
      } catch (err) {
        console.error('Error handling disconnect presence:', err);
      }
    });

    // -------------------------------------------------------------------------
    // CORE DISTRIBUTED EVENT: TASK_MOVED
    // -------------------------------------------------------------------------
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

        // 1. Atomic Optimistic Concurrency Control (OCC) check
        const updatedTask = await persistTaskMove({
          taskId,
          columnId: colId,
          position: pos,
          version: ver,
        });

        // 2. Conflict Handling: Version mismatch occurs when another user moved it first
        if (!updatedTask) {
          const latestTask = await getTaskById(taskId);
          // Target sender only: snap back optimistic UI with authoritative state
          socket.emit('TASK_MOVE_REJECTED', {
            taskId,
            reason: 'CONCURRENCY_CONFLICT',
            message: 'Conflict: Task version mismatch. Another user moved this task first.',
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
          originServer: serverInstance,
          broadcastTimestamp: new Date().toISOString(),
        };

        // 3. IMMEDIATE REAL-TIME BROADCAST: Zero wait on secondary database logging
        // Emits to room via Redis Pub/Sub adapter to instantly update all peers
        io.to(`board:${boardId}`).emit('TASK_MOVED', payload);

        // 4. ASYNCHRONOUS WRITE-BEHIND: Offload audit logging to background queue
        // Buffers events and micro-batches inserts to PostgreSQL (non-blocking)
        asyncEventWriter.enqueue({
          boardId,
          eventType: 'TASK_MOVED',
          payload,
          actorUserId: movedBy,
        });
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
