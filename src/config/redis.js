require('dotenv').config();
const { createClient } = require('redis');

function getRedisConfig() {
  if (process.env.REDIS_SOCKET) {
    return { socket: { path: process.env.REDIS_SOCKET } };
  }
  if (process.env.REDIS_URL) {
    const url = process.env.REDIS_URL;
    if (url.startsWith('/') || url.startsWith('unix:')) {
      return { socket: { path: url.replace(/^unix:\/\//, '') } };
    }
    if (url.startsWith('rediss://')) {
      return {
        url,
        socket: {
          tls: true,
          rejectUnauthorized: false,
        },
      };
    }
    return { url };
  }
  return { url: 'redis://localhost:6379' };
}

const clientConfig = getRedisConfig();

const pubClient = createClient(clientConfig);
const subClient = pubClient.duplicate();
const redisClient = pubClient.duplicate();

pubClient.on('error', (err) => console.error('Redis Pub Client Error:', err));
subClient.on('error', (err) => console.error('Redis Sub Client Error:', err));
redisClient.on('error', (err) => console.error('Redis Client Error:', err));

async function connectRedis() {
  const promises = [];
  if (!pubClient.isOpen) promises.push(pubClient.connect());
  if (!subClient.isOpen) promises.push(subClient.connect());
  if (!redisClient.isOpen) promises.push(redisClient.connect());
  await Promise.all(promises);
}

async function disconnectRedis() {
  const promises = [];
  if (pubClient.isOpen) promises.push(pubClient.quit());
  if (subClient.isOpen) promises.push(subClient.quit());
  if (redisClient.isOpen) promises.push(redisClient.quit());
  await Promise.all(promises);
}

module.exports = {
  pubClient,
  subClient,
  redisClient,
  connectRedis,
  disconnectRedis,
};
