require('dotenv').config();
const fs = require('fs');
const net = require('net');
const path = require('path');
const { Pool } = require('pg');

class Ipv4Socket extends net.Socket {
  connect(...args) {
    if (typeof args[0] === 'number') {
      return super.connect({ port: args[0], host: args[1], family: 4 });
    }
    return super.connect(...args);
  }
}

function getPoolConfig() {
  if (process.env.DATABASE_URL) {
    const isLocal =
      process.env.DATABASE_URL.includes('localhost') ||
      process.env.DATABASE_URL.includes('127.0.0.1') ||
      process.env.PGSSLMODE === 'disable';

    return {
      connectionString: process.env.DATABASE_URL,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      stream: () => new Ipv4Socket(),
    };
  }

  return {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: process.env.PGDATABASE || 'trello',
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
    stream: () => new Ipv4Socket(),
  };
}

const pool = new Pool(getPoolConfig());

pool.on('error', (err) => {
  console.error('Unexpected error on idle database client', err);
});

async function initSchema() {
  try {
    const schemaPath = path.join(__dirname, '../models/schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(sql);
    console.log('Database schema verified/initialized.');
  } catch (err) {
    console.error('Failed to initialize database schema:', err);
    throw err;
  }
}

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  initSchema,
};
