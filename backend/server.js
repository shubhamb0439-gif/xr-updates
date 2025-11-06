// --------------------------------27-5:12----//////-------------Server.js ----------------duplicate id working version ----29-08-25------------------------------------

// // -------------------- Imports & Env --------------------
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { Server } = require('socket.io');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');
const axios = require('axios'); // for SOAP note generation
const sql = require('mssql');   // MSSQL driver
const { Sequelize } = require('sequelize');
const bcrypt = require('bcryptjs');
const session = require('express-session');

const { sequelize, connectToDatabase, closeDatabase } = require('./database/database-config');
const { getAzureSqlConnection } = require('./database/azure-db-helper');


const dotenv = require('dotenv');
const envCandidates = [
  path.resolve(__dirname, '.env'),
  path.resolve(__dirname, '..', '.env'),
];
let loadedFrom = null;
for (const p of envCandidates) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    loadedFrom = p;
    break;
  }
}
console.log('[ENV] .env loaded from:', loadedFrom || 'process.env only');
console.log('[BOOT] Instance:', process.env.WEBSITE_INSTANCE_ID || process.pid);

// -------------------- Platform Config Validation --------------------
const platformEnvCheck = {
  SESSION_SECRET: !!process.env.SESSION_SECRET,
  SUPERADMIN_EMAIL: !!process.env.SUPERADMIN_EMAIL,
  SUPERADMIN_PASSWORD_BCRYPT: !!process.env.SUPERADMIN_PASSWORD_BCRYPT,
};
const missingPlatformKeys = Object.keys(platformEnvCheck).filter(k => !platformEnvCheck[k]);
if (missingPlatformKeys.length > 0) {
  console.warn('[PLATFORM] Missing environment variables:', missingPlatformKeys.join(', '));
  console.warn('[PLATFORM] Super Admin login will not work until these are configured in .env');
} else {
  console.log('[PLATFORM] Super Admin credentials configured');
}

// -------------------- Debug helpers --------------------
const DEBUG_LOGS = (process.env.DEBUG_LOGS || 'true').toLowerCase() === 'true';
function dlog(...args) {
  if (DEBUG_LOGS) console.log(...['[DEBUG]'].concat(args));
}
function dwarn(...args) {
  console.warn(...['[WARN]'].concat(args));
}
function derr(...args) {
  console.error(...['[ERROR]'].concat(args));
}
function trimStr(s, max = 140) {
  if (typeof s !== 'string') return s;
  return s.length > max ? `${s.slice(0, max)}…(${s.length})` : s;
}
function safeDataPreview(obj) {
  try {
    const s = JSON.stringify(obj);
    return trimStr(s, 300);
  } catch {
    return '[unserializable]';
  }
}

// NEW: numeric coercion helper for telemetry
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// --- Safe global socket snapshot (fast-fail + local fallback) ---
async function safeFetchSockets(io, namespace = "/") {
  const nsp = io.of(namespace);

  // Always include local sockets immediately (never blocks)
  const local = Array.from(nsp.sockets?.values?.() || []);

  const adapter = nsp.adapter;
  const supportsGlobal = typeof nsp.fetchSockets === "function" && adapter && adapter.broadcast?.apply;
  if (!supportsGlobal) return local;

  try {
    // Short guard so device-list / identify / health never stall on a stale peer
    const guard = new Promise((_, reject) => setTimeout(() => reject(new Error("guard-timeout")), 750));
    const globalSockets = await Promise.race([nsp.fetchSockets(), guard]);

    // Merge local + global by socket.id
    const byId = new Map(local.map(s => [s.id, s]));
    for (const s of globalSockets) byId.set(s.id, s);
    return Array.from(byId.values());
  } catch (e) {
    console.warn("[WARN] [safeFetchSockets] global fetch failed; using local only:", e.message);
    return local;
  }
}


// -------------------- Env Flags --------------------
const IS_PROD =
  (process.env.NODE_ENV || '').toLowerCase().startsWith('prod') ||
  !!process.env.WEBSITE_SITE_NAME; // Azure sets this

// -------------------- Config & Servers --------------------
console.log('[INIT] Starting server initialization...');
const PORT = process.env.PORT || 8080;
console.log(`[CONFIG] Using port: ${PORT}`);
const app = express();
const server = http.createServer(app);
console.log('[HTTP] Server created');
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],   // ← include polling
  allowEIO3: true,
  pingInterval: 25000,
  pingTimeout: 30000,
});
console.log('[SOCKET.IO] Socket.IO server initialized');
// -------------------- Middleware --------------------
app.use(cors());
app.use(express.json());
console.log('[MIDDLEWARE] CORS + JSON enabled');

// Session middleware for platform admin
const sessionSecret = process.env.SESSION_SECRET || 'change-me-in-production';
app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);
console.log('[MIDDLEWARE] Session enabled');

// ✅ Connect to Azure SQL via Sequelize on boot (non-fatal if it fails)
(async () => {
  try {
    await connectToDatabase();
    console.log('🚀 [DB] Azure SQL connection established');
  } catch (err) {
    console.error('❌ [DB] Failed to connect to Azure SQL (continuing without DB):', err?.message || err);
    // NOTE: Do not exit; server keeps running without DB.
  }
})();


// // -------------------- UI routes (migrated from frontend/server.js) --------------------
// // Point these to your FRONTEND folders on disk:
// const VIEWS_DIR = path.join(__dirname, '../frontend/views');
// const PUBLIC_DIR = path.join(__dirname, '../frontend/public');

// // Serve static assets (CSS/JS/images) under /public
// app.use('/public', express.static(PUBLIC_DIR));

// // Keep HTML fresh (optional, safe for XR flows)
// app.use((req, res, next) => {
//   if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
//     res.set('Cache-Control', 'no-store');
//   }
//   next();
// });

// const sendView = (name) => (_req, res) => res.sendFile(path.join(VIEWS_DIR, name));
// const sendPublic = (name) => (_req, res) => res.sendFile(path.join(PUBLIC_DIR, name));

// // PWA top-level files (keep at root paths)
// app.get('/manifest.webmanifest', sendPublic('manifest.webmanifest'));
// // ✅ Fix: alias /sw.js → use existing file public/js/sw-device.js
// app.get('/sw.js', (req, res) => {
//   res.type('application/javascript');
//   res.sendFile(path.join(PUBLIC_DIR, 'js', 'sw-device.js'));
// });

// // PWA (Device-only) files
// app.get('/device.webmanifest', (req, res) => {
//   res.type('webmanifest');
//   res.sendFile(path.join(PUBLIC_DIR, 'device.webmanifest'));
// });

// app.get('/device/sw.js', (req, res) => {
//   // scope service worker to /device/
//   res.set('Service-Worker-Allowed', '/device/');
//   res.type('application/javascript');
//   res.sendFile(path.join(PUBLIC_DIR, 'js', 'sw-device.js'));
// });



// // Pretty routes → views
// app.get(['/device', '/device/'], sendView('device.html'));
// app.get(['/dashboard', '/dashboard/'], sendView('dashboard.html'));
// app.get(['/scribe-cockpit', '/scribe-cockpit/'], sendView('scribe-cockpit.html'));
// // (optional legacy)
// app.get(['/operator', '/operator/'], sendView('operator.html'));



// // Root route → views/index.html
// app.get('/', sendView('index.html'));

// 🧩 Paths
const FRONTEND_VIEWS = path.join(__dirname, '..', 'frontend', 'views');
const FRONTEND_PUBLIC = path.join(__dirname, '..', 'frontend', 'public');
const BACKEND_PUBLIC = path.join(__dirname, 'public');

