// Instructor → headset command relay, per .cursorrules §5.2.
//
// Every incoming payload is validated against the canonical schema BEFORE
// being relayed. Unknown commands are dropped + logged on the server (never
// crash, never forwarded). The headset ignores anything the server somehow
// did forward that it doesn't recognise (defence in depth).
//
// Multi-session model (Phase 4.5):
//   - Grid-view instructors are subscribed to a tenant, not paired 1:1 with
//     a code, so they pass `code` in the payload to target a specific
//     session.
//   - Tenant check: the payload's code must resolve to a room in the same
//     tenant the instructor subscribed to. Cross-tenant commands are
//     rejected (cheap defence against the typo case; real auth is Phase 5).
//   - Legacy 1:1 mode (instructor:join) still works without `code` in the
//     payload — falls back to socket.data.code.

import { lookupRoom } from './pairing.js';

/**
 * Per-command validators. Each returns `null` if the payload is well-formed
 * for that command, or a human-readable error string otherwise. Add new
 * commands here and document them in docs/commands.md in the same PR.
 */
const COMMAND_VALIDATORS = {
  pause_simulation: (p) =>
    typeof p.value === 'boolean' ? null : 'pause_simulation.value must be boolean',

  change_environment: (p) =>
    typeof p.map_name === 'string' && p.map_name.length > 0
      ? null
      : 'change_environment.map_name must be a non-empty string',

  trigger_event: (p) =>
    typeof p.event_type === 'string' && p.event_type.length > 0
      ? null
      : 'trigger_event.event_type must be a non-empty string',

  reset_user_position: () => null,
};

/**
 * Validate a command payload against the §5.2 schema.
 * @returns {string | null} null if valid; an error string otherwise.
 */
export function validateCommand(payload) {
  if (!payload || typeof payload !== 'object') return 'payload must be an object';
  if (typeof payload.command !== 'string') return 'payload.command must be a string';
  const validator = COMMAND_VALIDATORS[payload.command];
  if (!validator) return `unknown command "${payload.command}"`;
  return validator(payload);
}

export function registerCommandHandlers(io) {
  io.on('connection', (socket) => {
    socket.on('instructor:command', (payload, ack) => {
      if (socket.data.role !== 'instructor') {
        ack?.({ ok: false, error: 'only instructor sockets may dispatch commands' });
        return;
      }

      const err = validateCommand(payload);
      if (err) {
        console.warn(`[VRIP] command rejected sock=${socket.id}: ${err}`);
        ack?.({ ok: false, error: err });
        return;
      }

      // Multi-session model: payload.code identifies the target room.
      // Legacy model: fall back to the code the instructor was paired with.
      const targetCode = typeof payload.code === 'string' ? payload.code : socket.data.code;
      if (!targetCode) {
        ack?.({ ok: false, error: 'no target session (provide payload.code)' });
        return;
      }

      const room = lookupRoom(targetCode);
      if (!room?.headsetSocketId) {
        ack?.({ ok: false, error: 'no headset connected for this session' });
        return;
      }

      // Tenant scope check (cheap auth): if the instructor subscribed to a
      // tenant, the target room must live in that tenant. Single-session
      // pairing flows skip this check because they're already pinned to a
      // specific room.
      if (socket.data.tenantId && room.tenantId !== socket.data.tenantId) {
        ack?.({ ok: false, error: 'target session is in a different tenant' });
        return;
      }

      // We deliberately strip `code` before forwarding — the headset only
      // needs the command shape, not the routing metadata.
      const { code: _drop, ...forwarded } = payload;
      io.to(room.headsetSocketId).emit('headset:command', forwarded);
      ack?.({ ok: true });
    });
  });
}
