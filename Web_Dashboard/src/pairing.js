// 4-digit pairing code registry + Socket.IO handlers, per .cursorrules §5.1.
//
// In-memory only (v1). Stateless across restarts is acceptable per §1.2
// because the headset's reconnect logic (§2.A.4) will re-register on any
// brief server outage. When a real DB lands, this module is the only one
// that needs to gain persistence.
//
// Phase 4.5 (multi-session grid) additions:
//   - Sessions carry richer metadata (scenario, traineeName, startedAt) so
//     the grid view can label tiles meaningfully.
//   - Instructors can now subscribe to a tenant (instead of pairing 1:1
//     with a code) and receive `sessions:changed` broadcasts. The legacy
//     1:1 `instructor:join` path stays for single-session debug.

import { isKnownTenant } from './tenants.js';

const CODE_PATTERN = /^\d{4}$/;
const TENANT_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;
const APP_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const STATE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_STATE_DATA_BYTES = 8 * 1024;

// Per-code state-update rate limiter (2026-06-15 — docs/state-updates.md).
// Sliding 3-second window, max 30 updates per code per window (≈10/s avg,
// burst of 30). Excess updates are dropped silently — the headset is
// expected to debounce on its side; this is a defence-in-depth safety net
// against a malformed BP graph that ticks every frame.
const STATE_UPDATE_WINDOW_MS = 3000;
const STATE_UPDATE_MAX_PER_WINDOW = 30;
const stateUpdateTimestamps = new Map(); // code → number[]

/**
 * Map<code, {
 *   tenantId: string,
 *   headsetSocketId?: string,
 *   instructorSocketId?: string,     // legacy 1:1 pairing (single-session debug)
 *   scenario?: string,                // free-form label, e.g. "Fire Training"
 *   traineeName?: string,             // free-form label, e.g. "Trainee 47"
 *   source?: 'headset' | 'faker',     // for debug + UI tagging
 *   startedAt: number,                // unix-ms when the room was first created
 *
 *   // 2026-06-15 — per-app interactive control plane. See
 *   // docs/state-updates.md for the wire spec.
 *   appId?: string,                   // e.g. "VRFT" (per docs/state-updates.md APP_ID_PATTERN)
 *   appVersion?: string,              // free-form, truncated to 32 chars
 *   currentState?: {
 *     name: string,                   // state-machine label, e.g. "hub" (STATE_NAME_PATTERN)
 *     data: object,                   // app-specific payload (≤ MAX_STATE_DATA_BYTES serialised)
 *     updatedAt: number,              // unix-ms of last update
 *     seq?: number,                   // optional monotonic seq for out-of-order rejection
 *   }
 * }>
 */
const ROOMS = new Map();

/**
 * Look up the room for a 4-digit code. Returns undefined if no headset has
 * registered with this code yet, OR if both peers have disconnected and the
 * room has been pruned.
 */
export function lookupRoom(code) {
  return ROOMS.get(code);
}

/**
 * Snapshot of all active sessions for a tenant, sorted by startedAt ascending
 * so the grid view stays visually stable as new sessions appear at the end.
 * Sessions without a connected headset are filtered out — a "ghost" room
 * with only an instructor pinned shouldn't show up as a live tile.
 *
 * Includes per-app fields (appId, appVersion, currentState) so a newly-
 * connecting instructor's focus view can render the correct per-app panel
 * with the current state immediately, without waiting for the next
 * state-update tick. Sessions whose headset never declared an appId get
 * `appId: null` and the dashboard renders a generic fallback panel.
 */
export function listSessionsForTenant(tenantId) {
  const out = [];
  for (const [code, room] of ROOMS.entries()) {
    if (room.tenantId !== tenantId) continue;
    if (!room.headsetSocketId) continue;
    out.push({
      code,
      tenantId: room.tenantId,
      scenario: room.scenario ?? null,
      traineeName: room.traineeName ?? null,
      source: room.source ?? 'headset',
      startedAt: room.startedAt,
      appId: room.appId ?? null,
      appVersion: room.appVersion ?? null,
      currentState: room.currentState ?? null,
    });
  }
  out.sort((a, b) => a.startedAt - b.startedAt);
  return out;
}

