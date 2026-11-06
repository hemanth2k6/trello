require('dotenv').config();
const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');

// Prevent unexpected socket drops from terminating the process
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Promise Rejection:', reason);
});

const authRouter = require('./routes/auth');
const boardsRouter = require('./routes/boards');
const columnsRouter = require('./routes/columns');
const tasksRouter = require('./routes/tasks');

const { initSchema, pool } = require('./config/db');
const { connectRedis, disconnectRedis } = require('./config/redis');
const { setupSocket } = require('./socket');
const { asyncEventWriter } = require('./socket/asyncWriter');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../public')));

// Create HTTP and Socket.io server
const server = http.createServer(app);
const io = setupSocket(server);

// Share io with Express routers
app.set('io', io);

// API Routes
app.use('/api/auth', authRouter);
app.use('/api/boards', boardsRouter);
app.use('/api/columns', columnsRouter);
app.use('/api/tasks', tasksRouter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    instance: process.env.INSTANCE_ID || 'single-node',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Single Page Application fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
    return next();
  }
  const indexPath = path.join(__dirname, '../public/index.html');
  res.sendFile(indexPath, (err) => {
    if (err) next();
  });
});

async function start(port) {
  const listenPort = port || process.env.PORT || 3000;
  // Initialize/verify database schema
  await initSchema();
  // Connect Redis clients for Socket.io adapter
  await connectRedis();
  return new Promise((resolve) => {
    server.listen(listenPort, () => {
      console.log(`Server (${process.env.INSTANCE_ID || 'default'}) listening on port ${listenPort}`);
      resolve(server);
    });
  });
}

// Graceful shutdown handling for container lifecycles (PID 1 via dumb-init)
async function gracefulShutdown(signal) {
  console.log(`Received ${signal}. Commencing graceful connection drain...`);
  server.close(async () => {
    try {
      // 1. Flush pending async write-behind events to PostgreSQL
      console.log('Flushing pending event logs to database...');
      await asyncEventWriter.flushAndDrain();
      // 2. Disconnect Redis pub/sub clients
      await disconnectRedis();
      // 3. End PostgreSQL pool
      await pool.end();
      console.log('All connections safely drained. Exiting cleanly.');
      process.exit(0);
    } catch (err) {
      console.error('Error during graceful shutdown:', err);
      process.exit(1);
    }
  });

  setTimeout(() => {
    console.error('Forced exit: Shutdown timed out after 10s.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = { app, server, io, start, gracefulShutdown };
