// Instructor session auth via signed cookies, per Devlog 2026-06-04
// (Phase 6 single-code model).
//
// Why signed cookies and not a session store / JWT library:
//   - Sessions are tiny ({ tenantId, displayName, issuedAt }) and don't
//     need server-side state — perfect for stateless signed cookies.
//   - Avoids adding a new dependency (cookie-parser, express-session,
//     jsonwebtoken) for what is fundamentally an HMAC-SHA256 over a
//     base64url JSON blob. The whole flow is ~50 lines.
//   - On secret rotation, every existing session invalidates cleanly;
//     no DB cleanup needed.
//
// Security posture (v1, dev-LAN deploy per .cursorrules §7):
//   - HMAC-SHA256 over the payload. Constant-time comparison on verify.
//   - Cookie is HttpOnly + SameSite=Lax. Secure flag is enabled when the
//     request was served over HTTPS (set by your reverse proxy).
//   - 24 h max age. No refresh; instructor re-logs in after a day.
//   - This is NOT bulletproof auth — anyone with the per-tenant code can
//     log in as that tenant's instructor. Per-instructor accounts are a
//     later phase if/when the threat model demands it.

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const COOKIE_NAME = 'vrip_instructor';
const COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000;   // 24 h
const ENV_VAR = 'INSTRUCTOR_SESSION_SECRET';

// Lazily resolved at first use so the import-time error message is
// actionable (boot log already printed "agora creds set: yes/no") and so
// tests can inject a secret without polluting process.env.
let _secret = null;
function getSecret() {
  if (_secret) return _secret;
  const env = process.env[ENV_VAR];
  if (env && env.length >= 16) {
    _secret = Buffer.from(env, 'utf-8');
    return _secret;
  }
  // Dev fallback: generate a per-process random secret so login still
  // works without any .env config. Cookies invalidate on server restart,
  // which is fine for local dev. Production MUST set the env var.
  _secret = randomBytes(32);
  console.warn(
    `[VRIP auth] WARNING: ${ENV_VAR} not set (or < 16 chars) — generated an ephemeral secret. ` +
    `All instructor sessions will invalidate on the next server restart. Set ${ENV_VAR} to a 32+ char random string in .env for stable sessions.`
  );
  return _secret;
}

function b64urlEncode(buf) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replaceAll('-', '+').replaceAll('_', '/') + pad, 'base64');
}

function sign(payloadStr) {
  return b64urlEncode(createHmac('sha256', getSecret()).update(payloadStr).digest());
}

/**
 * Mint a session cookie value for an authenticated instructor.
 *
 * @param {{ tenantId: string, displayName: string }} session
 * @returns {string} cookie value (encode/sign two-tuple, no surrounding quotes)
 */
export function signSession(session) {
  const payload = {
    tenantId: session.tenantId,
    displayName: session.displayName,
    issuedAt: Date.now(),
  };
  const payloadEncoded = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf-8'));
  const sig = sign(payloadEncoded);
  return `${payloadEncoded}.${sig}`;
}

/**
 * Verify a session cookie value. Returns the parsed session if valid AND
 * within the max-age window, null otherwise. Constant-time signature
 * comparison defends against timing attacks on the HMAC.
 *
 * @param {string | undefined | null} cookieValue
 * @returns {{ tenantId: string, displayName: string, issuedAt: number } | null}
 */
export function verifySession(cookieValue) {
  if (typeof cookieValue !== 'string' || !cookieValue.includes('.')) return null;
  const [payloadEncoded, sigGiven] = cookieValue.split('.', 2);
  if (!payloadEncoded || !sigGiven) return null;

  const sigExpected = sign(payloadEncoded);
  const a = Buffer.from(sigGiven, 'utf-8');
  const b = Buffer.from(sigExpected, 'utf-8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadEncoded).toString('utf-8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.tenantId !== 'string' || typeof payload.issuedAt !== 'number') return null;
  if (Date.now() - payload.issuedAt > COOKIE_MAX_AGE_MS) return null;

  return {
    tenantId: payload.tenantId,
    displayName: typeof payload.displayName === 'string' ? payload.displayName : 'Anonymous',
    issuedAt: payload.issuedAt,
  };
}

/**
 * Pull the named cookie's value out of a raw Cookie header. Vanilla
 * implementation — keeps us off `cookie-parser` for one cookie.
 *
 * @param {string | undefined} cookieHeader
 * @param {string} name
 * @returns {string | undefined}
 */
function readCookie(cookieHeader, name) {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * Express middleware. Reads the instructor cookie, verifies it, attaches
 * `req.instructor = { tenantId, displayName, issuedAt }` if valid. Does
 * NOT 401 on failure — that's the route handler's job, because some
 * routes (login page, public health) need to remain accessible to
 * unauthenticated clients.
 */
export function attachInstructor(req, _res, next) {
  const raw = readCookie(req.headers.cookie, COOKIE_NAME);
  const session = verifySession(raw);
  if (session) req.instructor = session;
  next();
}

/**
 * Express middleware. 401s if no valid instructor session is attached.
 * Pair with `attachInstructor` earlier in the chain. Use on every
 * tenant-scoped API endpoint.
 */
export function requireInstructor(req, res, next) {
  if (!req.instructor) {
    return res.status(401).json({ error: 'instructor login required' });
  }
  next();
}

/**
 * Socket.IO middleware equivalent. Verifies the cookie on the
 * handshake; on success attaches `socket.data.instructor`. On failure,
 * we still allow the connection (headset sockets don't have cookies)
 * but downstream handlers that need an instructor session check
 * `socket.data.instructor`. This way headset and instructor sockets
 * share the same Socket.IO namespace cleanly.
 */
export function attachInstructorToSocket(socket, next) {
  const raw = readCookie(socket.handshake.headers.cookie, COOKIE_NAME);
  const session = verifySession(raw);
  if (session) socket.data.instructor = session;
  next();
}

/**
 * Pre-built Set-Cookie attributes shared between login (issue) and
 * logout (clear). `req` is needed to decide whether to set the `Secure`
 * flag — we can't always set it because dev runs over plain http.
 */
export function buildCookieAttrs(req, { clear = false } = {}) {
  const isHttps =
    req.protocol === 'https' ||
    req.headers['x-forwarded-proto'] === 'https';
  const attrs = [
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  if (isHttps) attrs.push('Secure');
  if (clear) {
    attrs.push(`Max-Age=0`);
  } else {
    attrs.push(`Max-Age=${Math.floor(COOKIE_MAX_AGE_MS / 1000)}`);
  }
  return attrs.join('; ');
}

export const INSTRUCTOR_COOKIE_NAME = COOKIE_NAME;
