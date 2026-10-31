const assert = require('assert');
const { io: Client } = require('socket.io-client');
const { server, start } = require('../src/server');
const { pool } = require('../src/config/db');
const { disconnectRedis } = require('../src/config/redis');

async function runFeature2AcceptanceTest() {
  console.log('=== FEATURE 2 ACCEPTANCE TEST: EVENT LOG ===');
  const PORT = 3022;
  const baseUrl = `http://localhost:${PORT}`;

  await start(PORT);

  // 1. Register user
  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `event_user_${Date.now()}@example.com`, password: 'password123' }),
  });
  assert.strictEqual(regRes.status, 201);
  const { token, user } = await regRes.json();

  // 2. Create board
  const createBoardRes = await fetch(`${baseUrl}/api/boards`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ title: 'Event Log Board' }),
  });
  assert.strictEqual(createBoardRes.status, 201);
  const board = await createBoardRes.json();
  const boardId = board.id;

  // 3. Fetch board to get column
  const boardRes = await fetch(`${baseUrl}/api/boards/${boardId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const boardState = await boardRes.json();
  const col1Id = boardState.columns[0].id;
  const col2Id = boardState.columns[1].id;

  // 4. Seed task in DB
  const tRes = await pool.query(
    'INSERT INTO tasks (column_id, title, position, version) VALUES ($1, $2, $3, 0) RETURNING id',
    [col1Id, 'Event Task', 1000]
  );
  const taskId = tRes.rows[0].id;

  // 5. Connect Socket client with auth token
  const client = Client(baseUrl, {
    auth: { token },
    transports: ['websocket'],
  });

  await new Promise((resolve) => client.on('connect', resolve));
  client.emit('join_board', boardId);
  await new Promise((r) => setTimeout(r, 200));

  // 6. Move task via Socket
  const movePromise = new Promise((resolve) => {
    client.on('TASK_MOVED', (data) => resolve(data));
  });

  client.emit('TASK_MOVED', {
    boardId,
    taskId,
    columnId: col2Id,
    position: 2500,
    version: 0,
  });

  const movedData = await movePromise;
  assert.strictEqual(movedData.id, taskId);
  console.log('[PASS] Task moved successfully via socket');

  // 7. Call GET /api/boards/:boardId/events?limit=50
  const eventsRes = await fetch(`${baseUrl}/api/boards/${boardId}/events?limit=50`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(eventsRes.status, 200, 'GET /events returned 200');

  const events = await eventsRes.json();
  assert.ok(Array.isArray(events), 'Events response is an array');
  assert.ok(events.length >= 1, 'Events array contains at least 1 event');

  const latestEvent = events[0];
  assert.strictEqual(latestEvent.event_type, 'TASK_MOVED');
  assert.strictEqual(latestEvent.board_id, boardId);
  assert.strictEqual(latestEvent.actor_user_id, user.id);
  assert.strictEqual(latestEvent.payload.id, taskId);
  assert.strictEqual(latestEvent.payload.column_id, col2Id);
  assert.strictEqual(latestEvent.payload.moved_by, user.id);
  console.log('[PASS] GET /api/boards/:boardId/events returned TASK_MOVED event with matching payload and actor_user_id');

  // 8. Test member-only access to events
  const unauthEventsRes = await fetch(`${baseUrl}/api/boards/${boardId}/events`);
  assert.strictEqual(unauthEventsRes.status, 401, 'Unauthenticated request to /events returns 401');

  // Register non-member
  const regOther = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `other_${Date.now()}@example.com`, password: 'password123' }),
  });
  const { token: otherToken } = await regOther.json();
  const nonMemberEventsRes = await fetch(`${baseUrl}/api/boards/${boardId}/events`, {
    headers: { Authorization: `Bearer ${otherToken}` },
  });
  assert.strictEqual(nonMemberEventsRes.status, 403, 'Non-member request to /events returns 403');
  console.log('[PASS] Member-only protection on events endpoint confirmed (401 and 403)');

  // Clean up
  client.disconnect();
  await disconnectRedis();
  server.close();
  await pool.end();
  console.log('=== FEATURE 2 ACCEPTANCE TESTS COMPLETED SUCCESSFULLY ===');
}

runFeature2AcceptanceTest().catch((err) => {
  console.error('Feature 2 test failed:', err);
  process.exit(1);
});
