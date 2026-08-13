/**
 * Neon / Postgres data access layer for Chiper Messenger.
 * - Connection pool with keep-alive & retries
 * - Auto schema ensure + indexes
 * - Transactions, upsert, safer helpers
 */
const { Pool } = require('pg');

function env(name, fallback = '') {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return String(v).replace(/\r/g, '').trim();
}

const connectionString =
  env('DATABASE_URL') ||
  env('NEON_DATABASE_URL') ||
  env('POSTGRES_URL') ||
  env('POSTGRES_CONNECTION_STRING');

if (!connectionString) {
  throw new Error(
    'DATABASE_URL is missing. Set it to your Neon connection string in .env file.'
  );
}

const isNeon =
  connectionString.includes('neon.tech') ||
  connectionString.includes('sslmode=') ||
  /amazonaws\.com|supabase|render\.com/i.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: isNeon ? { rejectUnauthorized: false } : false,
  max: Number(env('DB_POOL_MAX', '12')) || 12,
  idleTimeoutMillis: 15000,
  connectionTimeoutMillis: 8000,
  keepAlive: true,
  statement_timeout: 20000,
  query_timeout: 25000,
  application_name: 'chiper',
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

let schemaReady = false;
let schemaPromise = null;

/**
 * Run a parameterized query with one automatic retry on connection errors.
 */
async function query(text, params = []) {
  const start = Date.now();
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await pool.query(text, params);
      const ms = Date.now() - start;
      if (ms > 400) console.warn(`[db] slow query ${ms}ms:`, String(text).slice(0, 140));
      return res;
    } catch (err) {
      lastErr = err;
      const retriable =
        /ECONNRESET|ETIMEDOUT|Connection terminated|cannot connect|too many clients|57P01|53300/i.test(
          String(err.message || '')
        ) || err.code === 'ECONNRESET';
      if (!retriable || attempt === 1) {
        console.error(
          '[db] query error:',
          err.message,
          '\nSQL:',
          String(text).slice(0, 220),
          '\nparams:',
          Array.isArray(params) ? params.slice(0, 8) : params
        );
        throw err;
      }
      await new Promise((r) => setTimeout(r, 120 + attempt * 200));
    }
  }
  throw lastErr;
}

async function many(text, params = []) {
  const res = await query(text, params);
  return res.rows;
}

async function one(text, params = []) {
  const res = await query(text, params);
  return res.rows[0] || null;
}

/**
 * Insert a row and return it (RETURNING *).
 * Table name must be a safe identifier (no user input).
 */
async function insert(table, data) {
  assertIdent(table);
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  if (keys.length === 0) throw new Error('insert: empty data');
  keys.forEach(assertIdent);
  const cols = keys.map((k) => `"${k}"`).join(', ');
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const values = keys.map((k) => data[k]);
  const sql = `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING *`;
  return one(sql, values);
}

/**
 * Update rows matching where. Returns updated rows.
 */
async function update(table, where, data) {
  assertIdent(table);
  const dataKeys = Object.keys(data).filter((k) => data[k] !== undefined);
  const whereKeys = Object.keys(where);
  if (dataKeys.length === 0) throw new Error('update: empty data');
  if (whereKeys.length === 0) throw new Error('update: empty where');
  dataKeys.forEach(assertIdent);
  whereKeys.forEach(assertIdent);

  const values = [...dataKeys.map((k) => data[k]), ...whereKeys.map((k) => where[k])];
  const setSql = dataKeys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
  const whereSql = whereKeys
    .map((k, i) => `"${k}" = $${dataKeys.length + i + 1}`)
    .join(' AND ');

  const sql = `UPDATE ${table} SET ${setSql} WHERE ${whereSql} RETURNING *`;
  const res = await query(sql, values);
  return res.rows;
}

/**
 * Upsert by unique/conflict target columns.
 * conflictCols: string[] e.g. ['email'] or ['conversation_id','sender_id','client_msg_id']
 */
