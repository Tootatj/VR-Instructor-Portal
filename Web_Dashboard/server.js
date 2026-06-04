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
import { resolveByCode, getTenantInfo } from './src/tenants.js';
import {
  signSession,
  attachInstructor,
  requireInstructor,
  attachInstructorToSocket,
  buildCookieAttrs,
  INSTRUCTOR_COOKIE_NAME,
} from './src/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

const app = express();
app.use(express.json({ limit: '32kb' }));
// Auth middleware MUST run before any static or API handler that wants
// to read req.instructor. Static files are served AFTER the auth-gated
// dashboard route below so the gate redirects to /login.html cleanly.
app.use(attachInstructor);

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
// The faker still uses this (no auth — it's a dev tool) to grab the
// Agora App ID and the env-default tenant. The grid view used to also
// read defaultTenantId here, but as of Phase 6 it reads its tenant from
// /api/instructor/me (cookie-session) instead.
app.get('/api/config', (_req, res) => {
  res.json({
    appId: process.env.AGORA_APP_ID ?? null,
    defaultTenantId: process.env.DEFAULT_TENANT_ID ?? 'onebonsai',
  });
});

// --- API: VR device tenant resolution (Phase 6) ----------------------------
// POST /api/tenant/resolve { code }
//   → 200 { tenantId, displayName }
//   → 400 { error } on malformed input
//   → 401 { error } on unknown code
//
// Called by the VR app's UTenantRegistry on first launch after the user
// types the company code in the WBP_RegistrationGate widget. On success
// the headset persists { tenantId, displayName } to disk forever.
//
// Deliberately unauthenticated — the code itself is the credential, and
// brute-forcing 10-digit codes against a small whitelist over a rate-
// limited server is impractical. If the threat model tightens, add
// express-rate-limit here and on /api/instructor/login.
app.post('/api/tenant/resolve', (req, res) => {
  const { code } = req.body ?? {};
  if (typeof code !== 'string') {
    return res.status(400).json({ error: 'code must be a string' });
  }
  const hit = resolveByCode(code);
  if (!hit) {
    // Same error for "bad format" vs "valid format but unknown code" so
    // attackers can't distinguish the two via response timing/contents.
    return res.status(401).json({ error: 'code not recognized' });
  }
  console.log(`[VRIP] /api/tenant/resolve → tenant=${hit.tenantId} (${hit.displayName})`);
  res.json({ tenantId: hit.tenantId, displayName: hit.displayName });
});

// --- API: instructor login (Phase 6) ---------------------------------------
// POST /api/instructor/login { code, displayName? }
//   → 200 { tenantId, tenantDisplayName, instructorName } + Set-Cookie
//   → 400 / 401 (mirrors /api/tenant/resolve)
//
// Same code that registers a VR device also logs an instructor in. The
// optional displayName is purely cosmetic ("Jan is watching session
// 0823" in the header); if omitted we fall back to "Anonymous".
app.post('/api/instructor/login', (req, res) => {
  const { code, displayName } = req.body ?? {};
  if (typeof code !== 'string') {
    return res.status(400).json({ error: 'code must be a string' });
  }
  const tenant = resolveByCode(code);
  if (!tenant) {
    return res.status(401).json({ error: 'code not recognized' });
  }

  // Trim + truncate the display name so we don't store unbounded user
  // input in the cookie (RFC 6265 has a 4 KB practical limit and the
  // cookie is echoed back in every request header).
  const instructorName =
    typeof displayName === 'string' && displayName.trim().length > 0
      ? displayName.trim().slice(0, 48)
      : 'Anonymous';

  const cookieValue = signSession({
    tenantId: tenant.tenantId,
    displayName: instructorName,
  });
  res.setHeader(
    'Set-Cookie',
    `${INSTRUCTOR_COOKIE_NAME}=${encodeURIComponent(cookieValue)}; ${buildCookieAttrs(req)}`
  );

  console.log(
    `[VRIP] /api/instructor/login → tenant=${tenant.tenantId} ` +
    `instructor="${instructorName}" ip=${req.ip}`
  );
  res.json({
    tenantId: tenant.tenantId,
    tenantDisplayName: tenant.displayName,
    instructorName,
  });
});

// --- API: instructor logout (Phase 6) --------------------------------------
app.post('/api/instructor/logout', (req, res) => {
  res.setHeader(
    'Set-Cookie',
    `${INSTRUCTOR_COOKIE_NAME}=; ${buildCookieAttrs(req, { clear: true })}`
  );
  res.status(204).end();
});

// --- API: who am I (Phase 6) ----------------------------------------------
// GET /api/instructor/me
//   → 200 { tenantId, tenantDisplayName, instructorName, issuedAt }
//   → 401 if no valid session cookie
//
// The dashboard calls this on boot to discover its tenant scope (replaces
// the old `/api/config.defaultTenantId` path) and to render the header.
app.get('/api/instructor/me', requireInstructor, (req, res) => {
  const tenantInfo = getTenantInfo(req.instructor.tenantId);
  res.json({
    tenantId: req.instructor.tenantId,
    tenantDisplayName: tenantInfo?.displayName ?? req.instructor.tenantId,
    instructorName: req.instructor.displayName,
    issuedAt: req.instructor.issuedAt,
  });
});

// --- API: sessions discovery (grid view) -----------------------------------
// GET /api/sessions?page=1&pageSize=6
//   → { tenantId, page, pageSize, total, totalPages, sessions: [...] }
//
// Tenant is taken from the instructor's session cookie — the
// `?tenantId=X` query param was removed in Phase 6 (defence-in-depth
// against trivial cross-tenant peek by URL-tampering). Sessions list is
// also pushed live to subscribed instructor sockets via the
// `sessions:changed` Socket.IO event (see pairing.js); this REST
// endpoint is the page-load entry point and the fallback for clients
// that haven't established a socket yet.
app.get('/api/sessions', requireInstructor, (req, res) => {
  const tenantId = req.instructor.tenantId;
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

// --- Dashboard auth gate (Phase 6) -----------------------------------------
// Anything that lands on `/` or `/index.html` without a valid instructor
// cookie is redirected to /login.html. Faker and single-session debug
// pages stay public — they're internal dev tools, not part of the
// customer-facing dashboard. This MUST come before the static handler.
app.get(['/', '/index.html'], (req, res, next) => {
  if (req.instructor) return next();
  return res.redirect(302, '/login.html');
});

app.use(express.static(join(__dirname, 'public')));

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

// Attach the instructor session (if any) to every connecting socket
// during handshake. Pairing/commands handlers read socket.data.instructor
// to enforce tenant scope on `instructor:subscribe-tenant` and friends.
io.use(attachInstructorToSocket);

registerPairingHandlers(io);
registerCommandHandlers(io);

// --- Boot ------------------------------------------------------------------
httpServer.listen(PORT, () => {
  const haveAgoraCreds = Boolean(process.env.AGORA_APP_ID && process.env.AGORA_APP_CERTIFICATE);
  console.log(`[VRIP] dashboard listening on http://localhost:${PORT}`);
  console.log(`[VRIP] static assets:    ${join(__dirname, 'public')}`);
  console.log(`[VRIP] agora creds set:  ${haveAgoraCreds ? 'yes' : 'NO — /api/token will 500'}`);
});
