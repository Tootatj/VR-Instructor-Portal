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
 * App-agnostic command validators. These commands should work against any
 * VR app — they're meta-controls (pause, reset, change scene) that any
 * sensible VR experience can implement. Add new commands here and
 * document them in docs/commands.md in the same PR.
 *
 * Each returns `null` if the payload is well-formed for that command, or
 * a human-readable error string otherwise.
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
 * Per-app command validators (2026-06-15 — per-app interactive control
 * plane). Keyed by the room's `appId` (declared in `headset:register` per
 * docs/state-updates.md#application-identity). When forwarding a command,
 * the handler looks up the room's appId, checks this table FIRST, then
 * falls back to COMMAND_VALIDATORS above. A command with no validator in
 * either table is rejected as unknown.
 *
 * Adding a new VR app:
 *   1. Add a new key here matching the app's `appId` (PascalCase suggested).
 *   2. Document the commands in docs/commands.md under the matching
 *      `### appId: "X"` subsection.
 *   3. Document the corresponding state machine in docs/state-updates.md.
 *   4. Ship the per-app dashboard module at public/js/apps/<appId>.js.
 */
const APP_COMMAND_VALIDATORS = {
  // VR Fire Training. State machine + command lifecycle documented in
  // docs/state-updates.md#appid-vrft-vr-fire-training and
  // docs/commands.md#appid-vrft-vr-fire-training. The dashboard module
  // at public/js/apps/VRFT.js is responsible for only rendering buttons
  // that match the currently-published level list; the server enforces
  // shape only, the VR side is the final authority on which level IDs
  // are loadable.
  VRFT: {
    load_level: (p) =>
      typeof p.level_id === 'string' && p.level_id.length > 0
        ? null
        : 'load_level.level_id must be a non-empty string',
    return_to_hub: () => null,
  },
};

/**
 * Validate a command payload against the §5.2 schema.
 *
 * @param {object} payload - The command payload.
 * @param {string|null} appId - The target room's appId, if known. When
 *   provided, app-specific validators in APP_COMMAND_VALIDATORS[appId]
 *   are checked first. Legacy callers without appId still work — only
 *   the global COMMAND_VALIDATORS are consulted.
 * @returns {string|null} null if valid; an error string otherwise.
 */
export function validateCommand(payload, appId = null) {
  if (!payload || typeof payload !== 'object') return 'payload must be an object';
  if (typeof payload.command !== 'string') return 'payload.command must be a string';
  const appValidators = (appId && APP_COMMAND_VALIDATORS[appId]) || {};
  const validator = appValidators[payload.command] ?? COMMAND_VALIDATORS[payload.command];
  if (!validator) {
    return appId
      ? `unknown command "${payload.command}" for app "${appId}"`
      : `unknown command "${payload.command}"`;
  }
  return validator(payload);
}

export function registerCommandHandlers(io) {
  io.on('connection', (socket) => {
    socket.on('instructor:command', (payload, ack) => {
      if (socket.data.role !== 'instructor') {
        ack?.({ ok: false, error: 'only instructor sockets may dispatch commands' });
        return;
      }

      // Cheap pre-checks before we touch the room map — bail on payloads
      // that can't possibly route anywhere.
      if (!payload || typeof payload !== 'object') {
        ack?.({ ok: false, error: 'payload must be an object' });
        return;
      }
      if (typeof payload.command !== 'string') {
        ack?.({ ok: false, error: 'payload.command must be a string' });
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

      // App-aware validation: app-specific commands (e.g. VRFT's
      // load_level) only validate against the room's declared appId.
      // Falls back to global app-agnostic validators (pause_simulation,
      // reset_user_position, etc.) for cross-app commands. Order
      // matters: we have to look up the room before validating so the
      // validator can resolve app-specific commands.
      const err = validateCommand(payload, room.appId ?? null);
      if (err) {
        console.warn(`[VRIP] command rejected sock=${socket.id} code=${targetCode}: ${err}`);
        ack?.({ ok: false, error: err });
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
