const assert = require('assert');
const { io: Client } = require('socket.io-client');
const { server, start } = require('../src/server');
const { pool } = require('../src/config/db');
const { disconnectRedis } = require('../src/config/redis');

async function runE2ETests() {
  console.log('--- STARTING COMPREHENSIVE E2E VERIFICATION ---');

  const PORT = 3010;
  process.env.PGHOST = '/tmp';
  process.env.PGPORT = '5434';
  process.env.PGDATABASE = 'trello';
  process.env.PGUSER = 'postgres';
  process.env.REDIS_SOCKET = '/tmp/redis.sock';

  // 1. Boot server (automatically initializes schema & connects Redis)
  await start(PORT);
  console.log(`[PASS] Server booted on port ${PORT} with DB schema & Redis adapter`);

  const baseUrl = `http://localhost:${PORT}`;

  // 2. Health check
  const healthRes = await fetch(`${baseUrl}/health`);
  assert.strictEqual(healthRes.status, 200);
  const healthData = await healthRes.json();
  assert.strictEqual(healthData.status, 'ok');
  console.log('[PASS] Health check verified: 200 OK');

  // 3. Static asset delivery
  const htmlRes = await fetch(`${baseUrl}/`);
  assert.strictEqual(htmlRes.status, 200);
  const htmlText = await htmlRes.text();
  assert.ok(htmlText.includes('CollabBoard'), 'HTML contains app title');

  const cssRes = await fetch(`${baseUrl}/style.css`);
  assert.strictEqual(cssRes.status, 200);

  const jsRes = await fetch(`${baseUrl}/app.js`);
  assert.strictEqual(jsRes.status, 200);
  console.log('[PASS] Static assets verified (HTML, CSS, JS served)');

  // 4. Board Creation & Aggregated Fetch
  const createBoardRes = await fetch(`${baseUrl}/api/boards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Production Roadmap' }),
  });
  assert.strictEqual(createBoardRes.status, 201);
  const board = await createBoardRes.json();
  assert.ok(board.id, 'Board has valid UUID');
  assert.strictEqual(board.title, 'Production Roadmap');
  console.log('[PASS] Board created:', board.id);

  // List boards
  const listBoardsRes = await fetch(`${baseUrl}/api/boards`);
  const boardsList = await listBoardsRes.json();
  assert.ok(Array.isArray(boardsList));
  assert.ok(boardsList.some((b) => b.id === board.id));
  console.log('[PASS] Boards list contains newly created board');

  // Aggregated board fetch
  const getBoardRes = await fetch(`${baseUrl}/api/boards/${board.id}`);
  assert.strictEqual(getBoardRes.status, 200);
  const boardState = await getBoardRes.json();
  assert.strictEqual(boardState.board_id, board.id);
  assert.strictEqual(boardState.board_title, 'Production Roadmap');
  assert.ok(Array.isArray(boardState.columns), 'Columns is an array');
  assert.strictEqual(boardState.columns.length, 3, 'Default 3 columns created');
  console.log('[PASS] Aggregated board state returned in single query with default columns');

  const col1 = boardState.columns[0];
  const col2 = boardState.columns[1];

  // 5. Connect 2 Socket.io clients
  const client1 = Client(baseUrl);
  const client2 = Client(baseUrl);

  await Promise.all([
    new Promise((resolve) => client1.on('connect', resolve)),
    new Promise((resolve) => client2.on('connect', resolve)),
  ]);
  console.log('[PASS] Two Socket.io clients connected');

  client1.emit('join_board', board.id);
  client2.emit('join_board', board.id);
  await new Promise((r) => setTimeout(r, 200));

  // 6. Test Column Creation & Real-Time Broadcast
  const colPromise = new Promise((resolve) => {
    client2.on('COLUMN_CREATED', (data) => {
      assert.strictEqual(data.boardId, board.id);
      assert.strictEqual(data.column.title, 'Review');
      resolve();
    });
  });

  const createColRes = await fetch(`${baseUrl}/api/boards/${board.id}/columns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Review' }),
  });
  assert.strictEqual(createColRes.status, 201);
  await colPromise;
  console.log('[PASS] Column created via REST and broadcast to Socket client');

  // 7. Test Task Creation & Real-Time Broadcast
  const taskCreatedPromise = new Promise((resolve) => {
    client2.on('TASK_CREATED', (data) => {
      assert.strictEqual(data.title, 'Deploy to Free Tier');
      assert.strictEqual(data.version, 0);
      resolve(data);
    });
  });

  const createTaskRes = await fetch(`${baseUrl}/api/boards/${board.id}/columns/${col1.id}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Deploy to Free Tier',
      description: 'Configure Render/Railway free tier deployment',
    }),
  });
  assert.strictEqual(createTaskRes.status, 201);
  const createdTask = await taskCreatedPromise;
  console.log('[PASS] Task created with version 0 and broadcast in real-time');

  // 8. Test Optimistic Concurrency Control (OCC) Task Move
  const taskMovedPromise = new Promise((resolve) => {
    client2.on('TASK_MOVED', (data) => {
      assert.strictEqual(data.id, createdTask.id);
      assert.strictEqual(data.column_id, col2.id);
      assert.strictEqual(data.version, 1);
      resolve(data);
    });
  });

  // Client 1 moves task to col2 with version 0
  client1.emit('TASK_MOVED', {
    boardId: board.id,
    taskId: createdTask.id,
    columnId: col2.id,
    position: 2500,
    version: 0,
  });

  await taskMovedPromise;
  console.log('[PASS] Task move committed and broadcast with incremented version 1');

  // Now Client 2 sends a conflicting move with stale version 0
  const conflictPromise = new Promise((resolve) => {
    client2.on('TASK_MOVE_REJECTED', (data) => {
      assert.strictEqual(data.taskId, createdTask.id);
      assert.ok(data.latestTask, 'Includes latest task state');
      assert.strictEqual(data.latestTask.version, 1);
      resolve(data);
    });
  });

  client2.emit('TASK_MOVED', {
    boardId: board.id,
    taskId: createdTask.id,
    columnId: col1.id,
    position: 1200,
    version: 0, // STALE! Database is already at version 1
  });

  await conflictPromise;
  console.log('[PASS] Optimistic lock conflict correctly rejected and latest state sent to caller');

  // 9. Test Task Edit
  const updateTaskRes = await fetch(`${baseUrl}/api/tasks/${createdTask.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Deploy to Free Tier (Updated)' }),
  });
  assert.strictEqual(updateTaskRes.status, 200);
  const updatedTaskData = await updateTaskRes.json();
  assert.strictEqual(updatedTaskData.title, 'Deploy to Free Tier (Updated)');
  console.log('[PASS] Task updated successfully');

  // 10. Test Task Deletion
  const deleteTaskRes = await fetch(`${baseUrl}/api/tasks/${createdTask.id}`, {
    method: 'DELETE',
  });
  assert.strictEqual(deleteTaskRes.status, 200);
  console.log('[PASS] Task deleted successfully');

  // Clean up
  client1.disconnect();
  client2.disconnect();
  await disconnectRedis();
  server.close();
  await pool.end();

  console.log('--- ALL E2E ACCEPTANCE TESTS PASSED SUCCESSFULLY! ---');
  process.exit(0);
}

runE2ETests().catch((err) => {
  console.error('E2E TEST FAILURE:', err);
  process.exit(1);
});