async function upsert(table, data, conflictCols, updateCols) {
  assertIdent(table);
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  if (!keys.length) throw new Error('upsert: empty data');
  keys.forEach(assertIdent);
  (conflictCols || []).forEach(assertIdent);

  const cols = keys.map((k) => `"${k}"`).join(', ');
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const values = keys.map((k) => data[k]);
  const conflict = (conflictCols || []).map((c) => `"${c}"`).join(', ');
  const updKeys =
    updateCols && updateCols.length
      ? updateCols.filter((k) => keys.includes(k) && !(conflictCols || []).includes(k))
      : keys.filter((k) => !(conflictCols || []).includes(k));
  updKeys.forEach(assertIdent);

  let sql;
  if (!conflict || !updKeys.length) {
    sql = `INSERT INTO ${table} (${cols}) VALUES (${placeholders})
           ON CONFLICT DO NOTHING RETURNING *`;
  } else {
    const set = updKeys.map((k) => `"${k}" = EXCLUDED."${k}"`).join(', ');
    sql = `INSERT INTO ${table} (${cols}) VALUES (${placeholders})
           ON CONFLICT (${conflict}) DO UPDATE SET ${set}
           RETURNING *`;
  }
  return one(sql, values);
}

async function del(table, where) {
  assertIdent(table);
  const whereKeys = Object.keys(where);
  if (whereKeys.length === 0) throw new Error('del: empty where');
  whereKeys.forEach(assertIdent);
  const whereClauses = whereKeys.map((k, i) => `"${k}" = $${i + 1}`);
  const values = whereKeys.map((k) => where[k]);
  const sql = `DELETE FROM ${table} WHERE ${whereClauses.join(' AND ')} RETURNING *`;
  const res = await query(sql, values);
  return res.rows;
}

/**
 * Run work inside a transaction. work(client) receives a client with .query
 */
async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tx = {
      query: (text, params) => client.query(text, params),
      many: async (text, params) => (await client.query(text, params)).rows,
      one: async (text, params) => (await client.query(text, params)).rows[0] || null,
    };
    const result = await work(tx);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function healthCheck() {
  try {
    const r = await one('SELECT 1 AS ok');
    return !!r;
  } catch (e) {
    return false;
  }
}

function assertIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(name || ''))) {
    throw new Error('Invalid SQL identifier: ' + name);
  }
}

/**
 * Create tables + indexes if missing (idempotent).
 * Safe to run on every startup.
 */
