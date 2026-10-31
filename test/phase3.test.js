const { io: Client } = require('socket.io-client');
const jwt = require('jsonwebtoken');
const { pool } = require('../src/config/db');
const { server, start } = require('../src/server');
const { disconnectRedis } = require('../src/config/redis');

async function runTest() {
  const PORT = 3005;

  // Seed board, column, task
  const bRes = await pool.query("INSERT INTO boards (title) VALUES ('Phase 3 Board') RETURNING id");
  const boardId = bRes.rows[0].id;
  const cRes = await pool.query("INSERT INTO columns (board_id, title, position) VALUES ($1, 'Col 1', 1000) RETURNING id", [boardId]);
  const columnId = cRes.rows[0].id;
  const tRes = await pool.query("INSERT INTO tasks (column_id, title, position, version) VALUES ($1, 'Test Task', 1000, 0) RETURNING id", [columnId]);
  const taskId = tRes.rows[0].id;

  // Seed user and board membership for JWT auth
  const uRes = await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'hash') RETURNING id, email",
    [`phase3_${Date.now()}@test.com`]
  );
  const user = uRes.rows[0];
  const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET || 'super-secret-task-board-jwt-key');
  await pool.query("INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'owner')", [boardId, user.id]);

  await start(PORT);
  console.log(`Test server started on port ${PORT}`);

  const client1 = Client(`http://localhost:${PORT}`, { auth: { token } });
  const client2 = Client(`http://localhost:${PORT}`, { auth: { token } });

  let client1Received = false;
  let client2Received = false;

  await Promise.all([
    new Promise((resolve) => client1.on('connect', resolve)),
    new Promise((resolve) => client2.on('connect', resolve)),
  ]);
  console.log('Both Socket.io clients connected');

  // Both clients join the board room
  client1.emit('join_board', boardId);
  client2.emit('join_board', boardId);

  // Give socket rooms a moment to synchronize
  await new Promise((r) => setTimeout(r, 200));

  const completionPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout: client1Received=${client1Received}, client2Received=${client2Received}`));
    }, 5000);

    client1.on('TASK_MOVED', (data) => {
      console.log('Client 1 received TASK_MOVED:', data);
      client1Received = true;
      if (client1Received && client2Received) {
        clearTimeout(timeout);
        resolve();
      }
    });

    client2.on('TASK_MOVED', (data) => {
      console.log('Client 2 received TASK_MOVED:', data);
      client2Received = true;
      if (client1Received && client2Received) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  // Client 1 emits TASK_MOVED
  console.log('Client 1 emitting TASK_MOVED...');
  client1.emit('TASK_MOVED', {
    boardId,
    taskId,
    columnId,
    position: 2500,
    version: 0,
  });

  await completionPromise;
  console.log('PHASE 3 ACCEPTANCE TEST PASSED: Both clients received TASK_MOVED!');

  client1.disconnect();
  client2.disconnect();
  await disconnectRedis();
  server.close();
  await pool.end();
  process.exit(0);
}

runTest().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