export function registerPairingHandlers(io) {
  io.on('connection', (socket) => {
    socket.data.role = null;
    socket.data.code = null;
    socket.data.tenantId = null;

    // -------------------------------------------------------------------
    // headset:register — a VR client (real or faker) declares itself
    // -------------------------------------------------------------------
    socket.on('headset:register', (payload, ack) => {
      const code = payload?.code;
      if (!CODE_PATTERN.test(code ?? '')) {
        ack?.({ ok: false, error: 'code must be a 4-digit string' });
        return;
      }
      const tenantId = payload?.tenantId ?? process.env.DEFAULT_TENANT_ID ?? 'onebonsai';
      if (!TENANT_PATTERN.test(tenantId)) {
        ack?.({ ok: false, error: 'invalid tenantId' });
        return;
      }
      // Phase 6 (Devlog 2026-06-04): defence-in-depth — the headset can
      // technically send any tenantId in `headset:register`, but only
      // tenants that exist in the registry (i.e. some real OneBonsai-
      // issued code resolved to them) are accepted. Stops a misbehaving
      // or rogue device from creating sessions in arbitrary tenant
      // namespaces. The legacy faker tool keeps working because it uses
      // DEFAULT_TENANT_ID which IS in the registry (data/tenant-codes.json).
      if (!isKnownTenant(tenantId)) {
        ack?.({ ok: false, error: `unknown tenant "${tenantId}" — not in registry` });
        console.warn(`[VRIP] headset:register rejected: tenant=${tenantId} not in registry sock=${socket.id}`);
        return;
      }

      // If this code was previously bound to a different headset that
      // dropped without disconnecting cleanly (e.g., wifi blip), we
      // overwrite. The room keeps its startedAt so "session duration" in
      // the grid view reads sensibly across the reconnect.
      const existing = ROOMS.get(code);
      const room = existing ?? {
        tenantId,
        startedAt: Date.now(),
      };

      room.headsetSocketId = socket.id;
      room.tenantId = tenantId;
      if (typeof payload?.scenario === 'string')    room.scenario = payload.scenario.slice(0, 64);
      if (typeof payload?.traineeName === 'string') room.traineeName = payload.traineeName.slice(0, 64);
      room.source = payload?.source === 'faker' ? 'faker' : 'headset';

      // 2026-06-15 per-app interactive control plane. appId is optional
      // for backward-compat (existing VR builds register without it and
      // get the generic fallback panel in the dashboard). When present,
      // it must match APP_ID_PATTERN to keep the dynamic module-loader
      // path (apps/<appId>.js) safe against traversal/injection. We
      // intentionally accept appId on re-registers — a single headset
      // could in principle swap VR apps without disconnecting, though
      // today's flow is one app per cold-launch.
      if (typeof payload?.appId === 'string' && APP_ID_PATTERN.test(payload.appId)) {
        room.appId = payload.appId;
      }
      if (typeof payload?.appVersion === 'string') {
        room.appVersion = payload.appVersion.slice(0, 32);
      }

      ROOMS.set(code, room);

      socket.data.role = 'headset';
      socket.data.code = code;
      socket.data.tenantId = tenantId;
      socket.join(roomName(code));

      console.log(
        `[VRIP] headset:register code=${code} tenant=${tenantId} ` +
        `scenario="${room.scenario ?? ''}" trainee="${room.traineeName ?? ''}" ` +
        `app=${room.appId ?? '(none)'}${room.appVersion ? `@${room.appVersion}` : ''} ` +
        `source=${room.source} sock=${socket.id}`
      );

      ack?.({ ok: true, tenantId: room.tenantId });
      io.to(roomName(code)).emit('session:status', {
        state: room.instructorSocketId ? 'connected' : 'waiting',
      });
      broadcastSessionsChanged(io, tenantId);
    });

    // -------------------------------------------------------------------
    // headset:state-update — per-app state machine transition from headset
    // -------------------------------------------------------------------
    // Wire format: docs/state-updates.md (2026-06-15 — per-app interactive
    // control plane). The headset emits this whenever its app-specific
    // state machine transitions (e.g. VRFT moving from "boot" → "hub" →
    // "level_loading" → "level_active"). The server validates the shape,
    // caches the latest state on the room (so newly-connecting instructors
    // get it immediately via `sessions:changed`), and fans out a
    // `session:state-changed` event to subscribed instructor sockets.
    //
    // Authz: only the socket that's the room's current headsetSocketId can
    // push state for it (defence-in-depth against socket hijacking).
    //
    // Rate-limited per code (see STATE_UPDATE_WINDOW_MS above): excess
    // updates dropped silently. The headset BP/C++ is expected to emit
    // once per real state transition, not once per frame.
    socket.on('headset:state-update', (payload, ack) => {
      const code = payload?.code;
      if (!CODE_PATTERN.test(code ?? '')) {
        ack?.({ ok: false, error: 'code must be a 4-digit string' });
        return;
      }
      const room = ROOMS.get(code);
      if (!room) {
        ack?.({ ok: false, error: 'no active room for this code' });
        return;
      }
      if (room.headsetSocketId !== socket.id) {
        ack?.({ ok: false, error: 'not the owning headset' });
        return;
      }

      const stateName = payload?.state;
      if (typeof stateName !== 'string' || !STATE_NAME_PATTERN.test(stateName)) {
        ack?.({ ok: false, error: 'state must be a lowercase snake_case string (≤64 chars)' });
        return;
      }

      const data = payload?.data ?? {};
      if (data !== null && typeof data !== 'object') {
        ack?.({ ok: false, error: 'data must be an object' });
        return;
      }
      // Size cap — bound the per-room memory footprint regardless of what
      // a VR app decides to push. 8 KB is generous for state-display
      // payloads (a level list of 50 entries fits comfortably).
      let serialisedDataBytes;
      try {
        serialisedDataBytes = Buffer.byteLength(JSON.stringify(data), 'utf8');
      } catch {
        ack?.({ ok: false, error: 'data must be JSON-serialisable' });
        return;
      }
      if (serialisedDataBytes > MAX_STATE_DATA_BYTES) {
        ack?.({ ok: false, error: `data exceeds ${MAX_STATE_DATA_BYTES} bytes` });
        return;
      }

      // Optional monotonic seq for out-of-order rejection. If both old and
      // new have a seq, new must be >= old. If either is missing, last-
      // write-wins (the common case — most apps won't bother with seq).
      const seq = Number.isInteger(payload?.seq) ? payload.seq : undefined;
      const prevSeq = room.currentState?.seq;
      if (seq !== undefined && prevSeq !== undefined && seq < prevSeq) {
        ack?.({ ok: true, dropped: 'out-of-order' });
        return;
      }

      // Rate-limit.
      if (!checkStateUpdateRateLimit(code)) {
        ack?.({ ok: false, error: 'rate limit exceeded' });
        return;
      }

      const now = Date.now();
      const prevName = room.currentState?.name;
      room.currentState = { name: stateName, data, updatedAt: now, ...(seq !== undefined ? { seq } : {}) };

      // Log transitions (state change), not every refresh (same state with
      // updated data). Avoids log spam from periodic in-state progress
      // updates while still surfacing the lifecycle events that matter.
      if (prevName !== stateName) {
        console.log(
          `[VRIP] headset:state-update code=${code} app=${room.appId ?? '(none)'} ` +
          `state=${prevName ?? '(none)'} → ${stateName} sock=${socket.id}`
        );
      }

      ack?.({ ok: true });
      broadcastStateChanged(io, room.tenantId, code, room);
    });

    // -------------------------------------------------------------------
    // headset:end — graceful shutdown from the headset side
    // -------------------------------------------------------------------
    // Phase E addition. Closes the §5.1 protocol gap where the only way a
    // room got pruned was via the disconnect handler — which fires AFTER a
    // ~20-30 s socket timeout when a headset crashes or is power-cycled
    // without a clean disconnect. The Quest's USignalingSubsystem now emits
    // this on Deinitialize so the tile disappears from the grid the moment
    // the trainee finishes the session, not 30 s later.
    //
    // Authz: only the socket that's the room's current headsetSocketId can
    // end the room (prevents a malicious peer from forcibly closing a
    // session by guessing a 4-digit code).
    socket.on('headset:end', (payload, ack) => {
      const code = payload?.code;
      if (!CODE_PATTERN.test(code ?? '')) {
        ack?.({ ok: false, error: 'code must be a 4-digit string' });
        return;
      }
      const room = ROOMS.get(code);
      if (!room) {
        ack?.({ ok: true, alreadyEnded: true });
        return;
      }
      if (room.headsetSocketId !== socket.id) {
        ack?.({ ok: false, error: 'not the owning headset' });
        return;
      }

      const tenantId = room.tenantId;

      // Tell any pinned instructor (legacy 1:1 path) that the session is
      // really gone — distinct from the transient "reconnecting" state the
      // disconnect handler emits.
      io.to(roomName(code)).emit('session:status', { state: 'ended' });

      ROOMS.delete(code);
      stateUpdateTimestamps.delete(code);
      console.log(`[VRIP] headset:end code=${code} tenant=${tenantId} sock=${socket.id}`);

      ack?.({ ok: true });
      broadcastSessionsChanged(io, tenantId);
    });

    // -------------------------------------------------------------------
    // instructor:subscribe-tenant — grid-view instructors land here
    // -------------------------------------------------------------------
    // Replaces the 1:1 instructor:join model for the grid view: one
    // instructor socket can monitor every active session in a tenant,
    // receive live sessions:changed updates, and dispatch commands to any
    // specific session by passing { code, ... } in instructor:command.
    socket.on('instructor:subscribe-tenant', (payload, ack) => {
      // Phase 6 (Devlog 2026-06-04): instructor sockets MUST present a
      // valid session cookie (attached by auth.js Socket.IO middleware
      // on handshake). The tenantId in the payload is ignored — only
      // the cookie's tenantId is authoritative. This closes the gap
      // where a logged-in Securitas instructor could otherwise emit
      // `instructor:subscribe-tenant { tenantId: "customerx" }` over
      // the socket and bypass the REST auth.
      const instructor = socket.data.instructor;
      if (!instructor) {
        ack?.({ ok: false, error: 'instructor login required' });
        return;
      }
      const tenantId = instructor.tenantId;
      if (!TENANT_PATTERN.test(tenantId ?? '')) {
        ack?.({ ok: false, error: 'invalid tenantId in session' });
        return;
      }

      // Leave any previous tenant room (cookie could rotate mid-socket
      // if the user logs out + back in to a different tenant in the
      // same tab — unlikely, but cheap to handle).
      if (socket.data.tenantId && socket.data.tenantId !== tenantId) {
        socket.leave(tenantRoomName(socket.data.tenantId));
      }

      socket.data.role = 'instructor';
      socket.data.tenantId = tenantId;
      socket.join(tenantRoomName(tenantId));

      console.log(
        `[VRIP] instructor:subscribe-tenant tenant=${tenantId} ` +
        `instructor="${instructor.displayName}" sock=${socket.id}`
      );

      ack?.({
        ok: true,
        tenantId,
        sessions: listSessionsForTenant(tenantId),
      });
    });

    // -------------------------------------------------------------------
    // instructor:join — legacy 1:1 pairing (single-session debug view)
    // -------------------------------------------------------------------
    socket.on('instructor:join', (payload, ack) => {
      const code = payload?.code;
      if (!CODE_PATTERN.test(code ?? '')) {
        ack?.({ ok: false, error: 'code must be a 4-digit string' });
        return;
      }
      const room = ROOMS.get(code);
      if (!room?.headsetSocketId) {
        ack?.({ ok: false, error: 'no headset is waiting with this code' });
        return;
      }
      room.instructorSocketId = socket.id;

      socket.data.role = 'instructor';
      socket.data.code = code;
      socket.data.tenantId = room.tenantId;
      socket.join(roomName(code));

      console.log(`[VRIP] instructor:join code=${code} tenant=${room.tenantId} sock=${socket.id}`);

      ack?.({ ok: true, tenantId: room.tenantId });
      io.to(roomName(code)).emit('session:status', { state: 'connected' });
    });

    // -------------------------------------------------------------------
    // disconnect — prune + notify
    // -------------------------------------------------------------------
    socket.on('disconnect', () => {
      const code = socket.data.code;
      const role = socket.data.role;
      const tenantId = socket.data.tenantId;

      // Grid-view instructor: just leave the tenant room (Socket.IO handles
      // that automatically). No ROOMS entry to clean up.
      if (role === 'instructor' && !code) return;

      if (!code) return;
      const room = ROOMS.get(code);
      if (!room) return;

      if (role === 'headset' && room.headsetSocketId === socket.id) {
        room.headsetSocketId = undefined;
        io.to(roomName(code)).emit('session:status', { state: 'reconnecting' });
      } else if (role === 'instructor' && room.instructorSocketId === socket.id) {
        room.instructorSocketId = undefined;
        io.to(roomName(code)).emit('session:status', {
          state: room.headsetSocketId ? 'waiting' : 'reconnecting',
        });
      }

      const headsetGone = !room.headsetSocketId;
      if (!room.headsetSocketId && !room.instructorSocketId) {
        ROOMS.delete(code);
        stateUpdateTimestamps.delete(code);
        console.log(`[VRIP] room pruned: code=${code}`);
      }

      // Either the headset left or the whole room is gone — either way the
      // grid view needs to refresh.
      if (headsetGone && tenantId) {
        broadcastSessionsChanged(io, tenantId);
      }
    });
  });
}