async function ensureSchema() {
  if (schemaReady) return true;
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    const statements = [
      `CREATE EXTENSION IF NOT EXISTS "pgcrypto"`,

      // profiles
      `CREATE TABLE IF NOT EXISTS profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE,
        username TEXT UNIQUE,
        name TEXT,
        bio TEXT,
        avatar TEXT,
        avatar_type TEXT,
        banner TEXT,
        phone TEXT,
        city TEXT,
        birthday TEXT,
        gender TEXT,
        website TEXT,
        status TEXT DEFAULT 'offline',
        last_seen TIMESTAMPTZ,
        verified BOOLEAN DEFAULT false,
        is_admin BOOLEAN DEFAULT false,
        premium BOOLEAN DEFAULT false,
        premium_until TIMESTAMPTZ,
        coins INTEGER DEFAULT 0,
        stars INTEGER DEFAULT 0,
        custom_status TEXT,
        profile_color TEXT,
        e2ee_public_key TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_profiles_email_lower ON profiles (lower(email))`,
      `CREATE INDEX IF NOT EXISTS idx_profiles_username_lower ON profiles (lower(username))`,
      `CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles (status)`,

      // otp
      `CREATE TABLE IF NOT EXISTS otp_verifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_verifications (email)`,
      `CREATE INDEX IF NOT EXISTS idx_otp_expires ON otp_verifications (expires_at)`,

      // conversations
      `CREATE TABLE IF NOT EXISTS conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        type TEXT NOT NULL DEFAULT 'dm',
        name TEXT,
        description TEXT,
        avatar TEXT,
        created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
        last_message_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_conversations_last_msg ON conversations (last_message_at DESC NULLS LAST)`,
      `CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations (type)`,

      // members
      `CREATE TABLE IF NOT EXISTS conversation_members (
        conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        role TEXT DEFAULT 'member',
        muted BOOLEAN DEFAULT false,
        pinned BOOLEAN DEFAULT false,
        archived BOOLEAN DEFAULT false,
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (conversation_id, profile_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_members_profile ON conversation_members (profile_id)`,
      `CREATE INDEX IF NOT EXISTS idx_members_conv ON conversation_members (conversation_id)`,

      // messages
      `CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
        content TEXT,
        ciphertext TEXT,
        iv TEXT,
        salt TEXT,
        sender_public_key TEXT,
        message_type TEXT DEFAULT 'text',
        reply_to UUID,
        client_msg_id TEXT,
        edited BOOLEAN DEFAULT false,
        deleted BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages (conversation_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender_id)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_client_msg ON messages (conversation_id, sender_id, client_msg_id)`,
      // unique client_msg_id when present (dedupe)
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_client_msg
         ON messages (conversation_id, sender_id, client_msg_id)
         WHERE client_msg_id IS NOT NULL AND client_msg_id <> ''`,

      // reactions
      `CREATE TABLE IF NOT EXISTS message_reactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (message_id, profile_id, emoji)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions (message_id)`,

      // file uploads
      `CREATE TABLE IF NOT EXISTS file_uploads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
        conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
        file_name TEXT,
        mime_type TEXT,
        size_bytes BIGINT,
        url TEXT,
        storage_path TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_files_profile ON file_uploads (profile_id)`,
      `CREATE INDEX IF NOT EXISTS idx_files_conv ON file_uploads (conversation_id)`,

      // calls
      `CREATE TABLE IF NOT EXISTS calls (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
        initiated_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
        call_type TEXT DEFAULT 'audio',
        status TEXT DEFAULT 'ringing',
        started_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS call_participants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        call_id UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
        profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        left_at TIMESTAMPTZ,
        UNIQUE (call_id, profile_id)
      )`,

      // e2ee store — matches /api/save-message + client encryptAndSendMessage
      // id is TEXT (client-generated), not UUID, so existing rows stay compatible
      `CREATE TABLE IF NOT EXISTS e2ee_messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        sender_username TEXT NOT NULL,
        recipient_username TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        salt TEXT NOT NULL,
        sender_public_key TEXT NOT NULL,
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,

      // soft column upgrades for older DBs (both legacy and intermediate schemas)
      `ALTER TABLE e2ee_messages ADD COLUMN IF NOT EXISTS chat_id TEXT`,
      `ALTER TABLE e2ee_messages ADD COLUMN IF NOT EXISTS sender_username TEXT`,
      `ALTER TABLE e2ee_messages ADD COLUMN IF NOT EXISTS recipient_username TEXT`,
      `ALTER TABLE e2ee_messages ADD COLUMN IF NOT EXISTS ciphertext TEXT`,
      `ALTER TABLE e2ee_messages ADD COLUMN IF NOT EXISTS iv TEXT`,
      `ALTER TABLE e2ee_messages ADD COLUMN IF NOT EXISTS salt TEXT`,
      `ALTER TABLE e2ee_messages ADD COLUMN IF NOT EXISTS sender_public_key TEXT`,
      `ALTER TABLE e2ee_messages ADD COLUMN IF NOT EXISTS metadata JSONB`,
      `ALTER TABLE e2ee_messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
      // optional newer columns (ignored by current API but safe to have)
      `ALTER TABLE e2ee_messages ADD COLUMN IF NOT EXISTS conversation_id UUID`,
      `ALTER TABLE e2ee_messages ADD COLUMN IF NOT EXISTS sender_id UUID`,
      `ALTER TABLE e2ee_messages ADD COLUMN IF NOT EXISTS recipient_id UUID`,

      // indexes after columns are guaranteed to exist
      `CREATE INDEX IF NOT EXISTS idx_e2ee_chat ON e2ee_messages (chat_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_e2ee_recipient ON e2ee_messages (recipient_username, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_e2ee_sender ON e2ee_messages (sender_username, created_at DESC)`,

      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS coins INTEGER DEFAULT 0`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stars INTEGER DEFAULT 0`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS premium BOOLEAN DEFAULT false`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS premium_until TIMESTAMPTZ`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS custom_status TEXT`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone TEXT`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS city TEXT`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS birthday TEXT`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS e2ee_public_key TEXT`,
      `ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_msg_id TEXT`,
      `ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT false`,
      `ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT false`,
      `ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
      `ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS muted BOOLEAN DEFAULT false`,
      `ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT false`,
      `ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT false`,
      `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ`,
      `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,
    ];

    for (const sql of statements) {
      try {
        await query(sql);
      } catch (e) {
        // Non-fatal for optional extensions / permissions
        console.warn('[db] schema step skipped:', e.message, '|', sql.slice(0, 80));
      }
    }

    schemaReady = true;
    console.log('[db] schema ensured');
    return true;
  })().catch((e) => {
    schemaPromise = null;
    console.error('[db] ensureSchema failed:', e.message);
    throw e;
  });

  return schemaPromise;
}

async function close() {
  try {
    await pool.end();
  } catch (_) {}
}

module.exports = {
  pool,
  query,
  many,
  one,
  insert,
  update,
  upsert,
  del,
  withTransaction,
  healthCheck,
  ensureSchema,
  close,
};
