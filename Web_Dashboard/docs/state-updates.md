# Canonical state-update schema — Headset → Instructor

This document is the source of truth for the JSON state payloads that flow
from the Quest/Pico headset through the Socket.IO signaling server to every
instructor browser currently subscribed to the headset's tenant. It is the
mirror image of [`commands.md`](./commands.md) (which goes the other way).

Together, commands + state-updates form the **per-app interactive control
plane** introduced 2026-06-15. Each VR application (e.g. "VRFT" for VR Fire
Training, "VRForklift" for forklift training) declares its identity at
registration, then publishes state transitions as it runs; the dashboard
loads a per-app UI module (`Web_Dashboard/public/js/apps/<appId>.js`) that
renders those states into a focused instructor panel and emits app-specific
commands back.

## Transport

- **Wire format:** JSON only (per `.cursorrules §1.2`).
- **Field naming:** `snake_case` (per `.cursorrules §5.2`).
- **Direction:** Headset BP → Socket.IO server → all subscribed instructor browsers.
- **Headset → server event:** `headset:state-update`, payload = the JSON below, with an optional Socket.IO `ack` callback that returns `{ ok: boolean, error?: string }`. The ack is cheap diagnostics — the headset MUST treat state-update emission as fire-and-forget.
- **Server → instructor event:** `session:state-changed`, payload = `{ code, tenantId, appId, state, data, updatedAt }`. Fanned out to every socket joined to the tenant's instructor room, plus the legacy 1:1 instructor pinned to the same code (if any).
- **Server-side cache:** the last state is stored in the `ROOMS` map for that code; newly-connecting instructors receive it as part of `instructor:subscribe-tenant`'s `sessions[]` response, so the focus view renders correctly without waiting for the next state-update tick.

## Application identity

Every headset that wants per-app UI MUST declare its `appId` (and, optionally,
its `appVersion`) in the `headset:register` payload. The server stores both
on the room and includes them in every `sessions:changed` broadcast and
`session:state-changed` event.

