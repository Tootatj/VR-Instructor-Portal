# Canonical command schema — Instructor → Headset

This document is the source of truth for the JSON command payloads that flow
from the instructor browser through the Socket.IO signaling server to the
Quest headset. It mirrors `.cursorrules §5.2` and is enforced server-side by
`Web_Dashboard/src/commands.js`.

## Transport

- **Wire format:** JSON only (per `.cursorrules §1.2`).
- **Field naming:** `snake_case` (per `.cursorrules §5.2`).
- **Direction:** Instructor browser → Socket.IO server → Headset BP.
- **Instructor → server event:** `instructor:command`, payload = the JSON below, with an optional Socket.IO `ack` callback that returns `{ ok: boolean, error?: string }`.
- **Server → headset event:** `headset:command`, payload = the same JSON (forwarded unchanged after validation).

## Schema

Every command is a JSON object with at minimum a string `command` field.

### 1. Pause / Resume Simulation

```json
{ "command": "pause_simulation", "value": true }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `command` | string | yes | Must be `"pause_simulation"` |
| `value` | boolean | yes | `true` = pause, `false` = resume |

### 2. Change Environment

```json
{ "command": "change_environment", "map_name": "ArcticOutpost" }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `command` | string | yes | Must be `"change_environment"` |
| `map_name` | string | yes | Non-empty. Must match a map name the headset BP knows how to load. |

### 3. Training Intervention (Trigger Event)

```json
{ "command": "trigger_event", "event_type": "fire_alarm" }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `command` | string | yes | Must be `"trigger_event"` |
| `event_type` | string | yes | Non-empty. Free-form identifier interpreted by the BP `Event Dispatcher` table. |

### 4. User Reset

```json
{ "command": "reset_user_position" }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `command` | string | yes | Must be `"reset_user_position"` |

No additional fields. The headset teleports the player back to the level's `PlayerStart`.

## Validation rules

- **Server side** (`src/commands.js`):
  - Rejects payloads where `command` is missing or not a string.
  - Rejects payloads with an `unknown command` value (drops + logs; never forwards).
  - Rejects per-command field shape mismatches (logged; `ack` returns the error).
  - Rejects commands from a non-instructor socket (defence against a hijacked headset socket).
  - Rejects commands when no headset is currently connected to the same pairing code.
- **Headset side** (BP): also ignores anything it doesn't recognise (defence in depth, per `.cursorrules §5.2` — *"unknown commands MUST be ignored by the headset and logged by the server"*).

## Extending

Additive only. To add a new command:

1. Add a per-field validator to `COMMAND_VALIDATORS` in `Web_Dashboard/src/commands.js`.
2. Add a section to this document with the same table shape.
3. Implement the headset handler in BP.
4. Add the dispatch UI to the instructor dashboard (Phase 5).

Never silently break an existing command's shape — bump a `v2` command name and accept both during a deprecation window if a breaking change is unavoidable.
