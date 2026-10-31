const assert = require('assert');
const { io: Client } = require('socket.io-client');
const { server, start } = require('../src/server');
const { pool } = require('../src/config/db');
const { redisClient, disconnectRedis } = require('../src/config/redis');

async function runFeature3AcceptanceTest() {
  console.log('=== FEATURE 3 ACCEPTANCE TEST: PRESENCE IN REDIS ===');
  const PORT = 3023;
  const baseUrl = `http://localhost:${PORT}`;

  await start(PORT);

  // 1. Register two users
  const reg1 = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `pres1_${Date.now()}@example.com`, password: 'password123' }),
  });
  const { token: token1, user: user1 } = await reg1.json();

  const reg2 = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `pres2_${Date.now()}@example.com`, password: 'password123' }),
  });
  const { token: token2, user: user2 } = await reg2.json();

  // 2. Create board with User 1
  const bRes = await fetch(`${baseUrl}/api/boards`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token1}`,
    },
    body: JSON.stringify({ title: 'Presence Board' }),
  });
  const board = await bRes.json();
  const boardId = board.id;

  // 3. Add User 2 as member of the board
  const memRes = await fetch(`${baseUrl}/api/boards/${boardId}/members`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token1}`,
    },
    body: JSON.stringify({ userId: user2.id, role: 'member' }),
  });
  assert.strictEqual(memRes.status, 201, 'User 2 added as board member');

  // 4. Connect both clients
  const client1 = Client(baseUrl, { auth: { token: token1 }, transports: ['websocket'] });
  const client2 = Client(baseUrl, { auth: { token: token2 }, transports: ['websocket'] });

  await Promise.all([
    new Promise((resolve) => client1.on('connect', resolve)),
    new Promise((resolve) => client2.on('connect', resolve)),
  ]);
  console.log('[PASS] Both clients connected to Socket.io');

  // 5. Track presence_update events on both clients
  let client1ReceivedUser2 = false;
  let client2ReceivedUser1 = false;

  const presencePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout: client1ReceivedUser2=${client1ReceivedUser2}, client2ReceivedUser1=${client2ReceivedUser1}`));
    }, 6000);

    client1.on('presence_update', (data) => {
      console.log('Client 1 received presence_update:', data);
      if (data.userId === user2.id || (Array.isArray(data.users) && data.users.includes(user2.id))) {
        client1ReceivedUser2 = true;
      }
      if (client1ReceivedUser2 && client2ReceivedUser1) {
        clearTimeout(timeout);
        resolve();
      }
    });

    client2.on('presence_update', (data) => {
      console.log('Client 2 received presence_update:', data);
      if (data.userId === user1.id || (Array.isArray(data.users) && data.users.includes(user1.id))) {
        client2ReceivedUser1 = true;
      }
      if (client1ReceivedUser2 && client2ReceivedUser1) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  // Client 1 joins board
  client1.emit('join_board', boardId);
  await new Promise((r) => setTimeout(r, 200));

  // Client 2 joins board
  client2.emit('join_board', boardId);

  await presencePromise;
  assert.ok(client1ReceivedUser2, "Client 1 received presence_update with Client 2's user_id");
  assert.ok(client2ReceivedUser1, "Client 2 received presence_update with Client 1's user_id");
  console.log('[PASS] Both clients received presence_update with each other\'s user_id!');

  // 6. Verify Redis sorted set directly
  const presenceKey = `presence:${boardId}`;
  const members = await redisClient.zRange(presenceKey, 0, -1);
  assert.ok(members.includes(user1.id), 'Redis sorted set contains user1');
  assert.ok(members.includes(user2.id), 'Redis sorted set contains user2');
  console.log('[PASS] Redis sorted set contains both online users:', members);

  // 7. Test heartbeat updates score in Redis
  const initialScore = await redisClient.zScore(presenceKey, user1.id);
  await new Promise((r) => setTimeout(r, 50));
  client1.emit('heartbeat', { boardId });
  await new Promise((r) => setTimeout(r, 200));
  const updatedScore = await redisClient.zScore(presenceKey, user1.id);
  assert.ok(updatedScore >= initialScore, 'Heartbeat updated score in Redis sorted set');
  console.log('[PASS] Heartbeat successfully updated presence score in Redis');

  // 8. Test disconnect removes user from Redis and broadcasts leave
  const leavePromise = new Promise((resolve) => {
    client2.on('presence_update', (data) => {
      if (data.action === 'leave' && data.userId === user1.id) {
        resolve(data);
      }
    });
  });

  client1.disconnect();
  const leaveEvent = await leavePromise;
  assert.strictEqual(leaveEvent.userId, user1.id, 'Leave event specifies disconnected user');
  console.log('[PASS] Disconnect removed user and broadcasted presence_update with action: leave');

  const membersAfterDisconnect = await redisClient.zRange(presenceKey, 0, -1);
  assert.strictEqual(membersAfterDisconnect.includes(user1.id), false, 'User 1 removed from Redis on disconnect');
  console.log('[PASS] User 1 verified removed from Redis sorted set');

  client2.disconnect();
  await disconnectRedis();
  server.close();
  await pool.end();
  console.log('=== FEATURE 3 ACCEPTANCE TESTS COMPLETED SUCCESSFULLY ===');
}

runFeature3AcceptanceTest().catch((err) => {
  console.error('Feature 3 test failed:', err);
  process.exit(1);
});
