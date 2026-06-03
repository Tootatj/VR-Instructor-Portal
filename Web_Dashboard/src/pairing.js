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
    // instructor:subscribe-tenant — grid-view instructors land here
    // -------------------------------------------------------------------
    // Replaces the 1:1 instructor:join model for the grid view: one
    // instructor socket can monitor every active session in a tenant,
    // receive live sessions:changed updates, and dispatch commands to any
    // specific session by passing { code, ... } in instructor:command.
    socket.on('instructor:subscribe-tenant', (payload, ack) => {
      const tenantId = payload?.tenantId;
      if (!TENANT_PATTERN.test(tenantId ?? '')) {
        ack?.({ ok: false, error: 'invalid tenantId' });
        return;
      }

      // Leave any previous tenant room (instructor may switch companies).
      if (socket.data.tenantId && socket.data.tenantId !== tenantId) {
        socket.leave(tenantRoomName(socket.data.tenantId));
      }

      socket.data.role = 'instructor';
      socket.data.tenantId = tenantId;
      socket.join(tenantRoomName(tenantId));

      console.log(`[VRIP] instructor:subscribe-tenant tenant=${tenantId} sock=${socket.id}`);

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
