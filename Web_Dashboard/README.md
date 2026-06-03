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
    ├── index.html
    ├── css/
    │   ├── tokens.css
    │   └── style.css
    └── js/
        └── main.js
```

## Two operating modes

### Mode A — Static MVP (Step 1, working today)

The minimum-viable self-hosted replacement for the Agora basic video call
demo. No Node, no token minting, no pairing — just serve `public/` as
static files and paste credentials into the on-page form.

```bash
# From the repo root
npx serve Web_Dashboard/public
# or
python -m http.server 8000 --directory Web_Dashboard/public
```

Open the printed URL, paste the same `appId`, `channel`, and 24-hour
temporary token that are currently baked into `BP_VRPawn`, click **Join**.
The trainee POV appears as soon as the headset publishes its first frame.

### Mode B — Phase 4 server (this commit, scaffolded but not yet wired into the SPA)

The real architecture: Express + Socket.IO + server-minted short-lived
tokens + 4-digit code pairing. The SPA is **not yet** wired to call this
server — that's the next discrete unit of work after Quest verification.

#### One-time setup

1. Install Node.js 20 or newer.
2. Install deps:
   ```bash
   # From Web_Dashboard/
   npm install
   ```
3. Copy `.env.example` to `.env` and fill in:
   - `AGORA_APP_ID` — from <https://console.agora.io> > Project Management.
   - `AGORA_APP_CERTIFICATE` — same page, "primary certificate". This is a
     hard secret; never expose to the client.
   - `AGORA_TOKEN_TTL_SECONDS` — leave at the default (1800 = 30 min) unless
     you have a specific reason to change it.
   - `PORT` — HTTP port for Express + Socket.IO (default 3000).
   - `DEFAULT_TENANT_ID` — leave as `default` for v1.

#### Run

```bash
# From Web_Dashboard/
npm start              # production-style: one boot, no hot reload
# or
npm run dev            # node --watch — auto-restarts on file change
```

The server logs the listen URL, the static assets directory, and whether
Agora creds are wired up. Open the listen URL — the existing static SPA
(Mode A) is served from `/`, plus the server adds:

| Surface | Direction | Purpose |
|---|---|---|
| `POST /api/token` | client → server | Mints a short-lived RTC token. Body: `{ code, role, uid? }`. Requires the pairing code to already be registered by a headset (no rando minting). |
| `GET /api/health` | any → server | Liveness probe. Returns `{ ok, uptime }`. |
| Socket.IO `headset:register` | headset → server | Headset claims a 4-digit pairing code. Payload `{ code, tenantId? }`. |
| Socket.IO `instructor:join` | instructor → server | Instructor enters the 4-digit code. Payload `{ code }`. |
| Socket.IO `session:status` | server → both peers | Broadcast `{ state: 'waiting' \| 'connected' \| 'reconnecting' }`. |
| Socket.IO `instructor:command` | instructor → server | Dispatch a §5.2 command. Validated server-side. |
| Socket.IO `headset:command` | server → headset | Validated command relayed to the headset socket. |

See `docs/commands.md` for the canonical command schema enforced by
`src/commands.js`.

## What's still missing (intentionally, for separate commits)

| Item | Why deferred |
|---|---|
| **SPA wiring to the server** — replace the manual `token` field with a `code` field, call `POST /api/token` after `instructor:join`, then join Agora. | Kept as a separate change so the Mode A MVP keeps working independently of server availability during the transition. |
| **Headset wiring to the server** — UE Socket.IO plugin install + a `USignalingSubsystem` (UGameInstanceSubsystem) wrapping `headset:register` + token fetch + `headset:command` dispatch. | Pulls in a third-party UE plugin and a new C++ subsystem; deserves its own dedicated session per `.cursorrules §4.2`. |
| **Phase 5 instructor command deck** — replace the connection form in the right panel with the four §5.2 command controls. | Depends on the SPA wiring above. |

## Conventions

- **ESM only** (`"type": "module"`, `import`/`export`).
- **No build step** for the client — vanilla JS + CSS served as-is. The
  server (`server.js`) and modules under `src/` are plain Node ESM.
- **No secrets in client code.** Even `AGORA_APP_ID`, which is technically
  safe to expose, is kept server-side so rotation is one place.
- **All Socket.IO payloads are JSON-validated server-side** before any
  forwarding (per `.cursorrules §4.3`).
- **Per-channel token binding only.** Reusing a token across channel names
  crashes the Agora native SDK with an `ACCESS_VIOLATION` deep in libaosl
  (see `Devlog.md` 2026-06-01 Phase 2 entry — the lesson that motivates
  the always-mint-per-channel rule in `src/agora.js`).
