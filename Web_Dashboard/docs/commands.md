# Canonical command schema — Instructor → Headset

This document is the source of truth for the JSON command payloads that flow
from the instructor browser through the Socket.IO signaling server to the
Quest/Pico headset. It mirrors `.cursorrules §5.2` and is enforced
server-side by `Web_Dashboard/src/commands.js`.

The inverse direction (headset publishing state to the dashboard, e.g.
"I'm in the hub, here are the available levels") is documented in
[`state-updates.md`](./state-updates.md). Together they form the per-app
interactive control plane added 2026-06-15.

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

## App-specific commands

The four commands above are **app-agnostic** — any VR app should respond to
them sensibly (pause is pause; reset is reset). Beyond that, each VR app
defines its own command vocabulary scoped to its `appId` (declared on
`headset:register` — see [`state-updates.md`](./state-updates.md#application-identity)).
Server validates app-specific commands against the room's `appId`: a `VRFT`
command sent to a `VRForklift` session is rejected as unknown for that app.

App-specific validators live in `Web_Dashboard/src/commands.js` under
`APP_COMMAND_VALIDATORS[appId]`. The forwarding handler looks up the room's
`appId`, checks the app-scoped table first, then falls back to the global
`COMMAND_VALIDATORS`. A command with no validator in either table is
rejected (defence against typos + unknown commands per `.cursorrules §5.2`).

### `appId: "VRFT"` (VR Fire Training)

Mirror of the VRFT state machine documented in [`state-updates.md`](./state-updates.md#appid-vrft-vr-fire-training).

#### `load_level`

```json
{ "command": "load_level", "level_id": "kitchen_fire" }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `command` | string | yes | Must be `"load_level"` |
| `level_id` | string | yes | Non-empty. Must match one of the `id` values the headset most recently published under `data.available_levels` in its `hub` state-update. The dashboard's `apps/VRFT.js` module enforces this client-side by only rendering buttons for currently-published levels; the server enforces shape only (the headset BP is responsible for rejecting unknown level IDs as a last line of defence). |

Valid in states: `hub`, `level_complete`. The headset transitions to
`level_loading`, then `level_active` once the map finishes loading and
publishes corresponding state-updates.

#### `return_to_hub`

```json
{ "command": "return_to_hub" }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `command` | string | yes | Must be `"return_to_hub"` |

No additional fields. Valid in states: `level_active`, `level_complete`. The
headset unloads the current level and transitions back to `hub`.

## Validation rules

- **Server side** (`src/commands.js`):
  - Rejects payloads where `command` is missing or not a string.
  - Rejects payloads with an `unknown command` value (drops + logs; never forwards).
  - Rejects per-command field shape mismatches (logged; `ack` returns the error).
  - Rejects commands from a non-instructor socket (defence against a hijacked headset socket).
  - Rejects commands when no headset is currently connected to the same pairing code.
- **Headset side** (BP): also ignores anything it doesn't recognise (defence in depth, per `.cursorrules §5.2` — *"unknown commands MUST be ignored by the headset and logged by the server"*).

## Extending

Additive only. To add a new app-agnostic command:

1. Add a per-field validator to `COMMAND_VALIDATORS` in `Web_Dashboard/src/commands.js`.
2. Add a section to this document with the same table shape.
3. Implement the headset handler in BP.
4. Add the dispatch UI to the instructor dashboard.

To add a new command for a specific VR app:

1. Add a per-field validator to `APP_COMMAND_VALIDATORS[<appId>]` in `Web_Dashboard/src/commands.js`.
2. Add a row to the corresponding `### appId: "X"` subsection of this document.
3. Update the per-app dashboard module at `Web_Dashboard/public/js/apps/<appId>.js` to render the dispatch UI for the new command.
4. Implement the headset handler in BP/C++ for that VR app.

To add a new VR app entirely:

1. Add a new `### appId: "<NewAppId>"` subsection here, with one `####` block per command.
2. Add the corresponding `APP_COMMAND_VALIDATORS[<NewAppId>]` entry to `Web_Dashboard/src/commands.js`.
3. Add the state-machine documentation to [`state-updates.md`](./state-updates.md#per-app-state-machine-conventions).
4. Write the per-app dashboard module at `Web_Dashboard/public/js/apps/<NewAppId>.js`.
5. Implement the VR-side state publication + command handling in the new project.

Never silently break an existing command's shape — bump a `v2` command name and accept both during a deprecation window if a breaking change is unavoidable.