// 🧠 Choose which directory actually exists
const VIEWS_DIR = fs.existsSync(FRONTEND_VIEWS) ? FRONTEND_VIEWS : BACKEND_PUBLIC;
const PUBLIC_DIR = fs.existsSync(FRONTEND_PUBLIC) ? FRONTEND_PUBLIC : BACKEND_PUBLIC;

app.use('/public', express.static(PUBLIC_DIR));
console.log(`[STATIC] Serving UI assets from ${PUBLIC_DIR}`);

// Keep HTML fresh (safe for XR flows)
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

const sendView = (name) => (_req, res) => {
  const filePath = path.join(VIEWS_DIR, name);
  if (!fs.existsSync(filePath)) {
    console.warn(`[WARN] Missing view: ${filePath}`);
    return res.status(404).send(`View not found: ${name}`);
  }

  try {
    const html = fs.readFileSync(filePath, 'utf8');

    // inject TURN config if function available
    const injected = (typeof injectTurnConfig === 'function')
      ? injectTurnConfig(html)
      : html;

    // Make sure the result is HTML
    res.type('html').send(injected);
  } catch (err) {
    console.error('[sendView] error reading / sending view:', err);
    res.status(500).send('Server error');
  }
};

// PWA assets — keep this ABOVE any /device HTML route
// Serve both common manifest URLs, but point both to device.webmanifest
app.get(['/manifest.webmanifest', '/device.webmanifest'], (req, res) => {
  res.type('application/manifest+json');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'device.webmanifest')); // file exists here
});

// Map ALL service-worker entrypoints to the same script
app.get(['/sw.js', '/sw-device.js', '/device/sw.js'], (req, res) => {
  res.type('application/javascript');
  res.set('Service-Worker-Allowed', '/device/');             // allow /device/* scope
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'sw-device.js'));       // NOTE: no /js subfolder
});


// Pretty routes → views
app.get(['/device', '/device/'], sendView('device.html'));
app.get(['/dashboard', '/dashboard/'], sendView('dashboard.html'));
app.get(['/scribe-cockpit', '/scribe-cockpit/'], sendView('scribe-cockpit.html'));
app.get(['/operator', '/operator/'], sendView('operator.html'));
app.get(['/platform', '/platform/'], sendView('platform.html'));
app.get('/', sendView('index.html'));




// -------------------- Static --------------------
// Frontend now serves all UI. Do NOT expose ../frontend here.
const backendPublic = path.join(__dirname, 'public');
if (fs.existsSync(backendPublic)) {
  app.use(express.static(backendPublic)); // keep only if you really have backend-only assets
  console.log(`[STATIC] Serving static from ${backendPublic}`);
} else {
  dlog('[STATIC] backend/public not found');
}

