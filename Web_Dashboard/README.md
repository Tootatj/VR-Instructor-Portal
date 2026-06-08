# Web Dashboard — VR Instructor Portal

Signaling server, Agora token minter, and instructor SPA for the
VR Instructor Portal. Per `.cursorrules` §3 / §4.3 / §4.3.1 / §5.

> **Scope of this README:** local development setup, the full API + Socket.IO surface table, and end-to-end smoke tests. Read this first — every other doc assumes you've validated the system locally.
>
> **Deploying to a public domain?** This README does not cover that. See [`../HowToDeploy.md`](../HowToDeploy.md) for the recipe-style guide covering TLS, reverse proxies, hosting options (PaaS / VPS / portal-embedded), the production-required hardening checklist, and the integration contract with the VR developer.

## Layout on disk

```
Web_Dashboard/
├── README.md
├── package.json              # Node 20+, ESM, no build step
├── .env.example              # copy to .env (gitignored) and fill in
├── server.js                 # Express + Socket.IO entry — kept thin
├── src/
│   ├── agora.js              # token minter + canonical channel naming
│   ├── auth.js               # signed-cookie instructor sessions (Phase 6)
│   ├── tenants.js            # tenant-code lookup; stub for OneBonsai portal (Phase 6)
│   ├── pairing.js            # 4-digit code registry + session lifecycle
│   └── commands.js           # §5.2 command schema validation + relay
├── data/
│   └── tenant-codes.json     # static tenant registry; replace with portal HTTP call later
├── scripts/
│   └── smoke-phase6.ps1      # end-to-end smoke test for Phase 6 endpoints
├── docs/
│   └── commands.md           # canonical instructor → headset command schema
└── public/                   # static assets — works without the server too
    ├── index.html            # OneBonsai grid view (Phase 4.5, auth-gated since Phase 6)
    ├── login.html            # instructor login screen (Phase 6)
    ├── single.html           # legacy single-session debug view (Step 1.5)
    ├── faker.html            # synthetic VR sessions for testing
    ├── css/
    │   ├── tokens.css
    │   └── style.css
    └── js/
        ├── grid.js           # multi-session grid client (index.html)
        ├── login.js          # login form handler (login.html)
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
   - `DEFAULT_TENANT_ID` — used by the unauthenticated faker tool (the
     dashboard itself gets its tenant from the instructor's session cookie).
     Leave at `onebonsai` for the dogfooding demo.
   - `INSTRUCTOR_SESSION_SECRET` — 32+ char random for HMAC-signing the
     `vrip_instructor` cookie. If unset, the server generates a per-process
     ephemeral secret (sessions die on restart — fine for dev, never prod).
     Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

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
2. **Open the grid**: `http://localhost:3000` → redirected to
   `/login.html`. Type `0000000000` (OneBonsai demo tenant) + your
   name → land on the dashboard. Header shows
   `OneBonsai (Demo) · <YourName>` + Sign Out.
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

**Multi-tenant smoke test:** Sign out, sign back in with code
`5555555555` (Securitas). The grid is empty — the fakers from step 3
are in the `onebonsai` tenant and correctly hidden. Try URL-tampering
by hitting `http://localhost:3000/api/sessions?tenantId=onebonsai`
directly: the response still reports `"tenantId":"securitas"` (cookie
wins, URL param ignored). That's the tenant isolation.

For full Phase 6 endpoint coverage, run `scripts/smoke-phase6.ps1`
against a running server.

To get a real Quest into the grid, see
[`Devlog.md` §2026-06-03 multi-session BP wiring](../Devlog.md) for the
per-device channel rename recipe.

## API + Socket.IO surface

