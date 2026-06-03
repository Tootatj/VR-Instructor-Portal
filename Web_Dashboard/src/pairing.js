// 4-digit pairing code registry + Socket.IO handlers, per .cursorrules §5.1.
//
// In-memory only (v1). Stateless across restarts is acceptable per §1.2
// because the headset's reconnect logic (§2.A.4) will re-register on any
// brief server outage. When a real DB lands, this module is the only one
// that needs to gain persistence.

const CODE_PATTERN = /^\d{4}$/;

/** Map<code, { headsetSocketId?: string, instructorSocketId?: string, tenantId: string }> */
const ROOMS = new Map();

/**
 * Look up the room for a 4-digit code. Returns undefined if no headset has
 * registered with this code yet, OR if both peers have disconnected and the
 * room has been pruned.
 *
 * Exported so /api/token can verify "this code is bound to a real session"
 * before minting a token — closes the "any rando can mint a token for any
 * channel" hole.
 */
export function lookupRoom(code) {
  return ROOMS.get(code);
}

export function registerPairingHandlers(io) {
  io.on('connection', (socket) => {
    socket.data.role = null;
    socket.data.code = null;

    socket.on('headset:register', (payload, ack) => {
      const code = payload?.code;
      if (!CODE_PATTERN.test(code ?? '')) {
        ack?.({ ok: false, error: 'code must be a 4-digit string' });
        return;
      }
      const tenantId = payload?.tenantId ?? process.env.DEFAULT_TENANT_ID ?? 'default';

      // If this code was previously bound to a different headset that
      // dropped without disconnecting cleanly (e.g., wifi blip on the
      // device), we deliberately overwrite. The instructor side won't
      // notice as long as the room still has an instructor pinned — they
      // get a session:status=connected re-broadcast.
      const room = ROOMS.get(code) ?? { tenantId };
      room.headsetSocketId = socket.id;
      ROOMS.set(code, room);

      socket.data.role = 'headset';
      socket.data.code = code;
      socket.join(roomName(code));

      console.log(`[VRIP] headset:register code=${code} tenant=${tenantId} sock=${socket.id}`);

      ack?.({ ok: true, tenantId: room.tenantId });
      io.to(roomName(code)).emit('session:status', {
        state: room.instructorSocketId ? 'connected' : 'waiting',
      });
    });

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
      socket.join(roomName(code));

      console.log(`[VRIP] instructor:join code=${code} sock=${socket.id}`);

      ack?.({ ok: true, tenantId: room.tenantId });
      io.to(roomName(code)).emit('session:status', { state: 'connected' });
    });

    socket.on('disconnect', () => {
      const code = socket.data.code;
      const role = socket.data.role;
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

      if (!room.headsetSocketId && !room.instructorSocketId) {
        ROOMS.delete(code);
        console.log(`[VRIP] room pruned: code=${code}`);
      }
    });
  });
}

function roomName(code) {
  return `code:${code}`;
}