// -------------------- TURN Injection --------------------
function injectTurnConfig(html) {
  const raw = (process.env.TURN_URL || '').split(/[,\s]+/).filter(Boolean);

  const expand = (u) => {
    if (!u) return [];
    // If full turn/turns URL provided, use as-is
    if (/^(stun|turns?):/i.test(u)) return [u];
    // If only a host was given (e.g. "turn.example.com"), synthesize common variants.
    const host = String(u).replace(/:\d+$/, '');
    return [
      `turns:${host}:443?transport=tcp`,   // <- critical for iOS/corporate/captive networks
      `turns:${host}:5349?transport=tcp`,
      `turn:${host}:3478?transport=tcp`,
      `turn:${host}:3478?transport=udp`
    ];
  };

  // Flatten all provided items (comma/space separated env)
  const urls = raw.flatMap(expand);

  const cfg = `
    <script>
      window.TURN_CONFIG = {
        urls: ${urls.length <= 1 ? JSON.stringify(urls[0] || '') : JSON.stringify(urls)},
        username: ${JSON.stringify(process.env.TURN_USERNAME || '')},
        credential: ${JSON.stringify(process.env.TURN_CREDENTIAL || '')}
      };
    </script>`;

  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${cfg}\n</body>`) : (html + cfg);
}



// -------------------- Room Concept State --------------------
const clients = new Map();        // xrId -> socket
const desktopClients = new Map(); // xrId -> desktop socket
const onlineDevices = new Map();  // xrId -> socket (convenience)
// NEW: latest battery snapshot per device
const batteryByDevice = new Map(); // xrId -> { pct, charging, ts }

// NEW: latest network telemetry per device
// shape: { xrId, connType, wifiDbm, wifiMbps, wifiBars, cellDbm, cellBars, ts }
const telemetryByDevice = new Map();

const qualityByDevice = new Map(); // xrId -> latest webrtc quality snapshot

dlog('[ROOM] State maps initialized');

// --- Time-series history for charts (keep last 24 hours) ---
const METRIC_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const telemetryHist = new Map(); // xrId -> [{ ts, connType, wifiMbps, netDownMbps, netUpMbps, batteryPct }]
const qualityHist = new Map();   // xrId -> [{ ts, jitterMs, rttMs, lossPct, bitrateKbps }]


function pushHist(map, xrId, sample) {
  const arr = map.get(xrId) || [];
  arr.push(sample);
  const cutoff = Date.now() - METRIC_WINDOW_MS;
  while (arr.length && arr[0].ts < cutoff) arr.shift();
  map.set(xrId, arr);
}


const allowedPairs = new Set([normalizePair('XR-1234', 'XR-1238')]);
const PAIRINGS_MAP = new Map([
  ['XR-1234', 'XR-1238'],
  ['XR-1238', 'XR-1234'],
]);
dlog('[ROOM] allowedPairs:', Array.from(allowedPairs));
dlog('[ROOM] PAIRINGS_MAP:', Array.from(PAIRINGS_MAP.entries()));

function normalizePair(a, b) {
  return [a, b].sort().join('|');
}
async function isPairAllowed(a, b) {
  const key = normalizePair(a, b);
  const allowed = allowedPairs.has(key);
  dlog('[PAIR] isPairAllowed?', a, b, '=>', allowed, 'key=', key);
  return allowed;
}
function getRoomIdForPair(a, b) {
  const [one, two] = [a, b].sort();
  const roomId = `pair:${one}:${two}`;
  dlog('[ROOM] getRoomIdForPair', a, b, '=>', roomId);
  return roomId;
}
function listRoomMembers(roomId) {
  const set = io.sockets.adapter.rooms.get(roomId);
  if (!set) {
    dlog('[ROOM] listRoomMembers: empty for', roomId);
    return [];
  }
  const members = Array.from(set).map((sid) => {
    const s = io.sockets.sockets.get(sid);
    return s?.data?.xrId || sid;
  });
  dlog('[ROOM] listRoomMembers', roomId, '=>', members);
  return members;
}

function collectPairs() {
  const pairs = [];
  for (const [roomId] of io.sockets.adapter.rooms) {
    if (!roomId.startsWith('pair:')) continue;
    const members = listRoomMembers(roomId); // returns xrIds
    if (members.length >= 2) {
      const key = normalizePair(members[0], members[1]);
      const [a, b] = key.split('|');
      pairs.push({ a, b });
    }
  }
  return pairs;
}

function broadcastPairs() {
  const pairs = collectPairs();
  io.emit('room_update', { pairs });
  dlog('[PAIR] broadcastPairs:', pairs);
}

async function tryAutoPair(deviceId) {
  dlog('[AUTO_PAIR] attempt for', deviceId);
  const partnerId = PAIRINGS_MAP.get(deviceId);
  dlog('[AUTO_PAIR] partnerId:', partnerId);
  if (!partnerId) return false;

  const meSocket = clients.get(deviceId);
  const partnerSocket = clients.get(partnerId);
  dlog('[AUTO_PAIR] me?', !!meSocket, 'partner?', !!partnerSocket);
  if (!meSocket || !partnerSocket) return false;

  const allowed = await isPairAllowed(deviceId, partnerId);
  if (!allowed) return false;

  const roomId = getRoomIdForPair(deviceId, partnerId);
  const room = io.sockets.adapter.rooms.get(roomId);
  const memberCount = room ? room.size : 0;
  dlog('[AUTO_PAIR] roomId:', roomId, 'current members:', memberCount);
  if (memberCount >= 2) return false;

  await meSocket.join(roomId);
  await partnerSocket.join(roomId);
  meSocket.data.roomId = roomId;
  partnerSocket.data.roomId = roomId;
  dlog('[AUTO_PAIR] joined both to', roomId);

  const members = listRoomMembers(roomId);
  io.to(roomId).emit('room_joined', { roomId, members });
  dlog('[AUTO_PAIR] room_joined emitted for', roomId, 'members:', members);

  // NEW: tell dashboards the pair is active
  broadcastPairs();
  return true;
}

// -------------------- Utilities --------------------
function roomOf(xrId) {
  return `xr:${xrId}`;
}

const messageHistory = [];
dlog('[STATE] messageHistory initialized');




async function buildDeviceListGlobal() {
  dlog('[DEVICE_LIST] building (global via fetchSockets)');
  const sockets = await safeFetchSockets(io, "/");
  const byId = new Map();

  for (const s of sockets) {
    const id = s?.data?.xrId;
    if (!id) continue;

    // Pull latest battery snapshot if we have one
    const b = batteryByDevice?.get(id) || {};
    // 🔵 NEW: network telemetry snapshot
    const t = telemetryByDevice?.get(id) || null;

    byId.set(id, {
      xrId: id,
      deviceName: s.data?.deviceName || 'Unknown',
      // Battery fields
      battery: (typeof b.pct === 'number') ? b.pct : null,
      charging: !!b.charging,
      batteryTs: b.ts || null,
      // 🔵 Telemetry fields (optional)
      ...(t ? { telemetry: t } : {}),
    });
  }

  const list = [...byId.values()];
  dlog('[DEVICE_LIST] built:', list);
  return list;
}


async function broadcastDeviceList() {
  dlog('[DEVICE_LIST] broadcast start');
  try {
    const list = await buildDeviceListGlobal();
    io.emit('device_list', list);
    dlog('[DEVICE_LIST] broadcast done (size:', list.length, ')');
  } catch (e) {
    dwarn('[DEVICE_LIST] Failed to build list:', e.message);
  }
}


// Emit an empty device list once (used to drive cockpit blackout)
function broadcastEmptyDeviceListOnce() {
  try {
    dlog('[DEVICE_LIST] broadcasting EMPTY list (blackout)');
    io.emit('device_list', []); // force UIs to show "No devices online"
  } catch (e) {
    dwarn('[DEVICE_LIST] empty broadcast failed:', e.message);
  }
}

function addToMessageHistory(message) {
  messageHistory.push({ ...message, id: Date.now(), timestamp: new Date().toISOString() });
  if (messageHistory.length > 100) {
    messageHistory.shift();
  }
  dlog('[MSG_HISTORY] added; len=', messageHistory.length);
}

// -------------------- Routes --------------------
app.get('/health', async (_req, res) => {
  dlog('[HEALTH] request');
  try {
    const sockets = await safeFetchSockets(io, "/");
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      instanceId: process.env.WEBSITE_INSTANCE_ID || process.pid,
      connectedClients: sockets.length,
    });
  } catch {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      instanceId: process.env.WEBSITE_INSTANCE_ID || process.pid,
      connectedClients: 'unknown',
    });
  }
});

app.post('/api/medications/availability', async (req, res) => {
  dlog('[MEDICATION_API] request received');
  try {
    const { names } = req.body;

    if (!Array.isArray(names)) {
      return res.status(400).json({ error: 'Expected "names" array in request body' });
    }

    if (names.length === 0) {
      return res.json({ results: [] });
    }

    dlog(`[MEDICATION_API] Checking ${names.length} medication(s)`);

    const schema = 'dbo';
    const table = 'DrugMaster';
    const nameCol = 'drug';

    function normalizeTerm(s) {
      return String(s || '')
        .toLowerCase()
        .replace(/[ \-\/\.,'()]/g, '');
    }

    function extractDrugQuery(raw) {
      if (!raw) return null;
      let s = String(raw)
        .replace(/^[-•]\s*/u, '')
        .replace(/\(.*?\)/g, '')
        .replace(/\b(tablet|tablets|tab|tabs|capsule|capsules|cap|caps|syrup|susp(?:ension)?|inj(?:ection)?)\b/gi, '')
        .replace(/\b(po|od|bd|tid|qid|prn|q\d+h|iv|im|sc|sl)\b/gi, '')
        .replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|kg|ml|l|iu|units|%)\b/gi, '')
        .split(/\b\d/)[0]
        .replace(/[.,;:/]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return s || null;
    }

    async function findDrugMatch(q) {
      const raw = String(q || '').trim();
      const rawLike = `%${raw}%`;
      const norm = normalizeTerm(raw);
      const normLike = `%${norm}%`;

      const normExpr = `
        REPLACE(
          REPLACE(
            REPLACE(
              REPLACE(
                REPLACE(
                  REPLACE(
                    REPLACE(
                      REPLACE(LOWER([${nameCol}]), '-', ''), ',', ''), '/', ''), '.', ''), '''', ''), ' ', ''), '(', ''), ')', '')
      `;

      const sql = `
        SELECT TOP 1 [${nameCol}] AS name
        FROM [${schema}].[${table}]
        WHERE status = 1
          AND [${nameCol}] IS NOT NULL
          AND (
            LOWER([${nameCol}]) = LOWER(:raw)
            OR LOWER([${nameCol}]) LIKE LOWER(:rawLike)
            OR ${normExpr} = :norm
            OR ${normExpr} LIKE :normLike
          )
        ORDER BY
          CASE
            WHEN ${normExpr} = :norm THEN 1
            WHEN LOWER([${nameCol}]) = LOWER(:raw) THEN 2
            WHEN ${normExpr} LIKE :normLike THEN 3
            ELSE 4
          END,
          [${nameCol}];
      `;

      const rows = await sequelize.query(sql, {
        replacements: { raw, rawLike, norm, normLike },
        type: Sequelize.QueryTypes.SELECT
      });
      return rows?.[0]?.name || null;
    }

    const results = [];
    for (const name of names) {
      const query = extractDrugQuery(name);
      if (!query) {
        results.push({ name, available: false });
        continue;
      }

      try {
        const matched = await findDrugMatch(query);
        results.push({ name, available: !!matched });
        dlog(`[MEDICATION_API] "${name}" => ${matched ? 'AVAILABLE' : 'NOT FOUND'}`);
      } catch (e) {
        dwarn(`[MEDICATION_API] Error checking "${name}":`, e.message);
        results.push({ name, available: false });
      }
    }

    res.json({ results });
  } catch (err) {
    derr('[MEDICATION_API] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// -------------------- Platform Admin Routes --------------------

function requireSuperAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'superadmin') {
    return next();
  }
  return res.status(401).json({ ok: false, message: 'Unauthorized' });
}

app.post('/api/platform/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ ok: false, message: 'Email and password required' });
    }

    const superAdminEmail = process.env.SUPERADMIN_EMAIL;
    const superAdminPasswordBcrypt = process.env.SUPERADMIN_PASSWORD_BCRYPT;

    if (!superAdminEmail || !superAdminPasswordBcrypt) {
      console.error('[PLATFORM] Missing SUPERADMIN_EMAIL or SUPERADMIN_PASSWORD_BCRYPT in environment');
      const isDev = process.env.NODE_ENV !== 'production';
      return res.status(500).json({
        ok: false,
        message: 'Server configuration error',
        ...(isDev && { missing: [
          !superAdminEmail && 'SUPERADMIN_EMAIL',
          !superAdminPasswordBcrypt && 'SUPERADMIN_PASSWORD_BCRYPT'
        ].filter(Boolean) })
      });
    }

    const emailTrimmed = email.trim();
    if (emailTrimmed.toLowerCase() !== superAdminEmail.toLowerCase()) {
      return res.status(401).json({ ok: false, message: 'Invalid credentials' });
    }

    const isValid = await bcrypt.compare(password, superAdminPasswordBcrypt);
    if (!isValid) {
      return res.status(401).json({ ok: false, message: 'Invalid credentials' });
    }

    req.session.user = {
      role: 'superadmin',
      email: emailTrimmed,
    };

    console.log('[PLATFORM] Super admin logged in:', emailTrimmed);
    return res.json({ ok: true, role: 'superadmin', email: emailTrimmed });
  } catch (err) {
    console.error('[PLATFORM] Login error:', err);
    return res.status(500).json({ ok: false, message: 'Internal server error' });
  }
});

app.get('/api/platform/me', (req, res) => {
  if (req.session && req.session.user && req.session.user.role === 'superadmin') {
    return res.json({
      ok: true,
      role: req.session.user.role,
      email: req.session.user.email,
    });
  }
  return res.json({ ok: false });
});

app.post('/api/platform/logout', (req, res) => {
  if (req.session) {
    req.session.destroy((err) => {
      if (err) {
        console.error('[PLATFORM] Logout error:', err);
        return res.status(500).json({ ok: false, message: 'Logout failed' });
      }
      return res.json({ ok: true });
    });
  } else {
    return res.json({ ok: true });
  }
});

app.get('/platform/secure/ping', requireSuperAdmin, (req, res) => {
  const conn = getAzureSqlConnection();
  const dbStatus = conn ? 'configured' : 'mock_mode';
  return res.json({
    ok: true,
    message: 'Authorized',
    user: req.session.user,
    database: dbStatus,
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/platform/config-status', (req, res) => {
  return res.json({
    env: {
      SESSION_SECRET: !!process.env.SESSION_SECRET,
      SUPERADMIN_EMAIL: !!process.env.SUPERADMIN_EMAIL,
      SUPERADMIN_PASSWORD_BCRYPT: !!process.env.SUPERADMIN_PASSWORD_BCRYPT,
      DB_SERVER: !!process.env.DB_SERVER,
      DB_NAME: !!process.env.DB_NAME,
    },
    ready: !!(process.env.SESSION_SECRET && process.env.SUPERADMIN_EMAIL && process.env.SUPERADMIN_PASSWORD_BCRYPT),
  });
});

// ---- Desktop HTTP telemetry (beginner path) ----
app.post('/desktop-telemetry', (req, res) => {
  try {
    const d = req.body || {};
    const xrId = typeof d.xrId === 'string' ? d.xrId : null;
    if (!xrId) return res.status(400).json({ error: 'xrId required' });

    const rec = {
      xrId,
      connType: d.connType || 'other',
      // network (optional)
      wifiDbm: numOrNull(d.wifiDbm),
      wifiMbps: numOrNull(d.wifiMbps),
      wifiBars: numOrNull(d.wifiBars),
      cellDbm: numOrNull(d.cellDbm),
      cellBars: numOrNull(d.cellBars),
      netDownMbps: numOrNull(d.netDownMbps),
      netUpMbps: numOrNull(d.netUpMbps),
      // system
      cpuPct: numOrNull(d.cpuPct),
      memUsedMb: numOrNull(d.memUsedMb),
      memTotalMb: numOrNull(d.memTotalMb),
      deviceTempC: numOrNull(d.deviceTempC),
      ts: Date.now(),
    };

    // latest snapshot for device rows
    telemetryByDevice.set(xrId, rec);

    // history (drives charts/detail modal)
    pushHist(telemetryHist, xrId, {
      ts: rec.ts,
      connType: rec.connType,
      wifiMbps: rec.wifiMbps,
      netDownMbps: rec.netDownMbps,
      netUpMbps: rec.netUpMbps,
      batteryPct: batteryByDevice.get(xrId)?.pct ?? null,
      cpuPct: rec.cpuPct,
      memUsedMb: rec.memUsedMb,
      memTotalMb: rec.memTotalMb,
      deviceTempC: rec.deviceTempC,
    });

    // broadcast to dashboards (same event Android uses)
    io.emit('telemetry_update', rec);

    dlog('[desktop-telemetry] update', rec);
    res.status(204).end();
  } catch (e) {
    dwarn('[desktop-telemetry] bad payload:', e?.message || e);
    res.status(400).json({ error: 'bad payload' });
  }
});


// -------------------- Redis Adapter --------------------
(async () => {
  try {
    const REDIS_URL = process.env.REDIS_URL;
    if (REDIS_URL) {
      const useTls = (process.env.REDIS_TLS || 'true').toLowerCase() === 'true';
      dlog('[REDIS] connecting', { REDIS_URL: trimStr(REDIS_URL, 80), useTls });
      const pub = createClient({ url: REDIS_URL, socket: { tls: useTls } });
      const sub = pub.duplicate();
      await Promise.all([pub.connect(), sub.connect()]);
      io.adapter(createAdapter(pub, sub));
      console.log('[SOCKET.IO] Redis adapter attached');
    } else {
      dwarn('[SOCKET.IO] No REDIS_URL set. Running without Redis adapter.');
    }
  } catch (e) {
    derr('[SOCKET.IO] Redis adapter failed; continuing in-memory:', e.message);
  }
})();

// ---- Medication sanitizer: keep only "pure" medication (name ± strength) ----
function normalizeMedicationList(raw) {
  // Accept string or array; split strings into items
  let items = Array.isArray(raw) ? raw.slice() :
    typeof raw === 'string' ? raw.split(/[\n;,]+/) : [];

  return items
    .map(s => (s ?? '').toString())
    // strip bullets/numbering
    .map(s => s.replace(/^\s*[-•\u2022\u25CF]*\s*\d*[.)]?\s*/g, '').trim())
    // keep only the leading "drug name [strength unit]" and drop trailing sentences
    .map(s => {
      // Try to capture: Name (letters, numbers, spaces, -, /) + optional strength (e.g., 500 mg)
      const m = s.match(/^([A-Za-z][A-Za-z0-9\s\-\/]+?(?:\s+\d+(?:\.\d+)?\s*(?:mg|mcg|g|kg|ml|mL|l|L|iu|IU|units|mcL|µg|%))?)/);
      if (m) return m[1].trim();

      // Fallback: cut at the first sentence break, but keep decimals like "2.5 mg"
      const cut = s.split(/(?<!\d)\.(?!\d)/)[0]; // split on period not between digits
      return cut.trim();
    })
    // remove common instruction tails if any slipped through
    .map(s => s.replace(/\b(take|give|use|apply|instill|one|two|daily|once|twice|bid|tid|qid|po|prn|before|after|with|without|meals?|for|x|weeks?|days?|hours?)\b.*$/i, '').trim())
    // collapse extra spaces
    .map(s => s.replace(/\s{2,}/g, ' ').trim())
    // drop empties
    .filter(s => s.length > 0);
}




// -------------------- SOAP Note Generator --------------------
async function generateSoapNote(transcript) {
  try {
    const prompt = `
      Based on the provided transcript, generate a structured SOAP note.
      Sections (always in this order):
      - Chief Complaints
      - History of Present Illness
      - Subjective
      - Objective
      - Assessment
      - Plan
      - Medication
 
      Rules:
      - Each section should be an array of strings OR "No data available".
      - If info missing, explicitly write "No data available".
      - JSON only, no extra commentary.
 
      Transcript:
      ${transcript.trim()}
    `;

    // ADDED: Use Abacus.AI RouteLLM instead of OpenAI
    const ABACUS_API_KEY = process.env.ABACUS_API_KEY; // ADDED
    if (!ABACUS_API_KEY) throw new Error('Missing ABACUS_API_KEY in environment');
    const ABACUS_MODEL = ((process.env.ABACUS_MODEL).trim());
    const ABACUS_TEMPERATURE = Number(process.env.ABACUS_TEMPERATURE);
    let llmEndpoint = (process.env.ABACUS_LLM_ENDPOINT || '').trim();
    if (!llmEndpoint) {
      const epRes = await axios.get('https://api.abacus.ai/api/v0/getApiEndpoint', {
        headers: { 'apiKey': ABACUS_API_KEY },
      });
      llmEndpoint = epRes?.data?.result?.llmEndpoint;
    }
    if (!llmEndpoint) throw new Error('Could not resolve Abacus.AI LLM endpoint');

    const base = llmEndpoint.replace(/\/$/, '');

    // ADDED: OpenAI-compatible Chat Completions request body
    const reqBody = {
      model: ABACUS_MODEL,
      messages: [
        { role: 'system', content: 'You are a helpful assistant skilled at creating structured SOAP notes.' },
        { role: 'user', content: prompt },
      ],
      temperature: ABACUS_TEMPERATURE,
    };
    let chatResponse;
    try {
      chatResponse = await axios.post(`${base}/v1/chat/completions`, reqBody, {
        headers: { 'Content-Type': 'application/json', 'apiKey': ABACUS_API_KEY },
      });
    } catch (e) {
      chatResponse = await axios.post(`${base}/chat/completions`, reqBody, {
        headers: { 'Content-Type': 'application/json', 'apiKey': ABACUS_API_KEY },
      });
    }
    const rawContent = (
      chatResponse?.data?.choices?.[0]?.message?.content?.trim() ||
      chatResponse?.data?.choices?.[0]?.text?.trim() ||
      chatResponse?.data?.output_text?.trim() ||
      ''
    );
    const soapNoteContent = rawContent
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '');

    let parsed;
    try {
      parsed = JSON.parse(soapNoteContent);
    } catch (e) {
      const first = soapNoteContent.indexOf('{');
      const last = soapNoteContent.lastIndexOf('}');
      if (first !== -1 && last !== -1) {
        parsed = JSON.parse(soapNoteContent.slice(first, last + 1));
      } else {
        throw e;
      }
    }
    // sanitize Medication to be pure medication items only
    const meds = normalizeMedicationList(parsed["Medication"]);
    return {
      "Chief Complaints": parsed["Chief Complaints"] || ["No data available"],
      "History of Present Illness": parsed["History of Present Illness"] || ["No data available"],
      "Subjective": parsed["Subjective"] || ["No data available"],
      "Objective": parsed["Objective"] || ["No data available"],
      "Assessment": parsed["Assessment"] || ["No data available"],
      "Plan": parsed["Plan"] || ["No data available"],
      "Medication": parsed["Medication"] || ["No data available"],
    };
  } catch (err) {
    console.error('[SOAP_NOTE] generation failed:', err.message);
    return {
      "Chief Complaints": ["Error generating note"],
      "History of Present Illness": ["Error generating note"],
      "Subjective": ["Error generating note"],
      "Objective": ["Error generating note"],
      "Assessment": ["Error generating note"],
      "Plan": ["Error generating note"],
      "Medication": ["Error generating note"],
    };
  }
}

// Parse Medication from SOAP note, check dbo.DrugMaster.drug, and log availability
async function checkSoapMedicationAvailability(soapNote, opts = {}) {
  const schema = opts.schema || 'dbo';
  const table = opts.table || 'DrugMaster';
  const nameCol = opts.nameCol || 'drug';

  // Normalize a term in JS exactly the same way we normalize in SQL
  function normalizeTerm(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[ \-\/\.,'()]/g, ''); // remove spaces and punctuation
  }

  function extractDrugQuery(raw) {
    if (!raw) return null;
    let s = String(raw)
      .replace(/^[-•]\s*/u, '')
      .replace(/\(.*?\)/g, '')
      .replace(/\b(tablet|tablets|tab|tabs|capsule|capsules|cap|caps|syrup|susp(?:ension)?|inj(?:ection)?)\b/gi, '')
      .replace(/\b(po|od|bd|tid|qid|prn|q\d+h|iv|im|sc|sl)\b/gi, '')
      .replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|kg|ml|l|iu|units|%)\b/gi, '')
      .split(/\b\d/)[0]
      .replace(/[.,;:/]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return s || null;
  }

  // Updated: stronger, consistent matching with status=1 filter
  async function findDrugMatch(q) {
    const raw = String(q || '').trim();
    const rawLike = `%${raw}%`;
    const norm = normalizeTerm(raw);
    const normLike = `%${norm}%`;

    // SQL-side normalization expression (mirrors normalizeTerm)
    const normExpr = `
      REPLACE(
        REPLACE(
          REPLACE(
            REPLACE(
              REPLACE(
                REPLACE(
                  REPLACE(
                    REPLACE(LOWER([${nameCol}]), '-', ''), ',', ''), '/', ''), '.', ''), '''', ''), ' ', ''), '(', ''), ')', '')
    `;

    const sql = `
      SELECT TOP 1 [${nameCol}] AS name
      FROM [${schema}].[${table}]
      WHERE status = 1
        AND [${nameCol}] IS NOT NULL
        AND (
          -- Exact (raw)
          LOWER([${nameCol}]) = LOWER(:raw)
          -- Contains (raw)
          OR LOWER([${nameCol}]) LIKE LOWER(:rawLike)
          -- Exact (normalized)
          OR ${normExpr} = :norm
          -- Contains (normalized)
          OR ${normExpr} LIKE :normLike
        )
      ORDER BY
        CASE
          WHEN ${normExpr} = :norm THEN 1
          WHEN LOWER([${nameCol}]) = LOWER(:raw) THEN 2
          WHEN ${normExpr} LIKE :normLike THEN 3
          ELSE 4
        END,
        [${nameCol}];
    `;

    const rows = await sequelize.query(sql, {
      replacements: { raw, rawLike, norm, normLike },
      type: Sequelize.QueryTypes.SELECT
    });
    return rows?.[0]?.name || null;
  }

  const meds = Array.isArray(soapNote?.Medication) ? soapNote.Medication : [];
  const queries = Array.from(new Set(
    meds
      .map(m => typeof m === 'string' ? m : (m?.name || m?.drug || m?.Medication || ''))
      .map(extractDrugQuery)
      .filter(Boolean)
  ));

  if (queries.length === 0) {
    console.log('[DRUG_CHECK] No medication entries to check.');
    return { results: [] };
  }

  const results = [];
  console.log(`[DRUG_CHECK] Checking ${queries.length} medication name(s) against ${schema}.${table}.${nameCol} ...`);
  for (const q of queries) {
    try {
      const matched = await findDrugMatch(q);
      if (matched) {
        console.log(`[DRUG_CHECK] "${q}" => AVAILABLE (matched as "${matched}")`);
        results.push({ query: q, status: 'exists', matched });
      } else {
        console.log(`[DRUG_CHECK] "${q}" => NOT FOUND`);
        results.push({ query: q, status: 'not_found', matched: null });
      }
    } catch (e) {
      console.log(`[DRUG_CHECK] "${q}" => ERROR: ${e.message || e}`);
      results.push({ query: q, status: 'error', error: String(e) });
    }
  }

  const ok = results.filter(r => r.status === 'exists').length;
  const nf = results.filter(r => r.status === 'not_found').length;
  console.log(`[DRUG_CHECK] Summary: ${ok} found, ${nf} not found, ${results.length - ok - nf} errors.`);
  return { results };
}

// -------------------- Socket.IO Handlers --------------------
io.on('connection', (socket) => {
  console.log(`🔌 [CONNECTION] ${socket.id}`);
  dlog('[CONNECTION] handshake.query:', safeDataPreview(socket.handshake?.query));

  // Send recent message history
  if (messageHistory.length > 0) {
    const recent = messageHistory.slice(-10);
    dlog('[CONNECTION] sending message_history size=', recent.length);
    socket.emit('message_history', { type: 'message_history', messages: recent });
  }

  // after sending message_history (or right at the top of the connection handler)
  (async () => {
    try {
      // send current presence snapshot
      const list = await buildDeviceListGlobal();
      socket.emit('device_list', list);

      // send current active pair snapshot
      socket.emit('room_update', { pairs: collectPairs() });
    } catch (e) {
      dwarn('[connection] initial snapshots failed:', e?.message || e);
    }
  })();

  // -------- join --------
  socket.on('join', (xrId) => {
    dlog('[EVENT] join', xrId);
    socket.data.xrId = xrId;
    socket.join(roomOf(xrId));
    clients.set(xrId, socket);
    onlineDevices.set(xrId, socket);
    (async () => {
      try {
        const list = await buildDeviceListGlobal();
        socket.emit('device_list', list);
        await broadcastDeviceList();
      } catch (e) {
        derr('[join] broadcast err:', e.message);
      }
    })();
  });


  // -------- identify --------
  socket.on('identify', async ({ deviceName, xrId }) => {
    dlog('[EVENT] identify', { deviceName, xrId });

    // Validate
    if (!xrId || typeof xrId !== 'string') {
      dwarn('[IDENTIFY] missing/invalid xrId');
      socket.emit('error', { message: 'Missing xrId' });
      return socket.disconnect(true);
    }

    // 🔒 GLOBAL duplicate guard (works across devices; cluster-wide with Redis adapter)
    try {
      const all = await safeFetchSockets(io, "/"); // includes other instances if Redis adapter is enabled
      const holder = all.find(s => s.id !== socket.id && s.data?.xrId === xrId);
      if (holder) {
        const holderInfo = {
          xrId,
          deviceName: holder.data?.deviceName || 'Unknown',
          since: holder.data?.connectedAt || null,
          socketId: holder.id,
        };
        dlog('[IDENTIFY] Duplicate xrId in use — rejecting:', holderInfo);

        // ✅ blackout Cockpit: broadcast an empty device list once
        broadcastEmptyDeviceListOnce();

        // (optional) re-broadcast the real list shortly after, if you want auto-recover
        setTimeout(async () => {
          try {
            await broadcastDeviceList();
          } catch (e) {
            dwarn('[DEVICE_LIST] delayed re-broadcast failed:', e.message);
          }
        }, 1200);

        socket.emit('duplicate_id', { xrId, holderInfo });
        return socket.disconnect(true);
      }
    } catch (e) {
      dwarn('[IDENTIFY] fetchSockets failed; continuing cautiously:', e?.message || e);
    }

    // ✅ Accept this socket
    socket.data.deviceName = deviceName || 'Unknown';
    socket.data.xrId = xrId;
    socket.data.connectedAt = Date.now();

    try { await socket.join(roomOf(xrId)); } catch (e) { dwarn('[IDENTIFY] join room failed:', e?.message || e); }
    clients.set(xrId, socket);
    onlineDevices.set(xrId, socket);

    // Track desktop for convenience (no replacement logic anymore)
    if ((deviceName?.toLowerCase().includes('desktop')) || xrId === 'XR-1238') {
      desktopClients.set(xrId, socket);
      dlog('[IDENTIFY] desktop client tracked', xrId);
    }

    // Send lists and maybe auto-pair
    try {
      const list = await buildDeviceListGlobal();
      socket.emit('device_list', list);
      await broadcastDeviceList();
    } catch (e) {
      derr('[identify] device_list error:', e.message);
    }

    try {
      if (!socket.data?.roomId) {
        await tryAutoPair(xrId);
      } else {
        dlog('[IDENTIFY] Skipping tryAutoPair; already in room', socket.data.roomId);
      }
    } catch (e) {
      derr('[identify] tryAutoPair error:', e.message);
    }
  });

  // -------- metrics_subscribe / unsubscribe (NEW) --------
  socket.on('metrics_subscribe', ({ xrId }) => {
    if (!xrId) return;
    socket.join(`metrics:${xrId}`);
    socket.emit('metrics_snapshot', {
      xrId,
      telemetry: telemetryHist.get(xrId) || [],
      quality: qualityHist.get(xrId) || [],
    });
  });

  socket.on('metrics_unsubscribe', ({ xrId }) => {
    if (!xrId) return;
    socket.leave(`metrics:${xrId}`);
  });




  // -------- request_device_list --------
  socket.on('request_device_list', async () => {
    dlog('[EVENT] request_device_list');
    try {
      socket.emit('device_list', await buildDeviceListGlobal());
    } catch (e) {
      dwarn('[request_device_list] failed:', e.message);
    }
  });

  // -------- pair_with --------
  socket.on('pair_with', async ({ peerId }) => {
    dlog('[EVENT] pair_with', { me: socket.data?.xrId, peerId });
    try {
      const me = socket.data?.xrId;
      if (!me || !peerId) {
        dwarn('[pair_with] missing me or peerId');
        socket.emit('pair_error', { message: 'Identify and provide peerId' });
        return;
      }
      const allowed = await isPairAllowed(me, peerId);
      if (!allowed) {
        dwarn('[pair_with] not allowed', me, peerId);
        socket.emit('pair_error', { message: 'Pairing not allowed' });
        return;
      }
      const roomId = getRoomIdForPair(me, peerId);
      await socket.join(roomId);
      socket.data.roomId = roomId;

      const members = listRoomMembers(roomId);
      io.to(roomId).emit('room_joined', { roomId, members });
      dlog('[pair_with] room_joined emitted', { roomId, members });

      // NEW: push active pair state to dashboards
      broadcastPairs();
    } catch (err) {
      derr('[pair_with] error:', err.message);
      socket.emit('pair_error', { message: 'Internal server error during pairing' });
    }
  });

  // -------- signal --------
  socket.on('signal', (payload) => {
    // 1) Normalize payload (object or JSON string)
    let msg = payload;
    try { msg = (typeof payload === 'string') ? JSON.parse(payload) : (payload || {}); }
    catch (e) { return dwarn('[signal] JSON parse failed'); }

    const { type } = msg;
    dlog('📡 [EVENT] signal', { type, preview: safeDataPreview(msg) });

    try {
      // 2) Intercept Android/Dock quality feed and **return** (don’t fall through)
      if (type === 'webrtc_quality_update') {
        const deviceId = msg.deviceId;
        const samples = Array.isArray(msg.samples) ? msg.samples : [];

        if (deviceId && samples.length) {
          // Store to the existing per-device history so your detail modal works
          for (const s of samples) {
            pushHist(qualityHist, deviceId, {
              ts: s.ts,
              jitterMs: numOrNull(s.jitterMs),
              rttMs: numOrNull(s.rttMs),
              lossPct: numOrNull(s.lossPct),
              bitrateKbps: numOrNull(s.bitrateKbps),
            });
          }

          // Stream the latest deltas to any open detail modal subscribers
          io.to(`metrics:${deviceId}`).emit('metrics_update', {
            xrId: deviceId,
            quality: samples.map(s => ({
              ts: s.ts,
              jitterMs: s.jitterMs,
              rttMs: s.rttMs,
              lossPct: s.lossPct,
              bitrateKbps: s.bitrateKbps,
            })),
          });

          // Broadcast to dashboards (powers the connection tiles)
          io.emit('webrtc_quality_update', { deviceId, samples });
        }
        return; // ✅ do not route as a regular signaling message
      }

      // 3) Existing offer/answer/ICE path (unchanged)
      const { from, to, data } = msg;
      if (to) {
        dlog('[signal] direct target routing to', to);
        io.to(roomOf(to)).emit('signal', { type, from, data });
        return;
      }
      const roomId = socket.data?.roomId;
      if (!roomId) {
        dwarn('[signal] no "to" and no roomId; ignoring');
        socket.emit('signal_error', { message: 'No room joined and no "to" specified' });
        return;
      }
      dlog('[signal] room forward', roomId);
      socket.to(roomId).emit('signal', { type, from, data });
    } catch (err) {
      derr('[signal] handler error:', err.message);
    }
  });


  // -------- control --------
  socket.on('control', (raw) => {
    // Accept string or object payloads
    let p = raw;
    try {
      p = (typeof raw === 'string') ? JSON.parse(raw) : (raw || {});
    } catch {
      p = (raw || {});
    }

    // Accept both `command` and `action`; keep original casing for compatibility
    const cmdRaw = (p.command != null ? p.command : p.action) || '';
    const cmd = String(cmdRaw);
    const from = p.from;
    const to = p.to;
    const msg = p.message;

    dlog('🎮 [EVENT] control', { command: cmd, from, to, message: trimStr(msg || '') });

    // Keep both keys so all clients see what they expect
    const payload = { command: cmd, action: cmd, from, message: msg };

    try {
      if (to) {
        dlog('[control] direct to', to);
        io.to(roomOf(to)).emit('control', payload);
      } else {
        const roomId = socket.data?.roomId;
        if (roomId) {
          dlog('[control] room emit', roomId);
          io.to(roomId).emit('control', payload);
        } else {
          dlog('[control] global emit');
          io.emit('control', payload);
        }
      }
    } catch (err) {
      derr('[control] handler error:', err.message);
    }
  });

  // -------- message (transcript -> web console via signal) --------
  socket.on('message', (payload) => {
    dlog('[EVENT] message', safeDataPreview(payload));

    let data;
    try {
      data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch (e) {
      return dwarn('[message] JSON parse failed:', e.message);
    }

    const type = data?.type || 'message';
    const from = data?.from;
    const to = data?.to;
    const text = data?.text;
    const urgent = !!data?.urgent;
    const timestamp = data?.timestamp || new Date().toISOString();

    // ✳️ Intercept transcripts: forward to desktop's web console via a signal, then STOP
    if (type === 'transcript') {
      const out = {
        type: 'transcript',
        from,
        to,
        text,
        final: !!data?.final,
        timestamp,
      };

      try {
        // Forward transcript to the intended UI
        if (to) {
          io.to(roomOf(to)).emit('signal', { type: 'transcript_console', from, data: out });
          dlog('[transcript] emitted signal "transcript_console" to', to);
        } else if (socket.data?.roomId) {
          io.to(socket.data.roomId).emit('signal', { type: 'transcript_console', from, data: out });
          dlog('[transcript] emitted signal "transcript_console" to room', socket.data.roomId);
        }

        // Generate SOAP note if this transcript is final
        if (out.final && out.text) {
          (async () => {
            try {
              const soapNote = await generateSoapNote(out.text);

              const target = socket.data?.roomId || (to ? roomOf(to) : null);

              // Send SOAP note back to console UI
              if (target) {
                io.to(target).emit('signal', {
                  type: 'soap_note_console',
                  from,
                  data: soapNote,
                });
              }
              console.log('[SOAP_NOTE]', JSON.stringify(soapNote, null, 2));

              // Check Medication against dbo.DrugMaster(drug) and log availability
              const { results } = await checkSoapMedicationAvailability(soapNote, {
                schema: 'dbo',
                table: 'DrugMaster',
                nameCol: 'drug',
              });

              // Emit availability to both Dock (target) and Scribe Cockpit
              if (target) {
                io.to(target).emit('signal', {
                  type: 'drug_availability_console',
                  from,
                  data: results,
                });
              }
              // Also broadcast to all connected clients (including Scribe Cockpit)
              io.emit('signal', {
                type: 'drug_availability',
                from,
                data: results,
              });
            } catch (e) {
              console.error('[SOAP/DRUG] failed:', e?.message || e);
            }
          })();
        }
      } catch (e) {
        dwarn('[transcript] emit failed:', e.message);
      }

      return; // stop normal message path
    }



    // Normal chat message path (unchanged)
    try {
      const msg = {
        type: 'message',
        from,
        to,
        text,
        urgent,
        sender: socket.data?.deviceName || from || 'unknown',
        xrId: from,
        timestamp,
      };
      addToMessageHistory(msg);

      if (to) {
        dlog('[message] direct to', to);
        io.to(roomOf(to)).emit('message', msg);
      } else {
        const roomId = socket.data?.roomId;
        if (roomId) {
          dlog('[message] room emit', roomId);
          io.to(roomId).emit('message', msg);
        } else {
          dlog('[message] global broadcast (excluding sender)');
          socket.broadcast.emit('message', msg);
        }
      }
    } catch (err) {
      derr('[message] handler error:', err.message);
    }
  });





  // -------- clear-messages --------
  socket.on('clear-messages', ({ by }) => {
    dlog('[EVENT] clear-messages', { by });
    const payload = { type: 'message-cleared', by, messageId: Date.now() };
    io.emit('message-cleared', payload);
  });

  // -------- clear_confirmation --------
  socket.on('clear_confirmation', ({ device }) => {
    dlog('[EVENT] clear_confirmation', { device });
    const payload = { type: 'message_cleared', by: device, timestamp: new Date().toISOString() };
    io.emit('message_cleared', payload);
  });

  // -------- status_report --------
  socket.on('status_report', ({ from, status }) => {
    dlog('[EVENT] status_report', { from, status: trimStr(status || '') });
    const payload = {
      type: 'status_report',
      from,
      status,
      timestamp: new Date().toISOString(),
    };
    const roomId = socket.data?.roomId;
    if (roomId) {
      dlog('[status_report] room emit', roomId);
      io.to(roomId).emit('status_report', payload);
    } else {
      dlog('[status_report] global emit');
      io.emit('status_report', payload);
    }
  });

  // -------- battery (NEW) --------
  socket.on('battery', ({ xrId, batteryPct, charging }) => {
    try {
      const id = xrId || socket.data?.xrId;
      if (!id) return;
      const pct = Math.max(0, Math.min(100, Number(batteryPct)));
      const rec = { pct, charging: !!charging, ts: Date.now() };

      batteryByDevice.set(id, rec);
      io.emit('battery_update', { xrId: id, pct: rec.pct, charging: rec.charging, ts: rec.ts });
      dlog('[battery] update', { id, pct: rec.pct, charging: rec.charging });
    } catch (e) {
      dwarn('[battery] bad payload:', e?.message || e);
    }
  });

  // -------- telemetry (NEW) --------
  socket.on('telemetry', (payload) => {
    try {
      const d = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const xrId = d.xrId || socket.data?.xrId;
      if (!xrId) return;

      // keep ALL fields (network + system)
      const rec = {
        xrId,
        connType: d.connType || 'none',

        // network (existing)
        wifiDbm: numOrNull(d.wifiDbm),
        wifiMbps: numOrNull(d.wifiMbps),
        wifiBars: numOrNull(d.wifiBars),
        cellDbm: numOrNull(d.cellDbm),
        cellBars: numOrNull(d.cellBars),
        netDownMbps: numOrNull(d.netDownMbps),
        netUpMbps: numOrNull(d.netUpMbps),

        // 🔵 system (NEW)
        cpuPct: numOrNull(d.cpuPct),
        memUsedMb: numOrNull(d.memUsedMb),
        memTotalMb: numOrNull(d.memTotalMb),
        deviceTempC: numOrNull(d.deviceTempC),

        ts: Date.now(),
      };

      // keep latest snapshot for device rows
      telemetryByDevice.set(xrId, rec);

      // time-series history (for modal charts)
      pushHist(telemetryHist, xrId, {
        ts: rec.ts,
        connType: rec.connType,
        wifiMbps: rec.wifiMbps,
        netDownMbps: rec.netDownMbps,
        netUpMbps: rec.netUpMbps,
        batteryPct: batteryByDevice.get(xrId)?.pct ?? null,

        // include system series
        cpuPct: rec.cpuPct,
        memUsedMb: rec.memUsedMb,
        memTotalMb: rec.memTotalMb,
        deviceTempC: rec.deviceTempC,
      });

      // live delta for open detail modal subscribers
      io.to(`metrics:${xrId}`).emit('metrics_update', {
        xrId,
        telemetry: [telemetryHist.get(xrId).at(-1)]
      });

      // broadcast the latest snapshot to dashboards
      io.emit('telemetry_update', rec);

      dlog('[telemetry] update', rec);
    } catch (e) {
      dwarn('[telemetry] bad payload:', e?.message || e);
    }
  });




  socket.on('webrtc_quality', (q) => {
    dlog('[QUALITY] recv', q);
    try {
      const xrId = (q && q.xrId) || socket.data?.xrId;
      if (!xrId) return;

      const snap = {
        xrId,
        ts: q.ts || Date.now(),
        jitterMs: numOrNull(q.jitterMs),
        lossPct: numOrNull(q.lossPct),
        rttMs: numOrNull(q.rttMs),
        fps: numOrNull(q.fps),
        dropped: numOrNull(q.dropped),
        nackCount: numOrNull(q.nackCount),
        // optional if your Dock computes it and sends it:
        bitrateKbps: numOrNull(q.bitrateKbps),
      };

      // keep latest (powers center tiles)
      qualityByDevice.set(xrId, snap);

      // 🔵 store to history + stream to detail subscribers
      pushHist(qualityHist, xrId, {
        ts: snap.ts,
        jitterMs: snap.jitterMs,
        rttMs: snap.rttMs,
        lossPct: snap.lossPct,
        bitrateKbps: snap.bitrateKbps,
      });
      io.to(`metrics:${xrId}`).emit('metrics_update', {
        xrId,
        quality: [qualityHist.get(xrId).at(-1)]
      });

      // existing broadcast (summary tiles)
      io.emit('webrtc_quality_update', Array.from(qualityByDevice.values()));
    } catch (e) {
      dwarn('[QUALITY] store/broadcast failed:', e?.message || e);
    }
  });




  // -------- message_history (on demand) --------
  socket.on('message_history', () => {
    dlog('[EVENT] message_history request');
    socket.emit('message_history', {
      type: 'message_history',
      messages: messageHistory.slice(-10),
    });
  });



  // Notify peers *before* Socket.IO removes the socket from rooms
  socket.on('disconnecting', () => {
    const xrId = socket.data?.xrId;
    if (!xrId) return;

    for (const roomId of socket.rooms) {
      if (roomId.startsWith('pair:')) {
        socket.to(roomId).emit('peer_left', { xrId, roomId });
        dlog('[disconnecting] notified peer_left', { xrId, roomId });
      }
    }
  });



  // Final cleanup and presence broadcast
  socket.on('disconnect', async (reason) => {
    dlog('❎ [EVENT] disconnect', {
      reason,
      xrId: socket.data?.xrId,
      device: socket.data?.deviceName
    });

    try {
      const xrId = socket.data?.xrId;
      if (xrId) {
        // Remove from your in-memory maps
        clients.delete(xrId);
        onlineDevices.delete(xrId);

        if (desktopClients.get(xrId) === socket) {
          desktopClients.delete(xrId);
          dlog('[disconnect] removed desktop client:', xrId);
        }
      }

      // Broadcast device list so UIs update without manual refresh
      await broadcastDeviceList();

      // ✅ NEW: after Socket.IO has pruned rooms, reflect pair changes
      setTimeout(() => {
        broadcastPairs();
      }, 0);

    } catch (err) {
      derr('[disconnect] cleanup error:', err.message);
    }
  });





  // -------- error --------
  socket.on('error', (err) => {
    derr(`[SOCKET_ERROR] ${socket.id}:`, err?.message || err);
  });
});




// -------------------- Start & Shutdown --------------------
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 [SERVER] Running on http://0.0.0.0:${PORT}`);
});

process.on('uncaughtException', (err) => {
  derr('[FATAL] uncaughtException:', err?.stack || err?.message || err);
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
  console.log('\n[SHUTDOWN] Starting graceful shutdown…');
  (async () => {
    try {
      const socketCount = io.sockets.sockets.size;
      dlog('[SHUTDOWN] active sockets:', socketCount);

      // 1) stop socket.io
      io.sockets.sockets.forEach((s) => s.disconnect(true));
      await new Promise((resolve) => io.close(resolve));
      console.log('[SHUTDOWN] Socket.IO closed');

      // 2) close HTTP server
      await new Promise((resolve) => server.close(resolve));
      console.log('[SHUTDOWN] HTTP server closed');

      // 3) close DB
      try {
        await closeDatabase();
      } catch (e) {
        dwarn('[SHUTDOWN] DB close error:', e?.message || e);
      }

      process.exit(0);
    } catch (e) {
      derr('[SHUTDOWN] error:', e?.message || e);
      process.exit(1);
    }
  })();
}