function broadcastSessionsChanged(io, tenantId) {
  io.to(tenantRoomName(tenantId)).emit('sessions:changed', {
    tenantId,
    sessions: listSessionsForTenant(tenantId),
  });
}

/**
 * Fan-out a per-app state transition to every instructor watching this
 * tenant (grid view) and to the legacy 1:1 instructor pinned to this
 * specific code (single-session debug view). Socket.IO dedupes if a
 * socket is somehow in both rooms.
 *
 * Wire format mirrors what listSessionsForTenant emits per-session so
 * dashboard code can use a single rendering path whether the data
 * arrived as part of a sessions:changed snapshot or a live
 * session:state-changed event.
 */
function broadcastStateChanged(io, tenantId, code, room) {
  const payload = {
    tenantId,
    code,
    appId: room.appId ?? null,
    appVersion: room.appVersion ?? null,
    state: room.currentState.name,
    data: room.currentState.data,
    updatedAt: room.currentState.updatedAt,
    ...(room.currentState.seq !== undefined ? { seq: room.currentState.seq } : {}),
  };
  io.to(tenantRoomName(tenantId)).to(roomName(code)).emit('session:state-changed', payload);
}

/**
 * Sliding-window rate limiter for per-code state updates. Returns true
 * if this update should be accepted, false if dropped. Mutates the
 * stateUpdateTimestamps map in place.
 */
function checkStateUpdateRateLimit(code) {
  const now = Date.now();
  let ts = stateUpdateTimestamps.get(code) ?? [];
  const windowStart = now - STATE_UPDATE_WINDOW_MS;
  ts = ts.filter((t) => t >= windowStart);
  if (ts.length >= STATE_UPDATE_MAX_PER_WINDOW) {
    // Persist the trimmed array so we don't redo the filter on every drop.
    stateUpdateTimestamps.set(code, ts);
    return false;
  }
  ts.push(now);
  stateUpdateTimestamps.set(code, ts);
  return true;
}

function roomName(code) {
  return `code:${code}`;
}

function tenantRoomName(tenantId) {
  return `tenant:${tenantId}:instructors`;
}
