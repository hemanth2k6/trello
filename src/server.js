require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const boardsRouter = require('./routes/boards');
const { connectRedis } = require('./config/redis');
const { setupSocket } = require('./socket');

const app = express();
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/boards', boardsRouter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const server = http.createServer(app);
const io = setupSocket(server);

async function start(port) {
  const listenPort = port || process.env.PORT || 3000;
  await connectRedis();
  return new Promise((resolve) => {
    server.listen(listenPort, () => {
      console.log(`Server listening on port ${listenPort}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = { app, server, io, start };
