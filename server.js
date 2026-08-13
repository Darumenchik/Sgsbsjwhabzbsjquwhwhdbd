const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

dotenv.config({ path: path.join(__dirname, '.env') });

// Strip Windows CR from all env values
for (const k of Object.keys(process.env)) {
  if (typeof process.env[k] === 'string' && process.env[k].includes('\r')) {
    process.env[k] = process.env[k].replace(/\r/g, '');
  }
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET is missing from .env');

const { createTransporter, validateEmail, hashCode } = require('./utils');
const db = require('./db');

/** Postgres uuid columns reject local client ids like group_xxx / mmsn_xxx */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v) {
  return UUID_RE.test(String(v || ''));
}
function assertUuid(value, field = 'id') {
  if (!isUuid(value)) {
    const err = new Error(
      `${field} must be a UUID. Local ids (group_…, channel_…, mmsn…) are not stored in the database — create the conversation on the server first.`
    );
    err.status = 400;
    throw err;
  }
  return String(value);
}

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 512 * 1024 });

// ========== Anti-DDoS / rate limiting ==========
const ADMIN_SECRET = process.env.ADMIN_SECRET || process.env.JWT_SECRET;
const RATE_WINDOW_MS = 60 * 1000;
const LIMITS = {
  global: { max: 180, windowMs: RATE_WINDOW_MS },      // general API
  otp: { max: 5, windowMs: 10 * 60 * 1000 },         // send-otp per IP
  verify: { max: 15, windowMs: 10 * 60 * 1000 },      // verify-otp per IP
  auth: { max: 40, windowMs: RATE_WINDOW_MS },        // auth-ish endpoints
  createConv: { max: 20, windowMs: RATE_WINDOW_MS },  // create group/channel/dm
  messages: { max: 120, windowMs: RATE_WINDOW_MS },  // send messages
  adminUnlock: { max: 8, windowMs: 10 * 60 * 1000 }, // admin panel password attempts
  wsPerIp: 8,                                         // concurrent WS per IP
};
const rateBuckets = new Map(); // key -> { count, resetAt }
const bannedIPs = new Set(
  String(process.env.BANNED_IPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);
const blockedUserIds = new Set();
const securityStats = {
  blockedRequests: 0,
  rateLimited: 0,
  bannedHits: 0,
  startedAt: Date.now(),
};

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket?.remoteAddress || req.ip || 'unknown';
}

function rateKey(ip, bucket) {
  return `${bucket}:${ip}`;
}

function hitRateLimit(ip, bucketName) {
  const cfg = LIMITS[bucketName] || LIMITS.global;
  const key = rateKey(ip, bucketName);
  const now = Date.now();
  let entry = rateBuckets.get(key);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + cfg.windowMs };
    rateBuckets.set(key, entry);
  }
  entry.count += 1;
  const limited = entry.count > cfg.max;
  if (limited) securityStats.rateLimited += 1;
  return {
    limited,
    count: entry.count,
    remaining: Math.max(0, cfg.max - entry.count),
    resetAt: entry.resetAt,
    limit: cfg.max,
  };
}

// Periodic cleanup of rate buckets
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) {
    if (now >= v.resetAt) rateBuckets.delete(k);
  }
}, 60 * 1000).unref?.();

function antiDdosMiddleware(req, res, next) {
  const ip = clientIp(req);

  if (bannedIPs.has(ip)) {
    securityStats.bannedHits += 1;
    securityStats.blockedRequests += 1;
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Skip static assets from strict limits
  const pathOnly = (req.path || req.url || '').split('?')[0];
  const isApi = pathOnly.startsWith('/api/');
  if (!isApi) return next();

  let bucket = 'global';
  if (pathOnly.includes('send-otp')) bucket = 'otp';
  else if (pathOnly.includes('verify-otp')) bucket = 'verify';
  else if (pathOnly.includes('admin/unlock')) bucket = 'adminUnlock';
  else if (pathOnly === '/api/conversations' && (req.method === 'POST' || req.method === 'post')) bucket = 'createConv';
  else if (pathOnly === '/api/messages' && (req.method === 'POST' || req.method === 'post')) bucket = 'messages';
  else if (
    pathOnly.includes('save-profile') ||
    pathOnly.includes('upload') ||
    pathOnly.includes('messages') ||
    pathOnly.includes('conversations')
  ) {
    bucket = 'auth';
  }

  const result = hitRateLimit(ip, bucket);
  res.setHeader('X-RateLimit-Limit', String(result.limit));
  res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));

  if (result.limited) {
    securityStats.blockedRequests += 1;
    // Auto-ban extreme OTP abuse
    if (bucket === 'otp' && result.count > (LIMITS.otp.max * 3)) {
      bannedIPs.add(ip);
    }
    return res.status(429).json({
      error: 'Too many requests. Slow down.',
      retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000),
    });
  }
  next();
}

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  // Baseline CSP — allow self, inline styles (app uses them), and Google Fonts / STUN-related connects
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https: wss: ws:",
      "media-src 'self' blob: data:",
      "worker-src 'self' blob:",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );
  next();
});

app.use(cors({ origin: true }));
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));
// Malformed JSON body
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  next(err);
});
app.use(antiDdosMiddleware);
// Serve only public client assets — never expose server source, schemas, .env, .git, etc.
const PUBLIC_ROOT = __dirname;
const STATIC_ALLOW_EXT = new Set([
  '.html', '.css', '.js', '.mjs', '.map', '.json', '.svg', '.png', '.jpg', '.jpeg',
  '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.webmanifest'
]);
const STATIC_DENY_NAMES = new Set([
  'server.js', 'db.js', 'utils.js', 'env.js', 'package.json', 'package-lock.json',
  'neon-schema.sql', 'neon-schema.txt', 'supabase-schema.sql', 'test-connection.js',
  '.env', '.env.example', 'IMPROVEMENTS.md', 'NEON-MIGRATION.md', 'README-TEST.md'
]);
app.use((req, res, next) => {
  const rawPath = String(req.path || '');
  const normalized = rawPath.replace(/\\/g, '/').toLowerCase();
  const base = path.basename(rawPath);

  // Block VCS, env, node_modules, tests, and other sensitive trees entirely
  if (
    normalized === '/.git' ||
    normalized.startsWith('/.git/') ||
    normalized.includes('/.git/') ||
    normalized.startsWith('/node_modules/') ||
    normalized.startsWith('/tests/') ||
    normalized.startsWith('/.github/') ||
    normalized.startsWith('/chiper/') ||
    normalized.startsWith('/chiper-neon/')
  ) {
    return res.status(404).end();
  }

  // Block sensitive filenames and extensions (schemas, source, secrets)
  if (
    STATIC_DENY_NAMES.has(base) ||
    base.startsWith('.env') ||
    /\.(sql|md|log|bak|pem|key|env)$/i.test(base) ||
    base === '.gitignore' ||
    base === '.gitattributes'
  ) {
    return res.status(404).end();
  }

  // Deny known source paths under root
  if (
    rawPath === '/server.js' ||
    rawPath === '/db.js' ||
    rawPath === '/utils.js' ||
    rawPath === '/env.js'
  ) {
    return res.status(404).end();
  }
  next();
});
app.use(express.static(PUBLIC_ROOT, {
  index: false,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  setHeaders(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (!STATIC_ALLOW_EXT.has(ext) && !filePath.endsWith('sw.js')) {
      // Should not normally be reached due to deny middleware, but belt-and-suspenders
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
  },
}));
// Explicit SPA entry
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_ROOT, 'index.html'));
});

