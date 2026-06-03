# Web Dashboard — VR Instructor Portal

Signaling server, Agora token minter, and instructor SPA for the
VR Instructor Portal. Per `.cursorrules` §3 / §4.3 / §4.3.1 / §5.

## Layout on disk

```
Web_Dashboard/
├── README.md
├── package.json              # Node 20+, ESM, no build step
├── .env.example              # copy to .env (gitignored) and fill in
├── server.js                 # Express + Socket.IO entry — kept thin
├── src/
│   ├── agora.js              # token minter + canonical channel naming
│   ├── pairing.js            # 4-digit code registry + session lifecycle
│   └── commands.js           # §5.2 command schema validation + relay
├── docs/
│   └── commands.md           # canonical instructor → headset command schema
└── public/                   # static assets — works without the server too
    ├── index.html            # OneBonsai grid view (Phase 4.5)
    ├── single.html           # legacy single-session debug view (Step 1.5)
    ├── faker.html            # synthetic VR sessions for testing
    ├── css/
    │   ├── tokens.css
    │   └── style.css
    └── js/
        ├── grid.js           # multi-session grid client (index.html)
        ├── single.js         # single-session client (single.html)
        └── faker.js          # canvas-published faker (faker.html)
```

## Three pages, three purposes

| Page | Purpose | Needs server? |
|---|---|---|
| `/` (`index.html`) | OneBonsai grid view — 3×2 tiles of live sessions per tenant, click to expand into focus mode with the §5.2 command deck. The product. | **Yes** |
| `/single.html` | Legacy single-session debug view from Step 1.5. Useful as a known-good fallback when poking the receive path. | No (Mode A) |
| `/faker.html` | Synthetic VR sessions for testing the grid without N physical headsets. Canvas-published video, no webcam permission needed. Spawn many via `/faker.html?spawn=N`. | **Yes** |

## One-time setup

1. Install Node.js 20 or newer.
2. Install deps (from `Web_Dashboard/`):
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` and fill in:
   - `AGORA_APP_ID` — from <https://console.agora.io> > Project Management.
   - `AGORA_APP_CERTIFICATE` — same page, "primary certificate". Hard secret.
   - `AGORA_TOKEN_TTL_SECONDS` — leave at the default (1800 = 30 min).
   - `PORT` — HTTP port (default 3000).
   - `DEFAULT_TENANT_ID` — set to `onebonsai` for the dogfooding demo.

## Run

```bash
npm run dev            # node --watch — auto-restarts on file change
# or
npm start              # production-style: one boot, no hot reload
```

Open `http://localhost:3000`. The grid view loads, empty until something
registers. Click **Spawn demo sessions** in the header (or open
`/faker.html?spawn=5` directly) to populate it.

## Test the OneBonsai grid end-to-end (~2 minutes)

1. **Start the server**: `npm run dev`.
2. **Open the grid**: `http://localhost:3000`. Header should show
   `Live · tenant onebonsai`.
3. **Spawn fakers**: click the "Spawn demo sessions" button in the
   header → 5 popup windows open, each registers a synthetic session
   and starts publishing a canvas video. Within ~2 seconds the grid
   populates with 5 tiles ("Fire Training — Trainee 47", etc.).
4. **Click a tile**: the grid hides, the chosen tile fills the stage,
   the right-hand command deck appears.
5. **Send a command**: click **Pause simulation**. The faker overlays
   a yellow "PAUSE" badge for 2.5 seconds, then a sticky "PAUSED"
   black overlay. **Resume simulation** clears it.
6. **Back to grid**: click `‹ Back to grid` → the focused tile tears
   down and the grid re-subscribes to the current page.

To get a real Quest into the grid, see
[`Devlog.md` §2026-06-03 multi-session BP wiring](../Devlog.md) for the
per-device channel rename recipe.

## API + Socket.IO surface

| Surface | Direction | Purpose |
|---|---|---|
| `GET /api/health` | any → server | Liveness probe. Returns `{ ok, uptime }`. |
| `GET /api/config` | client → server | Safe-to-expose client config: `{ appId, defaultTenantId }`. |
| `GET /api/sessions?tenantId=X&page=N&pageSize=M` | client → server | Paginated list of active sessions for a tenant. |
| `POST /api/token` | client → server | Mints a short-lived RTC token. Body: `{ code, role, uid? }`. Requires the pairing code to already be registered by a headset (no rando minting). |
| Socket.IO `headset:register` | headset → server | Headset (or faker) claims a 4-digit code. Payload: `{ code, tenantId, scenario?, traineeName?, source? }`. |
| Socket.IO `instructor:subscribe-tenant` | instructor → server | Grid-view subscription: receive all sessions for a tenant + live `sessions:changed` updates. Payload: `{ tenantId }`, acks with the initial session list. |
| Socket.IO `instructor:join` | instructor → server | Legacy 1:1 pairing for single-session debug view. Payload: `{ code }`. |
| Socket.IO `instructor:command` | instructor → server | Dispatch a §5.2 command. Payload includes `code` to target a specific session in the grid view. Validated server-side. |
| Socket.IO `headset:command` | server → headset | Validated command relayed to the headset socket. |
| Socket.IO `session:status` | server → both peers in a code | Broadcast `{ state: 'waiting' \| 'connected' \| 'reconnecting' }`. |
| Socket.IO `sessions:changed` | server → instructor sockets | Tenant-scoped broadcast: full updated session list. Fires on headset register/disconnect. |

See `docs/commands.md` for the canonical command schema enforced by
`src/commands.js`.

## Real headset wiring (still pending)

The Quest / Pico builds currently bake an Agora App ID + a 24-hour
temporary token + a hardcoded channel name into `BP_VRPawn`. To put
real headsets on the OneBonsai grid alongside the fakers:

| Option | Effort | What it gets you |
|---|---|---|
| **Q1 — Per-device channel rename** | ~10 min per device | Build the APK once per device with the channel renamed to `t-onebonsai-XXXX` and a matching temp token. Quick demo path. |
| **Q2 — UE Socket.IO subsystem** | 1–2 sessions | Install a UE Socket.IO plugin, scaffold `USignalingSubsystem` that emits `headset:register` + fetches tokens from `/api/token` at launch. Architectural endpoint. |

See `Devlog.md` for the click-paths and shell commands.

## Conventions

- **ESM only** (`"type": "module"`, `import`/`export`).
- **No build step** for the client — vanilla JS + CSS served as-is.
- **No secrets in client code.** Even `AGORA_APP_ID`, which is technically
  safe to expose, is kept server-side so rotation is one place.
- **All Socket.IO payloads are JSON-validated server-side** before any
  forwarding (per `.cursorrules §4.3`).
- **Per-channel token binding only.** Reusing a token across channel names
  crashes the Agora native SDK with an `ACCESS_VIOLATION` deep in libaosl
  (see `Devlog.md` 2026-06-01 Phase 2 entry).
