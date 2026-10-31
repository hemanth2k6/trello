require('dotenv').config();
const { createClient } = require('redis');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const pubClient = createClient({ url: redisUrl });
const subClient = pubClient.duplicate();
const redisClient = pubClient.duplicate();

pubClient.on('error', (err) => console.error('Redis Pub Client Error:', err));
subClient.on('error', (err) => console.error('Redis Sub Client Error:', err));
redisClient.on('error', (err) => console.error('Redis Client Error:', err));

async function connectRedis() {
  await Promise.all([
    pubClient.connect(),
    subClient.connect(),
    redisClient.connect(),
  ]);
}

module.exports = {
  pubClient,
  subClient,
  redisClient,
  connectRedis,
};