const codes = new Map();
const CODE_TTL_MS = 5 * 60 * 1000;
const wsClients = new Map();
const userConnections = new Map();
const wsIpCounts = new Map(); // ip -> count

const ADMIN_EMAILS_SET = new Set(
  String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-secret'] || req.headers['x-admin-key'];
  if (key && key === ADMIN_SECRET) return next();

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token) {
    try {
      const user = jwt.verify(token, JWT_SECRET);
      if (user?.role === 'admin_panel') return next();
      if (user?.email && ADMIN_EMAILS_SET.has(String(user.email).toLowerCase())) {
        return next();
      }
    } catch (_) {}
  }
  return res.status(403).json({ error: 'Admin access denied' });
}

// ========== WebSocket handling ==========
wss.on('connection', (ws, req) => {
  let userId = null;
  let userEmail = null;
  const ip = clientIp(req || {});
  const cur = (wsIpCounts.get(ip) || 0) + 1;
  if (bannedIPs.has(ip) || cur > LIMITS.wsPerIp) {
    securityStats.blockedRequests += 1;
    try { ws.close(1008, 'Too many connections'); } catch (_) {}
    return;
  }
  wsIpCounts.set(ip, cur);

  const safeSend = (obj) => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch (_) {}
    }
  };

  ws.on('message', async (data) => {
    try {
      let msg;
      try {
        msg = JSON.parse(typeof data === 'string' ? data : data.toString());
      } catch (_) {
        return safeSend({ type: 'error', message: 'Invalid JSON' });
      }

      if (msg.type === 'auth') {
        if (!msg.token) {
          safeSend({ type: 'error', message: 'Token required' });
          return ws.close();
        }

        let decoded;
        try {
          decoded = jwt.verify(msg.token, JWT_SECRET);
        } catch (_) {
          safeSend({ type: 'error', message: 'Invalid token' });
          return ws.close();
        }

        if (decoded?.id && blockedUserIds.has(decoded.id)) {
          safeSend({ type: 'error', message: 'Account blocked' });
          return ws.close();
        }

        userId = decoded.id;
        userEmail = decoded.email;
        ws.userId = userId;
        ws.conversationIds = [];
        ws.username = null;
        wsClients.set(userId, ws);
        if (userEmail) {
          if (!userConnections.has(userEmail)) userConnections.set(userEmail, []);
          userConnections.get(userEmail).push(ws);
        }

        // Load memberships so private messages are not leaked to all connected clients
        try {
          const memberRows = await db.many(
            'SELECT conversation_id FROM conversation_members WHERE profile_id = $1',
            [userId]
          );
          ws.conversationIds = Array.isArray(memberRows)
            ? memberRows.map((r) => r.conversation_id).filter(Boolean)
            : [];
        } catch (e) {
          console.warn('WS load conversation memberships failed:', e.message);
          ws.conversationIds = [];
        }

        // Cache username for fast E2EE peer targeting without extra DB round-trips later
        try {
          const urows = await db.many(
            'SELECT username FROM profiles WHERE id = $1 LIMIT 1',
            [userId]
          );
          if (urows?.[0]?.username) {
            ws.username = String(urows[0].username).replace(/^@+/, '').toLowerCase();
          }
        } catch (_) {}

        try {
          await db.update('profiles', { id: userId }, {
            status: 'online',
            last_seen: new Date().toISOString(),
          });
        } catch (e) {
          console.warn('WS online status update failed:', e.message);
        }

        safeSend({ type: 'auth-ok', userId });
        broadcast({ type: 'user-status', userId, status: 'online' });
      } else if (!userId) {
        safeSend({ type: 'error', message: 'Authenticate first' });
      } else if (msg.type === 'message') {
        broadcast({ type: 'message', data: msg.data }, msg.data?.conversation_id);
      } else if (msg.type === 'typing') {
        broadcast({
          type: 'typing',
          userId,
          conversationId: msg.conversationId,
        }, msg.conversationId);
      } else if (
        msg.type === 'call-offer' ||
        msg.type === 'call-answer' ||
        msg.type === 'ice-candidate' ||
        msg.type === 'call_offer' ||
        msg.type === 'call_answer' ||
        msg.type === 'call_ice' ||
        msg.type === 'call_reject' ||
        msg.type === 'call_end'
      ) {
        // Point-to-point if targetId known; otherwise conversation-scoped (exclude sender)
        const payload = { ...msg, fromUserId: userId };
        if (msg.targetId && wsClients.has(msg.targetId)) {
          const targetWs = wsClients.get(msg.targetId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify(payload));
          }
        } else if (msg.conversationId || msg.chatId) {
          const convId = msg.conversationId || msg.chatId;
          wss.clients.forEach((client) => {
            if (client.readyState !== WebSocket.OPEN) return;
            if (client.userId && client.userId === userId) return; // don't echo to self
            if (Array.isArray(client.conversationIds) && client.conversationIds.includes(convId)) {
              client.send(JSON.stringify(payload));
            }
          });
        }
      }
    } catch (error) {
      console.error('WebSocket error:', error);
    }
  });

  ws.on('close', async () => {
    const n = (wsIpCounts.get(ip) || 1) - 1;
    if (n <= 0) wsIpCounts.delete(ip);
    else wsIpCounts.set(ip, n);

    if (userId) {
      if (wsClients.get(userId) === ws) wsClients.delete(userId);
      try {
        await db.update('profiles', { id: userId }, {
          status: 'offline',
          last_seen: new Date().toISOString(),
        });
      } catch (e) {
        console.warn('WS offline status update failed:', e.message);
      }
      broadcast({ type: 'user-status', userId, status: 'offline' });
    }
    if (userEmail && userConnections.has(userEmail)) {
      const conns = userConnections.get(userEmail);
      const idx = conns.indexOf(ws);
      if (idx > -1) conns.splice(idx, 1);
      if (conns.length === 0) userConnections.delete(userEmail);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message || error);
  });
});

