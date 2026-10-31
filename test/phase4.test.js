const { io: Client } = require('socket.io-client');
const jwt = require('jsonwebtoken');
const { pool } = require('../src/config/db');
const { server, start } = require('../src/server');
const { disconnectRedis } = require('../src/config/redis');

async function runTest() {
  const PORT = 3006;
  process.env.PGHOST = '/tmp';
  process.env.PGPORT = '5433';
  process.env.PGDATABASE = 'trello';
  process.env.PGUSER = 'postgres';
  process.env.REDIS_SOCKET = '/tmp/redis.sock';

  // Seed board, column, task
  const boardRes = await pool.query("INSERT INTO boards (title) VALUES ('Phase 4 Board') RETURNING id");
  const boardId = boardRes.rows[0].id;

  // Seed user and membership
  const uRes = await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'hash') RETURNING id, email",
    [`phase4_${Date.now()}@test.com`]
  );
  const user = uRes.rows[0];
  const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET || 'super-secret-task-board-jwt-key');
  await pool.query("INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'owner')", [boardId, user.id]);

  const colRes = await pool.query(
    "INSERT INTO columns (board_id, title, position) VALUES ($1, 'Column 1', 1000), ($1, 'Column 2', 2000) RETURNING id",
    [boardId]
  );
  const col1Id = colRes.rows[0].id;
  const col2Id = colRes.rows[1].id;

  const taskRes = await pool.query(
    "INSERT INTO tasks (column_id, title, position, version) VALUES ($1, 'Concurrent Task', 1000, 0) RETURNING id, version",
    [col1Id]
  );
  const taskId = taskRes.rows[0].id;
  console.log(`Seeded task ${taskId} with version:`, taskRes.rows[0].version);

  await start(PORT);
  console.log(`Server listening on port ${PORT}`);

  const client1 = Client(`http://localhost:${PORT}`, { auth: { token } });
  const client2 = Client(`http://localhost:${PORT}`, { auth: { token } });

  await Promise.all([
    new Promise((resolve) => client1.on('connect', resolve)),
    new Promise((resolve) => client2.on('connect', resolve)),
  ]);
  console.log('Both clients connected');

  client1.emit('join_board', boardId);
  client2.emit('join_board', boardId);

  await new Promise((r) => setTimeout(r, 200));

  let movesReceived = 0;
  let rejectsReceived = 0;
  let rejectedClientData = null;

  client1.on('TASK_MOVE_REJECTED', (data) => {
    console.log('Client 1 received TASK_MOVE_REJECTED:', data);
    rejectsReceived++;
    rejectedClientData = data;
  });

  client2.on('TASK_MOVE_REJECTED', (data) => {
    console.log('Client 2 received TASK_MOVE_REJECTED:', data);
    rejectsReceived++;
    rejectedClientData = data;
  });

  client1.on('TASK_MOVED', (data) => {
    console.log('Client 1 received broadcast TASK_MOVED (version):', data.version);
    movesReceived++;
  });

  client2.on('TASK_MOVED', (data) => {
    console.log('Client 2 received broadcast TASK_MOVED (version):', data.version);
    movesReceived++;
  });

  console.log('Sending two concurrent TASK_MOVED events with version: 0...');
  // Send concurrent moves from both clients targeting different positions / columns
  client1.emit('TASK_MOVED', {
    boardId,
    taskId,
    columnId: col2Id,
    position: 1500,
    version: 0,
  });

  client2.emit('TASK_MOVED', {
    boardId,
    taskId,
    columnId: col2Id,
    position: 2500,
    version: 0,
  });

  // Wait for events to process
  await new Promise((resolve) => setTimeout(resolve, 1500));

  console.log(`Results: rejectsReceived=${rejectsReceived}, movesReceived=${movesReceived}`);

  // Acceptance criteria:
  // Exactly one TASK_MOVE_REJECTED event must be received across clients
  if (rejectsReceived !== 1) {
    throw new Error(`Expected exactly 1 rejection, got ${rejectsReceived}`);
  }

  // Exactly one move succeeded, broadcast to both clients (so 2 total receive events)
  if (movesReceived !== 2) {
    throw new Error(`Expected exactly 2 TASK_MOVED broadcast events (1 per client), got ${movesReceived}`);
  }

  // Check the task in DB has version 1
  const checkRes = await pool.query('SELECT version FROM tasks WHERE id = $1', [taskId]);
  if (checkRes.rows[0].version !== 1) {
    throw new Error(`Expected task version to be 1 in DB, got ${checkRes.rows[0].version}`);
  }

  // Check the rejected event contains latest task info
  if (!rejectedClientData || !rejectedClientData.latestTask || rejectedClientData.latestTask.version !== 1) {
    throw new Error('Rejected event does not contain latestTask with version 1');
  }

  console.log('PHASE 4 ACCEPTANCE TEST PASSED: Optimistic concurrency rejected conflict as expected!');

  client1.disconnect();
  client2.disconnect();
  await disconnectRedis();
  server.close();
  await pool.end();
  process.exit(0);
}

runTest().catch((err) => {
  console.error('Phase 4 Test failed:', err);
  process.exit(1);
});
