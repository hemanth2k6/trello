const assert = require('assert');
const { io: Client } = require('socket.io-client');
const { server, start } = require('../src/server');
const { pool } = require('../src/config/db');
const { disconnectRedis } = require('../src/config/redis');

async function runFeature1AcceptanceTest() {
  console.log('=== FEATURE 1 ACCEPTANCE TEST: JWT AUTH & BOARD MEMBERSHIP ===');
  const PORT = 3021;
  const baseUrl = `http://localhost:${PORT}`;

  await start(PORT);

  // 1. Register two users: user1 (owner/member) and user2 (non-member)
  const reg1Res = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `user1_${Date.now()}@example.com`, password: 'password123' }),
  });
  assert.strictEqual(reg1Res.status, 201, 'User 1 registered');
  const user1Data = await reg1Res.json();
  const token1 = user1Data.token;
  const user1 = user1Data.user;
  assert.ok(token1 && user1.id, 'User 1 has token and id');

  const reg2Res = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `user2_${Date.now()}@example.com`, password: 'password123' }),
  });
  assert.strictEqual(reg2Res.status, 201, 'User 2 registered');
  const user2Data = await reg2Res.json();
  const token2 = user2Data.token;
  const user2 = user2Data.user;

  // Verify login works
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user1.email, password: 'password123' }),
  });
  assert.strictEqual(loginRes.status, 200, 'User 1 login successful');
  const loginData = await loginRes.json();
  assert.ok(loginData.token, 'Login returned valid token');

  // Create a board with User 1 as owner
  const createBoardRes = await fetch(`${baseUrl}/api/boards`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token1}`,
    },
    body: JSON.stringify({ title: 'Auth Secured Board' }),
  });
  assert.strictEqual(createBoardRes.status, 201, 'Board created');
  const board = await createBoardRes.json();
  const boardId = board.id;

  // --- ACCEPTANCE CRITERIA TEST ---
  // A. Unauthenticated request to board returns 401
  const unauthRes = await fetch(`${baseUrl}/api/boards/${boardId}`);
  assert.strictEqual(unauthRes.status, 401, 'Unauthenticated request returns 401');
  console.log('[PASS] Unauthenticated request to board returned 401');

  // B. Authenticated non-member request returns 403
  const nonMemberRes = await fetch(`${baseUrl}/api/boards/${boardId}`, {
    headers: { Authorization: `Bearer ${token2}` },
  });
  assert.strictEqual(nonMemberRes.status, 403, 'Authenticated non-member returns 403');
  console.log('[PASS] Authenticated non-member request to board returned 403');

  // C. Authenticated member request returns 200
  const memberRes = await fetch(`${baseUrl}/api/boards/${boardId}`, {
    headers: { Authorization: `Bearer ${token1}` },
  });
  assert.strictEqual(memberRes.status, 200, 'Authenticated member succeeds');
  const memberBoardData = await memberRes.json();
  assert.strictEqual(memberBoardData.board_id, boardId, 'Member gets board state');
  console.log('[PASS] Authenticated member request to board succeeded (200)');

  // --- SOCKET AUTH & MEMBERSHIP TESTS ---
  // D. Socket connection without token rejected
  const unauthSocket = Client(baseUrl, {
    transports: ['websocket'],
    reconnection: false,
  });

  const connectErrorReceived = await new Promise((resolve) => {
    unauthSocket.on('connect_error', (err) => {
      resolve(err.message);
    });
    unauthSocket.on('connect', () => {
      resolve(null);
    });
  });
  unauthSocket.close();
  assert.ok(
    connectErrorReceived && connectErrorReceived.includes('Authentication error'),
    'Unauthenticated socket connection rejected'
  );
  console.log('[PASS] Socket.io connection without token rejected');

  // E. Socket connection with valid token connects
  const client1 = Client(baseUrl, {
    auth: { token: token1 },
    transports: ['websocket'],
  });
  const client2 = Client(baseUrl, {
    auth: { token: token2 },
    transports: ['websocket'],
  });

  await Promise.all([
    new Promise((resolve) => client1.on('connect', resolve)),
    new Promise((resolve) => client2.on('connect', resolve)),
  ]);
  console.log('[PASS] Both authenticated Socket.io clients connected');

  // F. Non-member join_board is rejected with error event
  const joinErrorPromise = new Promise((resolve) => {
    client2.on('error', (err) => {
      resolve(err);
    });
    client2.on('join_board_error', (err) => {
      resolve(err);
    });
  });
  client2.emit('join_board', boardId);
  const joinError = await joinErrorPromise;
  assert.ok(joinError, 'Non-member join_board triggered error event');
  console.log('[PASS] Non-member join_board rejected with error event:', joinError);

  // G. Member join_board succeeds
  client1.emit('join_board', boardId);
  await new Promise((r) => setTimeout(r, 200));

  // Seed task for TASK_MOVED test
  const boardState = memberBoardData;
  const col1Id = boardState.columns[0].id;
  const col2Id = boardState.columns[1].id;
  const tRes = await pool.query(
    'INSERT INTO tasks (column_id, title, position, version) VALUES ($1, $2, $3, 0) RETURNING id',
    [col1Id, 'Auth Move Task', 1000]
  );
  const taskId = tRes.rows[0].id;

  // H. TASK_MOVED broadcasts payload with moved_by and records in board_events table
  const movePromise = new Promise((resolve) => {
    client1.on('TASK_MOVED', (data) => {
      resolve(data);
    });
  });

  client1.emit('TASK_MOVED', {
    boardId,
    taskId,
    columnId: col2Id,
    position: 2000,
    version: 0,
  });

  const movedPayload = await movePromise;
  assert.strictEqual(movedPayload.moved_by, user1.id, 'moved_by matches user1 id in payload');
  console.log('[PASS] TASK_MOVED payload includes moved_by: user.id');

  // Check event in board_events table
  const evRes = await pool.query(
    'SELECT * FROM board_events WHERE board_id = $1 AND event_type = $2',
    [boardId, 'TASK_MOVED']
  );
  assert.strictEqual(evRes.rows.length, 1, 'Event recorded in board_events table');
  assert.strictEqual(evRes.rows[0].actor_user_id, user1.id, 'actor_user_id matches user1');
  console.log('[PASS] Event recorded in board_events table with actor_user_id');

  // Cleanup
  client1.disconnect();
  client2.disconnect();
  await disconnectRedis();
  server.close();
  await pool.end();
  console.log('=== FEATURE 1 ACCEPTANCE TESTS COMPLETED SUCCESSFULLY ===');
}

runFeature1AcceptanceTest().catch((err) => {
  console.error('Feature 1 acceptance test failed:', err);
  process.exit(1);
});