| Surface | Direction | Auth | Purpose |
|---|---|---|---|
| `GET /api/health` | any → server | none | Liveness probe. Returns `{ ok, uptime }`. |
| `GET /api/config` | client → server | none | Safe-to-expose client config: `{ appId, defaultTenantId }`. Used by the faker. |
| `POST /api/tenant/resolve` | VR → server | none (code IS the credential) | First-launch VR registration. Body: `{ code }` → `{ tenantId, displayName }` or 401. **Phase 6**. |
| `POST /api/instructor/login` | browser → server | none | Body: `{ code, displayName? }`. Sets `vrip_instructor` cookie. **Phase 6**. |
| `POST /api/instructor/logout` | browser → server | none | Clears cookie. **Phase 6**. |
| `GET /api/instructor/me` | browser → server | cookie | Returns logged-in instructor `{ tenantId, tenantDisplayName, instructorName, issuedAt }`. **Phase 6**. |
| `GET /api/sessions?page=N&pageSize=M` | browser → server | **cookie** | Paginated active sessions; tenant taken from cookie (URL query removed in Phase 6 for security). |
| `POST /api/token` | client → server | none | Mints a short-lived RTC token. Body: `{ code, role, uid? }`. Requires the pairing code to already be registered by a headset (no rando minting). |
| `GET /` | browser → server | cookie | 302 → `/login.html` if no session. **Phase 6**. |
| Socket.IO `headset:register` | headset → server | none (tenantId must be a known tenant) | Headset (or faker) claims a 4-digit code. Payload: `{ code, tenantId, scenario?, traineeName?, source? }`. Phase 6: rejects unknown tenantIds. |
| Socket.IO `headset:end` | headset → server | room ownership | Graceful shutdown from the owning headset. Payload: `{ code }`. Server prunes the room immediately instead of waiting on the ~30 s disconnect timeout. |
| Socket.IO `instructor:subscribe-tenant` | instructor → server | **cookie** | Grid-view subscription. Payload is ignored as of Phase 6 — tenantId taken from cookie. Acks with `{ ok, tenantId, sessions }`. |
| Socket.IO `instructor:join` | instructor → server | none | Legacy 1:1 pairing for single-session debug view. Payload: `{ code }`. |
| Socket.IO `instructor:command` | instructor → server | role=instructor + same-tenant | Dispatch a §5.2 command. Payload includes `code` to target a specific session. Validated server-side. |
| Socket.IO `headset:command` | server → headset | — | Validated command relayed to the headset socket. |
| Socket.IO `session:status` | server → both peers in a code | — | Broadcast `{ state: 'waiting' \| 'connected' \| 'reconnecting' \| 'ended' }`. |
| Socket.IO `sessions:changed` | server → instructor sockets | — | Tenant-scoped broadcast: full updated session list. Fires on headset register/disconnect/end. |

See `docs/commands.md` for the canonical command schema enforced by
`src/commands.js`.

## Real headset wiring

As of Phase 4 (`USignalingSubsystem`), the Quest build registers with the
dashboard at launch and fetches server-minted Agora credentials at
runtime. No more hardcoded channels or 24-hour tokens in `BP_VRPawn`.

The UE-side wire-protocol sequence on cold launch:

1. Quest boots → `USignalingSubsystem::Initialize` generates a random
   4-digit pairing code and connects to `ServerUrl` (read from
   `VR_Project/Config/DefaultGame.ini` section
   `[/Script/VR_Project.SignalingSubsystem]`).
2. Emits `headset:register` with `{ code, tenantId, scenario,
   traineeName, source:"headset" }` + ack callback.
3. On ack `ok`, POSTs `/api/token` for `{ code, role:"publisher", uid:0 }`.
4. Stores returned `appId`, `token`, `channel`, `expiresAt` and fires
   the `OnCredentialsReady` BP delegate. `BP_VRPawn::BeginPlay` is
   gated behind that delegate and consumes the values via subsystem
   variable reads (no literal pins).
5. Schedules a `RefreshToken` ~5 minutes before `expiresAt` and
   re-emits `headset:register` automatically on socket reconnect with
   the SAME pairing code (hot reconnect recall).
6. On `Deinitialize` (clean app exit), fires `headset:end` so the grid
   tile disappears immediately.

See `VR_Project/Plugins/README.md` for the plugin pin (getnamo
SocketIOClient-Unreal v2.9.0) and `Devlog.md` for per-phase notes.

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
