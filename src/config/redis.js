require('dotenv').config();
const { createClient } = require('redis');

function getRedisConfig() {
  const rawUrl = process.env.REDIS_URL || 'redis://localhost:6379';

  if (process.env.REDIS_SOCKET) {
    return { socket: { path: process.env.REDIS_SOCKET } };
  }
  if (rawUrl.startsWith('/') || rawUrl.startsWith('unix:')) {
    return { socket: { path: rawUrl.replace(/^unix:\/\//, '') } };
  }

  // Ensure rediss:// protocol and TLS for Upstash or when TLS is requested
  let formattedUrl = rawUrl;
  const isUpstash = rawUrl.includes('upstash.io');
  const isTls = rawUrl.startsWith('rediss://') || isUpstash || process.env.REDIS_TLS === 'true';

  if (isTls && formattedUrl.startsWith('redis://')) {
    formattedUrl = formattedUrl.replace(/^redis:\/\//, 'rediss://');
  }

  const reconnectStrategy = (retries) => {
    // Reconnect with exponential backoff capped at 3 seconds
    return Math.min(retries * 200, 3000);
  };

  if (isTls) {
    return {
      url: formattedUrl,
      socket: {
        tls: true,
        rejectUnauthorized: false,
        reconnectStrategy,
      },
    };
  }

  return {
    url: formattedUrl,
    socket: {
      reconnectStrategy,
    },
  };
}

const clientConfig = getRedisConfig();

// Both main client and sub client created from the same process.env.REDIS_URL
const pubClient = createClient(clientConfig);
const subClient = createClient(clientConfig);
const redisClient = createClient(clientConfig);

// Attach error and reconnecting handlers so dropped sockets log instead of crashing
pubClient.on('error', (err) => console.error('Redis Pub Client Error:', err.message || err));
subClient.on('error', (err) => console.error('Redis Sub Client Error:', err.message || err));
redisClient.on('error', (err) => console.error('Redis Client Error:', err.message || err));

pubClient.on('reconnecting', () => console.log('Redis Pub Client reconnecting...'));
subClient.on('reconnecting', () => console.log('Redis Sub Client reconnecting...'));
redisClient.on('reconnecting', () => console.log('Redis Client reconnecting...'));

// Safely wrap pSubscribe and subscribe to catch any unhandled promise rejections on socket drop
const origPSubscribe = subClient.pSubscribe.bind(subClient);
subClient.pSubscribe = (...args) => {
  return origPSubscribe(...args).catch((err) => {
    console.error('Redis Sub Client pSubscribe error:', err.message || err);
  });
};

const origSubscribe = subClient.subscribe.bind(subClient);
subClient.subscribe = (...args) => {
  return origSubscribe(...args).catch((err) => {
    console.error('Redis Sub Client subscribe error:', err.message || err);
  });
};

async function connectRedis() {
  const connectClient = async (client, name) => {
    if (client.isOpen) return;
    try {
      await client.connect();
      console.log(`Redis ${name} connected successfully.`);
    } catch (err) {
      console.error(`Failed to connect Redis ${name}:`, err.message || err);
    }
  };

  await Promise.all([
    connectClient(pubClient, 'Pub Client'),
    connectClient(subClient, 'Sub Client'),
    connectClient(redisClient, 'Client'),
  ]);
}

async function disconnectRedis() {
  const disconnectClient = async (client) => {
    if (client.isOpen) {
      try {
        await client.quit();
      } catch (err) {
        console.error('Error disconnecting Redis client:', err.message || err);
      }
    }
  };

  await Promise.all([
    disconnectClient(pubClient),
    disconnectClient(subClient),
    disconnectClient(redisClient),
  ]);
}

module.exports = {
  pubClient,
  subClient,
  redisClient,
  connectRedis,
  disconnectRedis,
};
