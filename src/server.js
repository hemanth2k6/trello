require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const boardsRouter = require('./routes/boards');

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

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

module.exports = { app, server };