```json
{
  "code": "5981",
  "tenantId": "onebonsai",
  "scenario": "Fire Training",
  "traineeName": "Quest Trainee",
  "source": "headset",
  "appId": "VRFT",
  "appVersion": "1.0.0"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `appId` | string | **strongly recommended** | Stable, app-wide identifier. Matches `/^[A-Za-z][A-Za-z0-9_-]{0,31}$/`. The dashboard uses this to pick the per-app UI module: a headset that registers with `appId: "VRFT"` causes the focus view to dynamic-import `apps/VRFT.js`. Headsets that omit `appId` get a **generic fallback panel** (just video, no app-specific UI) — safe but uninteractive. |
| `appVersion` | string | optional | Free-form. Useful when one VR app evolves its state machine + commands across versions; a future per-app module can branch on this. Truncated server-side to 32 chars. |

Existing pre-2026-06-15 VR builds without `appId` continue to register cleanly —
they just don't get an app-specific panel. This is the same backward-compat
shape the `scenario` and `traineeName` fields had when they were introduced.

## Schema

Every state update is a JSON object with three required fields and an
optional fourth:

```json
{
  "code": "5981",
  "state": "hub",
  "data": { "available_levels": [
    { "id": "kitchen_fire",    "display_name": "Kitchen Fire" },
    { "id": "electrical_fire", "display_name": "Electrical Fire" },
    { "id": "warehouse_fire",  "display_name": "Warehouse Fire" }
  ]}
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `code` | string | yes | The 4-digit pairing code the headset registered with. Server validates: must match the socket's currently-bound code (a headset can't push state for someone else's room). |
| `state` | string | yes | Free-form per-app state-machine label. Matches `/^[a-z][a-z0-9_]{0,63}$/` (lowercase snake_case). The per-app module knows what state names to expect. |
| `data` | object | no | App-specific state payload. Schema is owned by the per-app module — server does not validate the shape. Max 8 KB serialised (server rejects larger payloads to bound `ROOMS`-map memory growth). |
| `seq` | integer | no | Optional monotonic sequence number per session. If present, server uses it to drop out-of-order updates (network reordering); if absent, last-write-wins. |

### Per-app state-machine conventions

Each `appId` defines its own state machine. The dashboard's per-app module is
the source of truth for "what states exist" and "what data shape goes with
each". This doc captures the conventions for shipping apps:

#### `appId: "VRFT"` (VR Fire Training)

States published by the headset, ordered by typical lifecycle:

| State | Meaning | `data` shape (illustrative) |
|---|---|---|
| `boot` | App is initialising; no level loaded. Brief. | `{}` |
| `hub` | User is in the central hub menu. Available levels published so instructor can pick one. | `{ "available_levels": [{ "id": "...", "display_name": "..." }, ...] }` |
| `level_loading` | A level is being loaded (transition state). | `{ "level_id": "kitchen_fire" }` |
| `level_active` | User is in the named level, actively training. May be updated periodically with progress metadata (elapsed, current_step, etc.). | `{ "level_id": "kitchen_fire", "level_display_name": "Kitchen Fire", "elapsed_seconds": 47, "current_step": "approach_fire" }` |
| `level_complete` | Level finished (success or fail). Brief, before returning to hub. | `{ "level_id": "kitchen_fire", "outcome": "passed" \| "failed", "elapsed_seconds": 312 }` |

Commands accepted by VRFT in response (full schema in [`commands.md`](./commands.md)):

- `load_level { level_id: string }` — valid in `hub` and `level_complete` states.
- `return_to_hub {}` — valid in `level_active` and `level_complete` states.

## Validation rules

- **Server side** (`src/pairing.js::headset:state-update`):
  - Rejects payloads where `code` is missing, not a string, or doesn't match the socket's currently-bound code (the headset MUST own the session it's updating; defence against a hijacked socket trying to push state for another room).
  - Rejects payloads where `state` is missing, not a string, or doesn't match `/^[a-z][a-z0-9_]{0,63}$/`.
  - Rejects payloads where `data` is present but not a plain object, or serialises to more than 8 KB.
  - Rejects payloads from a socket that hasn't registered (no `socket.data.code`).
  - Rate-limits: max 10 state-updates per second per code, with a burst of 30 (sliding window). Excess updates are dropped silently — the headset is expected to debounce on its side; this is a server-side safety net, not the primary contract.
- **Headset side** (BP / C++): the headset should batch state changes — emit once per real state transition, not once per tick. The rate limit above is intentionally generous so legitimate bursts (e.g. several rapid transitions during a level-load sequence) don't get dropped, but a malformed BP graph that ticks every frame WILL get throttled and will lose updates.

## Extending

Additive only. To add a new VR app:

1. Pick a stable `appId` (e.g. `"VRForklift"`). Document the state machine + command list in a new `## appId: "VRForklift"` subsection of this doc.
2. Add per-app command validators to `Web_Dashboard/src/commands.js`'s `APP_COMMAND_VALIDATORS` map (see [`commands.md`](./commands.md#app-specific-commands)).
3. Write the per-app dashboard module at `Web_Dashboard/public/js/apps/VRForklift.js` (the focus view loads it via `import()` when a headset of that `appId` registers). Module API is documented in `Web_Dashboard/public/js/apps/README.md`.
4. Implement the state-update emissions + command handlers in the VR app's BP / C++.

To add a new state to an existing app:

1. Update the app's subsection in this doc with the new state row + `data` shape.
2. Update the per-app module to render the new state.
3. Implement the emission in the VR app.

Never silently break an existing state's `data` shape — the per-app module
should branch on `data.schema_version` if a breaking change is unavoidable.

## See also

- [`commands.md`](./commands.md) — the inverse direction (instructor → headset commands).
- `Web_Dashboard/public/js/apps/README.md` — per-app module conventions and helper API surface.
- `.cursorrules §5.2` — the parent wire-protocol convention this doc materialises.
- `HowToPort.md` — the BP-callable + delegate surface a target VR project consumes.
