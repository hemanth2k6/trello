const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { pubClient, subClient } = require('../config/redis');
const { persistTaskMove, getTaskById } = require('./persistence');

function setupSocket(server) {
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  io.adapter(createAdapter(pubClient, subClient));

  io.on('connection', (socket) => {
    // Client joins a specific board room
    socket.on('join_board', (boardId) => {
      if (boardId) {
        socket.join(`board:${boardId}`);
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

        // Fire-and-forget broadcast to all clients in the board room
        io.to(`board:${boardId}`).emit('TASK_MOVED', {
          boardId,
          ...updatedTask,
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
