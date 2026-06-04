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

/**
 * Map<code, {
 *   tenantId: string,
 *   headsetSocketId?: string,
 *   instructorSocketId?: string,     // legacy 1:1 pairing (single-session debug)
 *   scenario?: string,                // free-form label, e.g. "Fire Training"
 *   traineeName?: string,             // free-form label, e.g. "Trainee 47"
 *   source?: 'headset' | 'faker',     // for debug + UI tagging
 *   startedAt: number,                // unix-ms when the room was first created
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
      ROOMS.set(code, room);

      socket.data.role = 'headset';
      socket.data.code = code;
      socket.data.tenantId = tenantId;
      socket.join(roomName(code));

      console.log(
        `[VRIP] headset:register code=${code} tenant=${tenantId} ` +
        `scenario="${room.scenario ?? ''}" trainee="${room.traineeName ?? ''}" ` +
        `source=${room.source} sock=${socket.id}`
      );

      ack?.({ ok: true, tenantId: room.tenantId });
      io.to(roomName(code)).emit('session:status', {
        state: room.instructorSocketId ? 'connected' : 'waiting',
      });
      broadcastSessionsChanged(io, tenantId);
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

function roomName(code) {
  return `code:${code}`;
}

function tenantRoomName(tenantId) {
  return `tenant:${tenantId}:instructors`;
}