function broadcast(message, conversationId = null) {
  const messageStr = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return;
    // Global events (user-status, etc.) go to everyone
    if (!conversationId) {
      client.send(messageStr);
      return;
    }
    // Conversation-scoped: only members who have this conversation loaded
    if (Array.isArray(client.conversationIds) && client.conversationIds.includes(conversationId)) {
      client.send(messageStr);
    }
  });
}

/**
 * Resolve recipient by username and push encrypted payload over their open WebSocket(s).
 * Also falls back to username match on any connected client.
 */
async function pushE2eeToPeer(payload) {
  if (!payload || !payload.recipient_username) return;
  const un = String(payload.recipient_username).replace(/^@+/, '').toLowerCase();
  const event = {
    type: 'e2ee-message',
    data: {
      id: payload.id,
      chat_id: payload.chat_id,
      sender_username: payload.sender_username,
      recipient_username: payload.recipient_username,
      ciphertext: payload.ciphertext,
      iv: payload.iv,
      salt: payload.salt,
      sender_public_key: payload.sender_public_key,
      metadata: payload.metadata || null,
      created_at: payload.created_at || new Date().toISOString(),
    },
  };
  const messageStr = JSON.stringify(event);

  // Prefer profile id lookup → wsClients map (O(1))
  let targetId = null;
  try {
    const rows = await db.many(
      `SELECT id FROM profiles WHERE lower(replace(username, '@', '')) = $1 LIMIT 1`,
      [un]
    );
    if (rows?.[0]?.id) targetId = rows[0].id;
  } catch (_) {}

  let delivered = false;
  if (targetId && wsClients.has(targetId)) {
    const client = wsClients.get(targetId);
    if (client && client.readyState === WebSocket.OPEN) {
      try {
        client.send(messageStr);
        delivered = true;
      } catch (_) {}
    }
  }

  // Fallback: scan open sockets by username stored on the connection (if any)
  if (!delivered) {
    wss.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;
      const cu = String(client.username || '')
        .replace(/^@+/, '')
        .toLowerCase();
      if (cu && cu === un) {
        try {
          client.send(messageStr);
          delivered = true;
        } catch (_) {}
      }
    });
  }
  return delivered;
}

/** Attach conversationId to online members' WS membership lists */
function addConversationToOnlineMembers(conversationId, profileIds) {
  if (!conversationId || !Array.isArray(profileIds)) return;
  for (const pid of profileIds) {
    const client = wsClients.get(pid);
    if (client && Array.isArray(client.conversationIds) && !client.conversationIds.includes(conversationId)) {
      client.conversationIds.push(conversationId);
    }
  }
}

// ========== Static files ==========
app.get('/favicon.ico', (req, res) => res.sendStatus(204));
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'manifest.json')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ========== Auth Middleware ==========
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Forbidden' });
    if (user?.id && blockedUserIds.has(user.id)) {
      return res.status(403).json({ error: 'Account blocked' });
    }
    req.user = user;
    next();
  });
}

// ========== Auth endpoints ==========
app.post('/api/send-otp', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'Введите корректный email' });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
    const codeHash = hashCode(code);

    await db.insert('otp_verifications', {
      email,
      code_hash: codeHash,
      expires_at: expiresAt,
      used: false,
    });

    const transporter = createTransporter();
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: 'Код подтверждения Chiper',
      text: `Ваш код подтверждения: ${code}`,
      html: `<p>Ваш код подтверждения:</p><h2>${code}</h2>`,
    });

    res.json({ ok: true, message: 'Код отправлен' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Не удалось отправить код' });
  }
});

app.post('/api/verify-otp', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const code = String(req.body?.code || '').trim();
    if (!validateEmail(email) || !/^[0-9]{6}$/.test(code)) {
      return res.status(400).json({ error: 'Неверный email или код' });
    }

    const rows = await db.many(
      `SELECT id, code_hash, expires_at FROM otp_verifications
       WHERE email = $1 AND used = false
       ORDER BY created_at DESC LIMIT 1`,
      [email]
    );
    const record = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!record) {
      return res.status(400).json({ error: 'Код не найден или уже использован' });
    }

    if (new Date(record.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'Код истёк' });
    }

    if (hashCode(code) !== record.code_hash) {
      return res.status(400).json({ error: 'Неверный код' });
    }

    await db.update('otp_verifications', { id: record.id }, { used: true });

    const profileRows = await db.many('SELECT * FROM profiles WHERE email = $1 LIMIT 1', [email]);
    const existingProfile = Array.isArray(profileRows) && profileRows[0] ? profileRows[0] : null;
    const profilePayload = {
      email,
      verified: true,
      status: 'online',
      updated_at: new Date().toISOString(),
    };
    if (existingProfile) {
      await db.update('profiles', { id: existingProfile.id }, profilePayload);
    } else {
      await db.insert('profiles', profilePayload);
    }

    const updatedProfileRows = await db.many('SELECT * FROM profiles WHERE email = $1 LIMIT 1', [email]);
    const updated = Array.isArray(updatedProfileRows) && updatedProfileRows.length > 0 ? updatedProfileRows[0] : null;
    
    if (!updated) {
       return res.status(500).json({ error: 'Ошибка получения профиля' });
    }

    const token = jwt.sign({ id: updated.id, email: updated.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, message: 'Email подтверждён', profile: updated, token });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Не удалось проверить код' });
  }
});

