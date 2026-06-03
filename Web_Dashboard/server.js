// VR Instructor Portal — Web Dashboard entry point.
//
// Per .cursorrules §4.3, this file stays thin: it wires up Express + HTTP +
// Socket.IO, mounts the token-mint endpoint, and delegates all real logic
// to the focused modules under src/.

import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mintToken, channelNameFor } from './src/agora.js';
import { lookupRoom, listSessionsForTenant, registerPairingHandlers } from './src/pairing.js';
import { registerCommandHandlers } from './src/commands.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(join(__dirname, 'public')));

// --- API: token mint -------------------------------------------------------
// POST /api/token { code, role: 'publisher'|'subscriber', uid?: number }
// → { appId, token, channel, uid, expiresAt }
//
// The endpoint is intentionally tied to an active pairing session: the code
// must already be in the pairing registry (headset has called
// `headset:register`), so randoms can't mint tokens for arbitrary channels.
app.post('/api/token', (req, res) => {
  try {
    const { code, role, uid } = req.body ?? {};
    if (!/^\d{4}$/.test(code ?? '')) {
      return res.status(400).json({ error: 'code must be a 4-digit string' });
    }
    if (role !== 'publisher' && role !== 'subscriber') {
      return res.status(400).json({ error: 'role must be "publisher" or "subscriber"' });
    }
    const room = lookupRoom(code);
    if (!room) {
      return res.status(404).json({ error: 'no active pairing session for this code' });
    }
    const channel = channelNameFor(room.tenantId, code);
    const tokenInfo = mintToken({
      tenantId: room.tenantId,
      channel,
      uid: Number.isInteger(uid) ? uid : 0,
      role,
    });
    res.json(tokenInfo);
  } catch (err) {
    console.error('[VRIP] /api/token failed', err);
    res.status(500).json({ error: err.message ?? 'token mint failed' });
  }
});

// --- API: client config (safe-to-expose subset) ----------------------------
// The faker and grid view both need the App ID (client-side, sent to Agora
// SD-RTN anyway) and the default tenant. Returning them via API beats baking
// them into static HTML — one .env file controls everything.
app.get('/api/config', (_req, res) => {
  res.json({
    appId: process.env.AGORA_APP_ID ?? null,
    defaultTenantId: process.env.DEFAULT_TENANT_ID ?? 'onebonsai',
  });
});

// --- API: sessions discovery (grid view) -----------------------------------
// GET /api/sessions?tenantId=onebonsai&page=1&pageSize=6
//   → { tenantId, page, pageSize, total, totalPages, sessions: [...] }
//
// Sessions list is also pushed live to subscribed instructor sockets via
// the `sessions:changed` Socket.IO event (see pairing.js); this REST
// endpoint is the page-load entry point and the fallback for clients that
// haven't established a socket yet.
app.get('/api/sessions', (req, res) => {
  const tenantId = (req.query.tenantId ?? process.env.DEFAULT_TENANT_ID ?? 'onebonsai').toString();
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 6));
  const all = listSessionsForTenant(tenantId);
  const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
  const offset = (page - 1) * pageSize;
  res.json({
    tenantId,
    page,
    pageSize,
    total: all.length,
    totalPages,
    sessions: all.slice(offset, offset + pageSize),
  });
});

// --- API: health -----------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// --- Socket.IO -------------------------------------------------------------
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  // Per .cursorrules §1.4, the command/pairing plane is independent of the
  // Agora video/audio plane. Defaults are fine; pinning the path so a future
  // reverse proxy doesn't accidentally rewrite it.
  path: '/socket.io',
  cors: {
    // v1 may run on a LAN per §7 — permissive CORS for development.
    // Tighten before any internet-facing deploy.
    origin: true,
    credentials: true,
  },
});

registerPairingHandlers(io);
registerCommandHandlers(io);

// --- Boot ------------------------------------------------------------------
httpServer.listen(PORT, () => {
  const haveAgoraCreds = Boolean(process.env.AGORA_APP_ID && process.env.AGORA_APP_CERTIFICATE);
  console.log(`[VRIP] dashboard listening on http://localhost:${PORT}`);
  console.log(`[VRIP] static assets:    ${join(__dirname, 'public')}`);
  console.log(`[VRIP] agora creds set:  ${haveAgoraCreds ? 'yes' : 'NO — /api/token will 500'}`);
});