app.get('/api/get-profile', authenticateToken, async (req, res) => {
  try {
    const email = req.query.email ? String(req.query.email).trim().toLowerCase() : null;
    const username = req.query.username ? String(req.query.username).trim() : null;
    const userId = req.query.id ? String(req.query.id).trim() : null;

    let profile = null;
    if (email) {
      profile = await db.one('SELECT * FROM profiles WHERE email = $1 LIMIT 1', [email]);
    } else if (username) {
      profile = await db.one('SELECT * FROM profiles WHERE username = $1 LIMIT 1', [username]);
    } else if (userId) {
      profile = await db.one('SELECT * FROM profiles WHERE id = $1 LIMIT 1', [userId]);
    } else {
      return res.status(400).json({ error: 'Email, username or id required' });
    }
    res.json({ profile });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/save-profile', authenticateToken, async (req, res) => {
  try {
    const body = req.body || {};
    const email = req.user.email;
    const username = String(body.username || '').trim();

    if (!validateEmail(email) || !username) {
      return res.status(400).json({ error: 'Email and username required' });
    }

    const profilePayload = {
      email,
      username,
      name: body.name ? String(body.name).trim() : null,
      bio: body.bio ? String(body.bio).trim() : null,
      avatar: body.avatar || null,
      avatar_type: body.avatar_type || null,
      public_key: body.public_key ? String(body.public_key).trim() : null,
      coins: body.coins !== undefined ? Number(body.coins) || 0 : undefined,
      stars: body.stars !== undefined ? Number(body.stars) || 0 : undefined,
      verified: body.verified !== undefined ? !!body.verified : undefined,
      premium: body.premium !== undefined ? !!body.premium : undefined,
      updated_at: new Date().toISOString(),
    };

    const existing = await db.many('SELECT id FROM profiles WHERE email = $1 LIMIT 1', [email]);
    if (Array.isArray(existing) && existing[0]) {
      await db.update('profiles', { id: existing[0].id }, profilePayload);
    } else {
      await db.insert('profiles', profilePayload);
    }

    const updatedProfileRows = await db.many('SELECT * FROM profiles WHERE email = $1 LIMIT 1', [email]);
    const fullProfile = Array.isArray(updatedProfileRows) && updatedProfileRows.length > 0 ? updatedProfileRows[0] : profilePayload;

    res.json({ ok: true, profile: fullProfile });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ========== Avatar upload ==========
app.post('/api/upload-avatar', authenticateToken, async (req, res) => {
  try {
    const { data, file_name, file_type } = req.body;
    const profile_id = req.user.id;
    if (!data || !file_name) {
      return res.status(400).json({ error: 'profile_id, data, file_name required' });
    }

    const file = await db.insert('file_uploads', {
      profile_id,
      file_name,
      file_size: Buffer.byteLength(data),
      file_type: file_type || 'image/jpeg',
      url: data,
      file_purpose: 'avatar',
      created_at: new Date().toISOString(),
    });

    await db.update('profiles', { id: profile_id }, {
      avatar: data,
      avatar_type: file_type || 'image/jpeg',
      updated_at: new Date().toISOString()
    });

    res.json({ ok: true, file });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ========== Conversations endpoints ==========
app.get('/api/conversations', authenticateToken, async (req, res) => {
  try {
    const profileId = req.user.id;

    // Load membership (with archive/pin/mute flags)
    const members = await db.many(
      `SELECT conversation_id, role, archived, pinned, muted, last_read_at, joined_at
       FROM conversation_members WHERE profile_id = $1`,
      [profileId]
    );
    if (!Array.isArray(members) || members.length === 0) {
      return res.json({ conversations: [] });
    }

    const memberByConv = {};
    members.forEach((m) => {
      if (m.conversation_id) memberByConv[m.conversation_id] = m;
    });

    const convIds = Object.keys(memberByConv);
    const rows = await db.many(
      `SELECT * FROM conversations WHERE id = ANY($1::uuid[]) ORDER BY last_message_at DESC`,
      [convIds]
    );

    // Attach member preferences to each conversation
    const conversations = (Array.isArray(rows) ? rows : []).map((c) => {
      const mem = memberByConv[c.id] || {};
      return {
        ...c,
        role: mem.role || 'member',
        archived: !!mem.archived,
        pinned: !!mem.pinned,
        muted: !!mem.muted,
        last_read_at: mem.last_read_at || null,
        joined_at: mem.joined_at || null,
      };
    });

    // Pinned first, then by last_message_at
    conversations.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0);
    });

    res.json({ conversations });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/conversations', authenticateToken, async (req, res) => {
  try {
    const { type, name, participant_ids, description } = req.body;
    const created_by = req.user.id;
    if (!type) return res.status(400).json({ error: 'type required' });

    // Normalize type: 'direct' -> 'dm', validate allowed types
    const allowedTypes = ['dm', 'group', 'channel'];
    let normalizedType = type === 'direct' ? 'dm' : type;

    if (!allowedTypes.includes(normalizedType)) {
      return res.status(400).json({ error: `Invalid type. Allowed: ${allowedTypes.join(', ')}` });
    }

    const conv = await db.insert('conversations', {
      type: normalizedType,
      name: name || null,
      description: description || null,
      created_by,
      created_at: new Date().toISOString(),
    });

    if (!conv || !conv.id) throw new Error('Failed to create conversation');

    // Always include creator; only accept valid UUIDs as profile_id
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const memberList = [];
    if (participant_ids && Array.isArray(participant_ids)) {
      for (const pid of participant_ids) {
        if (pid && uuidRe.test(String(pid)) && !memberList.includes(pid)) memberList.push(pid);
      }
    }
    if (created_by && !memberList.includes(created_by)) memberList.push(created_by);

    for (const pid of memberList) {
      try {
        await db.insert('conversation_members', {
          conversation_id: conv.id,
          profile_id: pid,
          role: pid === created_by ? 'admin' : 'member',
          joined_at: new Date().toISOString(),
        });
      } catch (memberErr) {
        console.warn('Failed to add member', pid, memberErr.message);
      }
    }

    // Let online members receive realtime events for this conversation
    addConversationToOnlineMembers(conv.id, memberList);

    res.json({ conversation: conv });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Update member preferences: archive / pin / mute / last_read
app.patch('/api/conversations/:conversationId/member', authenticateToken, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const profileId = req.user.id;
    const { archived, pinned, muted, last_read_at } = req.body || {};

    const updates = {};
    if (typeof archived === 'boolean') updates.archived = archived;
    if (typeof pinned === 'boolean') updates.pinned = pinned;
    if (typeof muted === 'boolean') updates.muted = muted;
    if (last_read_at) updates.last_read_at = last_read_at;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    if (!isUuid(conversationId)) {
      return res.status(400).json({ error: 'conversation_id must be a UUID', code: 'LOCAL_ID' });
    }

    const result = await db.update(
      'conversation_members',
      { conversation_id: conversationId, profile_id: profileId },
      updates
    );

    res.json({ ok: true, member: result[0] || null });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ========== Messages endpoints ==========
app.post('/api/messages', authenticateToken, async (req, res) => {
  try {
    const { conversation_id, content, ciphertext, iv, salt, sender_public_key, message_type, reply_to, client_msg_id } = req.body;
    const sender_id = req.user.id;
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id required' });
    try {
      assertUuid(conversation_id, 'conversation_id');
    } catch (e) {
      return res.status(400).json({ error: e.message, code: 'LOCAL_ID' });
    }

    // Security: only conversation members can post
    const memberRows = await db.many(
      'SELECT profile_id FROM conversation_members WHERE conversation_id = $1 AND profile_id = $2',
      [conversation_id, sender_id]
    );
    if (!Array.isArray(memberRows) || memberRows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }

    // Idempotency: if client_msg_id already stored in metadata-like content marker, return existing
    // (full unique index requires schema migration; soft check via recent messages)
    if (client_msg_id) {
      try {
        const existing = await db.many(
          `SELECT * FROM messages
           WHERE conversation_id = $1 AND sender_id = $2
           ORDER BY created_at DESC LIMIT 30`,
          [conversation_id, sender_id]
        );
        const hit = Array.isArray(existing)
          ? existing.find((m) => m && (m.id === client_msg_id || (m.content && String(m.content).includes('')) && m.client_msg_id === client_msg_id))
          : null;
        // Prefer explicit column if present after migration
        const hit2 = Array.isArray(existing)
          ? existing.find((m) => m.client_msg_id && m.client_msg_id === client_msg_id)
          : null;
        if (hit2) {
          return res.json({ message: hit2, deduped: true });
        }
      } catch (_) {}
    }

    const insertPayload = {
      conversation_id,
      sender_id,
      content: content || null,
      ciphertext: ciphertext || null,
      iv: iv || null,
      salt: salt || null,
      sender_public_key: sender_public_key || null,
      message_type: message_type || 'text',
      reply_to: reply_to || null,
      created_at: new Date().toISOString(),
    };
    // Optional column — ignore if schema has no client_msg_id yet
    if (client_msg_id) insertPayload.client_msg_id = String(client_msg_id).slice(0, 80);

    let message;
    try {
      message = await db.insert('messages', insertPayload);
    } catch (insertErr) {
      const errMsg = String(insertErr.message || '');
      const errCode = insertErr.code || insertErr.errno || '';
      // Unique violation on (conversation_id, sender_id, client_msg_id) — treat as already sent
      if (client_msg_id && (errCode === '23505' || /duplicate key|unique constraint/i.test(errMsg))) {
        try {
          const existing = await db.many(
            `SELECT * FROM messages
             WHERE conversation_id = $1 AND sender_id = $2 AND client_msg_id = $3
             LIMIT 1`,
            [conversation_id, sender_id, String(client_msg_id).slice(0, 80)]
          );
          if (Array.isArray(existing) && existing[0]) {
            return res.json({ message: existing[0], deduped: true });
          }
        } catch (_) {}
        return res.status(409).json({ error: 'Duplicate message', code: 'DUPLICATE' });
      }
      // Retry without client_msg_id if column missing
      if (client_msg_id && /client_msg_id|schema cache|column/i.test(errMsg)) {
        delete insertPayload.client_msg_id;
        message = await db.insert('messages', insertPayload);
      } else {
        throw insertErr;
      }
    }

    // Deliver to peers first for low latency, then respond
    broadcast({ type: 'new-message', data: message }, conversation_id);
    res.json({ message });

    // Fire-and-forget activity stamp (do not block the response)
    setImmediate(() => {
      db.update('conversations', { id: conversation_id }, {
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).catch((e) => console.warn('Failed to update last_message_at:', e.message));
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/messages', authenticateToken, async (req, res) => {
  try {
    const { conversation_id, limit = 50, offset = 0 } = req.query;
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id required' });
    try {
      assertUuid(conversation_id, 'conversation_id');
    } catch (e) {
      return res.status(400).json({ error: e.message, code: 'LOCAL_ID', messages: [] });
    }

    // Security: only members can read conversation messages
    const memberRows = await db.many(
      'SELECT profile_id FROM conversation_members WHERE conversation_id = $1 AND profile_id = $2',
      [conversation_id, req.user.id]
    );
    if (!Array.isArray(memberRows) || memberRows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }

    const lim = Math.min(Number(limit) || 50, 200);
    const off = Math.max(Number(offset) || 0, 0);
    let rows;
    try {
      rows = await db.many(
        `SELECT * FROM messages
         WHERE conversation_id = $1
           AND COALESCE(deleted, false) = false
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [conversation_id, lim, off]
      );
    } catch (qErr) {
      // Fallback if deleted column is missing on very old schema
      rows = await db.many(
        `SELECT * FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [conversation_id, lim, off]
      );
    }
    const messages = Array.isArray(rows) ? rows.reverse() : [];
    res.json({ messages });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/messages/:messageId', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content required' });

    // Ownership: only the original sender may edit
    const rows = await db.many(
      `SELECT id, sender_id, conversation_id FROM messages
       WHERE id = $1 AND COALESCE(deleted, false) = false`,
      [messageId]
    );
    const existing = Array.isArray(rows) && rows[0];
    if (!existing) return res.status(404).json({ error: 'Message not found' });
    if (String(existing.sender_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'You can only edit your own messages' });
    }

    // Schema has column "edited" (boolean), not is_edited / edited_at
    await db.update('messages', { id: messageId }, {
      content,
      edited: true,
      updated_at: new Date().toISOString(),
    });

    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/messages/:messageId', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;

    // Ownership: only the original sender may soft-delete
    const rows = await db.many(
      `SELECT id, sender_id FROM messages
       WHERE id = $1 AND COALESCE(deleted, false) = false`,
      [messageId]
    );
    const existing = Array.isArray(rows) && rows[0];
    if (!existing) return res.status(404).json({ error: 'Message not found' });
    if (String(existing.sender_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'You can only delete your own messages' });
    }

    await db.update('messages', { id: messageId }, {
      deleted: true,
      deleted_at: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ========== Search endpoints ==========
app.get('/api/search', authenticateToken, async (req, res) => {
  try {
    const { q, type = 'messages', conversation_id } = req.query;
    if (!q) return res.status(400).json({ error: 'query required' });

    const query = String(q).trim().toLowerCase();
    if (query.length < 2) return res.status(400).json({ error: 'Search query must be at least 2 characters' });

    if (type === 'messages' && conversation_id) {
      if (!isUuid(conversation_id)) {
        return res.json({ results: [], code: 'LOCAL_ID' });
      }
      // Membership check — do not leak other conversations' messages
      const memberRows = await db.many(
        'SELECT profile_id FROM conversation_members WHERE conversation_id = $1 AND profile_id = $2',
        [conversation_id, req.user.id]
      );
      if (!Array.isArray(memberRows) || memberRows.length === 0) {
        return res.status(403).json({ error: 'Not a member of this conversation' });
      }

      // messages table has content/ciphertext, not search_text
      const rows = await db.many(
        `SELECT * FROM messages
         WHERE conversation_id = $1
           AND COALESCE(deleted, false) = false
           AND (content ILIKE $2 OR ciphertext ILIKE $2)
         ORDER BY created_at DESC
         LIMIT 50`,
        [conversation_id, '%' + query + '%']
      );
      res.json({ results: Array.isArray(rows) ? rows : [] });
    } else if (type === 'profiles') {
      // Do NOT search by email (privacy). Only username + display name.
      const rows = await db.many(
        `SELECT id, username, name, avatar, avatar_type, verified, status, last_seen
         FROM profiles
         WHERE username ILIKE $1 OR name ILIKE $1
         LIMIT 20`,
        ['%' + query + '%']
      );
      const results = Array.isArray(rows) ? rows.map(r => ({
        id: r.id,
        username: r.username,
        name: r.name,
        avatar: r.avatar,
        avatarType: r.avatar_type,
        verified: r.verified,
        status: r.status,
        lastSeen: r.last_seen
      })) : [];
      res.json({ results });
    } else if (type === 'conversations') {
      // Only return conversations the caller is a member of (no metadata leak of private groups/channels)
      const rows = await db.many(
        `SELECT c.id, c.name, c.description, c.type, c.avatar, c.created_by
         FROM conversations c
         INNER JOIN conversation_members m
           ON m.conversation_id = c.id AND m.profile_id = $2
         WHERE (c.name ILIKE $1 OR c.description ILIKE $1)
         LIMIT 20`,
        ['%' + query + '%', req.user.id]
      );
      res.json({ results: Array.isArray(rows) ? rows : [] });
    } else {
      res.status(400).json({ error: 'Invalid search type or missing conversation_id' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ========== Username validation ==========
app.get('/api/check-username', authenticateToken, async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: 'username required' });

    const normalized = String(username).trim().toLowerCase();
    if (normalized.length < 3) return res.status(400).json({ error: 'username too short' });

    const rows = await db.many(
      `SELECT id, username, avatar, avatar_type, verified, status
       FROM profiles WHERE username = $1 LIMIT 1`,
      [normalized]
    );

    if (Array.isArray(rows) && rows.length > 0) {
      res.json({ exists: true, profile: rows[0] });
    } else {
      res.json({ exists: false });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ========== Calls endpoints ==========
app.post('/api/calls', authenticateToken, async (req, res) => {
  try {
    const { conversation_id, call_type } = req.body;
    const initiator_id = req.user.id;
    if (!conversation_id || !call_type) {
      return res.status(400).json({ error: 'conversation_id, initiator_id, call_type required' });
    }
    if (!isUuid(conversation_id)) {
      return res.status(400).json({ error: 'conversation_id must be a UUID', code: 'LOCAL_ID' });
    }

    const call = await db.insert('calls', {
      conversation_id,
      initiator_id,
      call_type,
      status: 'ringing',
      created_at: new Date().toISOString(),
    });

    broadcast({ type: 'call-initiated', data: call }, conversation_id);
    res.json({ call });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/calls/:callId', authenticateToken, async (req, res) => {
  try {
    const { callId } = req.params;
    const { status, ended_at, duration_seconds } = req.body;

    const updates = {};
    if (status) updates.status = status;
    if (ended_at) updates.ended_at = ended_at;
    if (duration_seconds) updates.duration_seconds = duration_seconds;

    await db.update('calls', { id: callId }, updates);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/calls/:callId/participants', authenticateToken, async (req, res) => {
  try {
    const { callId } = req.params;
    const profile_id = req.user.id;
    

    const participant = await db.insert('call_participants', {
      call_id: callId,
      profile_id,
      joined_at: new Date().toISOString(),
    });

    res.json({ participant });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ========== File upload endpoints ==========
app.post('/api/file-upload', authenticateToken, async (req, res) => {
  try {
    const { message_id, conversation_id, file_name, file_size, file_type, storage_path, url, data } = req.body;
    const profile_id = req.user.id;
    if (!file_name || (!file_size && !data && !url)) {
      return res.status(400).json({ error: 'file_name and file data required' });
    }

    // If attaching to a conversation, caller must be a member
    if (conversation_id) {
      try {
        assertUuid(conversation_id, 'conversation_id');
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      const memberRows = await db.many(
        'SELECT profile_id FROM conversation_members WHERE conversation_id = $1 AND profile_id = $2',
        [conversation_id, profile_id]
      );
      if (!Array.isArray(memberRows) || memberRows.length === 0) {
        return res.status(403).json({ error: 'Not a member of this conversation' });
      }
    }

    let finalUrl = url || null;
    let finalPath = storage_path || null;
    const payload = data || (url && String(url).startsWith('data:') ? url : null);

    // Neon has no object storage — keep data-URL / provided url inline (same as previous avatar path).
    // Large files should be uploaded by the client as data-URL only when reasonably small.
    if (payload && typeof payload === 'string') {
      if (payload.startsWith('data:') && payload.length < 1.8e6) {
        finalUrl = payload;
        finalPath = null;
      } else if (!finalUrl) {
        // non-data payload without external url — still store as-is if under limit
        if (payload.length < 1.8e6) {
          finalUrl = payload;
        } else {
          return res.status(413).json({ error: 'File too large for inline storage (max ~1.5MB). Use external URL.' });
        }
      }
    }

    const file = await db.insert('file_uploads', {
      message_id: message_id || null,
      conversation_id: conversation_id || null,
      profile_id,
      file_name,
      file_size: file_size || null,
      file_type: file_type || null,
      storage_path: finalPath,
      url: finalUrl,
      created_at: new Date().toISOString(),
    });

    res.json({ file, url: finalUrl, storage_path: finalPath });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/files', authenticateToken, async (req, res) => {
  try {
    const { conversation_id, limit = 50 } = req.query;
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id required' });
    if (!isUuid(conversation_id)) {
      return res.json({ files: [], code: 'LOCAL_ID' });
    }

    // Membership check — prevent IDOR: only members can list conversation files
    const memberRows = await db.many(
      'SELECT profile_id FROM conversation_members WHERE conversation_id = $1 AND profile_id = $2',
      [conversation_id, req.user.id]
    );
    if (!Array.isArray(memberRows) || memberRows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }

    const lim = Math.min(Number(limit) || 50, 100);
    const rows = await db.many(
      `SELECT * FROM file_uploads
       WHERE conversation_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [conversation_id, lim]
    );
    res.json({ files: Array.isArray(rows) ? rows : [] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ========== Message reactions endpoints ==========
app.post('/api/reactions', authenticateToken, async (req, res) => {
  try {
    const { message_id, emoji } = req.body;
    const profile_id = req.user.id;
    if (!message_id || !emoji) {
      return res.status(400).json({ error: 'message_id, profile_id, emoji required' });
    }
    try {
      assertUuid(message_id, 'message_id');
    } catch (e) {
      // Local-only messages: acknowledge without hitting Postgres
      return res.status(200).json({
        ok: true,
        local: true,
        reaction: { message_id, profile_id, emoji, id: null },
      });
    }

    const reaction = await db.insert('message_reactions', {
      message_id,
      profile_id,
      emoji,
      created_at: new Date().toISOString(),
    });

    res.json({ reaction });
  } catch (error) {
    if (error.message && error.message.includes('duplicate')) {
      return res.status(400).json({ error: 'Reaction already exists' });
    }
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/reactions/:reactionId', authenticateToken, async (req, res) => {
  try {
    const { reactionId } = req.params;
    await db.del('message_reactions', { id: reactionId });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ========== E2EE 1:1 message endpoints ==========
// Frontend sends username + salt; schema stores sender_username / recipient_username / salt
app.post('/api/save-message', authenticateToken, async (req, res) => {
  try {
    const body = req.body || {};
    let {
      id, chat_id,
      sender_username, recipient_username,
      sender_email, recipient_email,
      ciphertext, iv, salt, sender_public_key, metadata
    } = body;

    // Normalize usernames (strip @, lowercase)
    const norm = (u) => String(u || '').trim().replace(/^@+/, '').toLowerCase() || null;

    sender_username = norm(sender_username);
    recipient_username = norm(recipient_username);

    // Fallback: resolve email → username from profiles when only emails provided
    if ((!sender_username || !recipient_username) && (sender_email || recipient_email)) {
      try {
        if (!sender_username && sender_email) {
          const rows = await db.many('SELECT username FROM profiles WHERE lower(email) = lower($1) LIMIT 1', [sender_email]);
          if (rows?.[0]?.username) sender_username = norm(rows[0].username);
        }
        if (!recipient_username && recipient_email) {
          const rows = await db.many('SELECT username FROM profiles WHERE lower(email) = lower($1) LIMIT 1', [recipient_email]);
          if (rows?.[0]?.username) recipient_username = norm(rows[0].username);
        }
      } catch (e) {
        console.warn('email→username resolve failed', e.message);
      }
    }

    // Authenticated user must be the sender (prevent spoofing)
    try {
      const meRows = await db.many(
        'SELECT username, email FROM profiles WHERE id = $1 LIMIT 1',
        [req.user.id]
      );
      const me = meRows?.[0];
      const meUser = norm(me?.username || '');
      const meEmail = String(me?.email || req.user.email || '').toLowerCase();
      if (meUser && sender_username && sender_username !== meUser) {
        return res.status(403).json({ error: 'sender must match authenticated user' });
      }
      if (!meUser && meEmail && sender_email && String(sender_email).toLowerCase() !== meEmail) {
        return res.status(403).json({ error: 'sender must match authenticated user' });
      }
    } catch (e) {
      console.warn('sender ownership check skipped', e.message);
    }

    if (!id || !chat_id || !sender_username || !recipient_username || !ciphertext || !iv || !salt || !sender_public_key) {
      return res.status(400).json({
        error: 'Missing required fields',
        need: ['id', 'chat_id', 'sender_username', 'recipient_username', 'ciphertext', 'iv', 'salt', 'sender_public_key']
      });
    }

    const payload = {
      id: String(id),
      chat_id: String(chat_id),
      sender_username,
      recipient_username,
      ciphertext,
      iv,
      salt,
      sender_public_key,
      metadata: metadata || null,
      created_at: new Date().toISOString(),
    };

    try {
      await db.insert('e2ee_messages', payload);
    } catch (insertErr) {
      // Idempotent: same id already stored
      const code = insertErr.code || '';
      if (code === '23505' || /duplicate key|unique constraint/i.test(String(insertErr.message || ''))) {
        try { await pushE2eeToPeer(payload); } catch (_) {}
        return res.json({ ok: true, deduped: true });
      }
      throw insertErr;
    }

    // Push to recipient over WS immediately so the peer sees the message without polling
    try {
      await pushE2eeToPeer(payload);
    } catch (pushErr) {
      console.warn('e2ee WS push failed:', pushErr.message);
    }

    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/get-messages', authenticateToken, async (req, res) => {
  try {
    const email = req.query.email ? String(req.query.email).trim().toLowerCase() : null;
    const usernameQ = req.query.username ? String(req.query.username).trim().replace(/^@+/, '').toLowerCase() : null;
    const chatId = req.query.chat_id ? String(req.query.chat_id).trim() : null;
    if ((!email && !usernameQ) || !chatId) {
      return res.status(400).json({ error: 'email (or username) and chat_id required' });
    }

    // Resolve the caller's username for filtering
    let meUsername = usernameQ;
    if (!meUsername && email) {
      try {
        const rows = await db.many('SELECT username FROM profiles WHERE lower(email) = lower($1) LIMIT 1', [email]);
        if (rows?.[0]?.username) meUsername = String(rows[0].username).replace(/^@+/, '').toLowerCase();
      } catch (_) {}
    }
    if (!meUsername && req.user?.username) {
      meUsername = String(req.user.username).replace(/^@+/, '').toLowerCase();
    }
    if (!meUsername) {
      return res.status(400).json({ error: 'Could not resolve username for filter' });
    }

    const rows = await db.many(
      `SELECT * FROM e2ee_messages
       WHERE chat_id = $1
         AND (sender_username = $2 OR recipient_username = $2)
       ORDER BY created_at ASC`,
      [chatId, meUsername]
    );
    res.json({ messages: Array.isArray(rows) ? rows : [] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ========== Admin / security endpoints ==========
/** Unlock admin UI without shipping the secret to the browser bundle permanently */
app.post('/api/admin/unlock', (req, res) => {
  try {
    const password = String(req.body?.password || '');
    const expected = String(process.env.ADMIN_PANEL_PASSWORD || process.env.ADMIN_SECRET || ADMIN_SECRET || '');
    if (!password || !expected) {
      return res.status(403).json({ error: 'Неверный пароль' });
    }
    // Constant-time compare to avoid timing side-channels
    const a = Buffer.from(password, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    let ok = false;
    if (a.length === b.length) {
      try { ok = crypto.timingSafeEqual(a, b); } catch (_) { ok = false; }
    }
    if (!ok) {
      return res.status(403).json({ error: 'Неверный пароль' });
    }
    // Short-lived token for subsequent admin API calls from the panel
    const token = jwt.sign({ role: 'admin_panel', ts: Date.now() }, JWT_SECRET, { expiresIn: '4h' });
    res.json({ ok: true, token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const uptimeSec = Math.floor((Date.now() - securityStats.startedAt) / 1000);
  res.json({
    ok: true,
    uptimeSec,
    wsClients: wsClients.size,
    wsIpConnections: wsIpCounts.size,
    rateBuckets: rateBuckets.size,
    bannedIPs: [...bannedIPs],
    blockedUsers: blockedUserIds.size,
    security: { ...securityStats },
    limits: {
      global: LIMITS.global,
      otp: LIMITS.otp,
      verify: LIMITS.verify,
      auth: LIMITS.auth,
      wsPerIp: LIMITS.wsPerIp,
    },
  });
});

app.get('/api/admin/security', requireAdmin, (req, res) => {
  const topBuckets = [];
  for (const [key, val] of rateBuckets) {
    topBuckets.push({ key, count: val.count, resetAt: val.resetAt });
  }
  topBuckets.sort((a, b) => b.count - a.count);
  res.json({
    bannedIPs: [...bannedIPs],
    blockedUserIds: [...blockedUserIds],
    topRateBuckets: topBuckets.slice(0, 30),
    stats: securityStats,
  });
});

app.post('/api/admin/ban-ip', requireAdmin, (req, res) => {
  const ip = String(req.body?.ip || '').trim();
  if (!ip) return res.status(400).json({ error: 'ip required' });
  bannedIPs.add(ip);
  res.json({ ok: true, bannedIPs: [...bannedIPs] });
});

app.post('/api/admin/unban-ip', requireAdmin, (req, res) => {
  const ip = String(req.body?.ip || '').trim();
  if (!ip) return res.status(400).json({ error: 'ip required' });
  bannedIPs.delete(ip);
  res.json({ ok: true, bannedIPs: [...bannedIPs] });
});

app.post('/api/admin/block-user', requireAdmin, async (req, res) => {
  try {
    const { userId, blocked } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (blocked) blockedUserIds.add(userId);
    else blockedUserIds.delete(userId);

    // Persist flag in profiles if possible
    try {
      await db.update('profiles', { id: userId }, {
        // soft field — ignore if column missing
        status: blocked ? 'blocked' : 'offline',
      });
    } catch (_) {}

    res.json({ ok: true, blocked: !!blocked, blockedUsers: blockedUserIds.size });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/clear-rate-limits', requireAdmin, (req, res) => {
  rateBuckets.clear();
  res.json({ ok: true });
});

// ========== Auth refresh ==========
app.post('/api/auth/refresh', authenticateToken, async (req, res) => {
  try {
    const email = req.user.email;
    const id = req.user.id;
    if (!email || !id) return res.status(400).json({ error: 'Invalid token payload' });
    const token = jwt.sign({ id, email }, JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES || '30d' });
    res.json({ ok: true, token, expiresIn: process.env.JWT_EXPIRES || '30d' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== WebRTC ICE servers (STUN + optional TURN from env) ==========
app.get('/api/ice-servers', authenticateToken, (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  const turnUrl = process.env.TURN_URL; // e.g. turn:turn.example.com:3478
  const turnUser = process.env.TURN_USERNAME;
  const turnPass = process.env.TURN_PASSWORD;
  if (turnUrl && turnUser && turnPass) {
    iceServers.push({ urls: turnUrl, username: turnUser, credential: turnPass });
  }
  // Optional multiple TURN urls comma-separated
  const extra = String(process.env.TURN_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const u of extra) {
    if (turnUser && turnPass) iceServers.push({ urls: u, username: turnUser, credential: turnPass });
    else iceServers.push({ urls: u });
  }
  res.json({ iceServers });
});

// ========== Signed upload hint (client still posts base64; path reserved for future direct upload) ==========
app.post('/api/storage/signed-upload', authenticateToken, async (req, res) => {
  try {
    const { file_name, file_type } = req.body || {};
    if (!file_name) return res.status(400).json({ error: 'file_name required' });
    // no external storage bucket on Neon
    const safeName = String(file_name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
    const path = `${req.user.id}/${Date.now()}_${safeName}`;
    // Neon: client posts data-URL to /api/file-upload
    res.json({
      ok: true,
      bucket,
      path,
      contentType: file_type || 'application/octet-stream',
      // Client should POST binary/base64 to /api/file-upload with this path as storage_path
      uploadVia: '/api/file-upload',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== Message delivery / read receipts ==========
app.post('/api/messages/:messageId/receipt', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;
    const status = String(req.body?.status || 'delivered');
    if (!['delivered', 'read'].includes(status)) {
      return res.status(400).json({ error: 'status must be delivered|read' });
    }
    // Soft: broadcast receipt to conversation members via WS if conversation_id provided
    const conversationId = req.body?.conversation_id || null;
    broadcast(
      {
        type: 'message-receipt',
        messageId,
        status,
        userId: req.user.id,
        conversationId,
      },
      conversationId
    );
    res.json({ ok: true, messageId, status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== Health check ==========
app.get('/api/health', async (req, res) => {
  const result = {
    ok: true,
    timestamp: new Date().toISOString(),
    uptimeSec: Math.floor((Date.now() - securityStats.startedAt) / 1000),
    ws: wsClients.size,
    rateLimited: securityStats.rateLimited || 0,
    blockedRequests: securityStats.blockedRequests || 0,
    checks: { neon: 'unknown', storage: 'inline', schema: 'unknown' },
    pool: {
      total: db.pool?.totalCount,
      idle: db.pool?.idleCount,
      waiting: db.pool?.waitingCount,
    },
  };
  try {
    const ok = await db.healthCheck();
    result.checks.neon = ok ? 'ok' : 'error';
    if (!ok) result.ok = false;
  } catch (e) {
    result.checks.neon = 'error';
    result.ok = false;
    result.neonError = e.message;
  }
  try {
    await db.ensureSchema();
    result.checks.schema = 'ok';
  } catch (e) {
    result.checks.schema = 'error';
    result.schemaError = e.message;
  }
  res.status(result.ok ? 200 : 503).json(result);
});

// ========== Periodic cleanup of expired OTP codes ==========
setInterval(async () => {
  try {
    await db.query(
      'DELETE FROM otp_verifications WHERE expires_at < $1',
      [new Date().toISOString()]
    );
  } catch (e) {
    console.warn('Failed to cleanup old OTP codes:', e.message);
  }
}, 60 * 60 * 1000).unref?.();

// ========== Start server ==========
const port = Number(process.env.PORT || 3001);

async function boot() {
  try {
    await db.ensureSchema();
  } catch (e) {
    console.error('[boot] DB schema failed (server still starts):', e.message);
  }
  server.listen(port, () => {
    console.log(`🚀 Chiper server running on port ${port}`);
    console.log(`📡 WebSocket ready at ws://localhost:${port}`);
    console.log(`🛡️  Anti-DDoS active (OTP ≤${LIMITS.otp.max}/10m, API ≤${LIMITS.global.max}/min)`);
  });
}

boot();

module.exports = { app, server };
