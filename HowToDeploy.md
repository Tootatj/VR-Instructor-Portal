# How to Deploy the VR Instructor Portal Web Stack to a Public Domain

> **Last verified against:** Node.js 20+ · Express 5 · Socket.IO 4 · `Web_Dashboard/`
> git rev `<this commit>` (Phase 6D + 2026-06-08 closeout)
>
> **Maintainer rule:** every time `Web_Dashboard/server.js`, `src/auth.js`,
> `src/tenants.js`, `src/pairing.js`, `.env.example`, or the deployable
> surface area otherwise changes, update the matching section below in
> the same commit. Add a row to the bottom of the *Change log* at the end
> of this file with the date + commit hash + one-line "what changed".

This guide is for the **web developer** standing up the signaling
server + instructor dashboard on a real public domain (staging or
production). Its counterpart is [`HowToPort.md`](HowToPort.md), which is
for the **VR developer** reusing the same signaling layer inside a
different Unreal Engine 5.5+ training app. Together the two docs are
the full handoff package.

The local-dev story is already covered by [`Web_Dashboard/README.md`](Web_Dashboard/README.md)
(install Node, copy `.env.example`, `npm run dev`, open
`http://localhost:3000`). **This doc is exclusively about going from
"runs on my laptop" to "runs at a URL that customers reach over the
internet."** If you haven't run the dashboard locally end-to-end yet
including the 2-minute smoke test in that README, do that first — every
recipe below assumes you've validated the system locally before
exposing it to the internet.

---

## TL;DR — what changes vs running locally

| Concern | Local dev | Production |
|---|---|---|
| Transport | `http://localhost:3000` / `ws://` | `https://signaling.yourdomain.com` / `wss://` (TLS terminated by a reverse proxy) |
| Process supervisor | `npm run dev` in a terminal you watch | systemd / PM2 / container runtime — restarts on crash, survives reboot |
| CORS | `origin: true` (permissive — see `server.js` line ~239 + comment) | Lock to the actual dashboard origin; reject anything else |
| Session secret | Per-process ephemeral if `INSTRUCTOR_SESSION_SECRET` unset (sessions die on restart — fine for dev) | **Real 32-byte hex from `crypto.randomBytes(32)`**, in real secret storage. Sessions must survive restarts. |
| Cookie `Secure` flag | Off (HTTP) — auto-detected by `auth.js::buildCookieAttrs()` via the `isHttps` check | **On automatically** once requests come in over HTTPS. The cookie code is already correct — you just need to deploy behind TLS *and* set `app.set('trust proxy', 1)` so `req.protocol` reflects the original scheme through the reverse proxy. |
| Agora secrets | `.env` on dev box | Hosting provider's env-var UI / AWS Secrets Manager / Doppler / 1Password Secrets |
| Tenant codes | `data/tenant-codes.json` on dev box | Same file, but on a server you back up. Long-term: integrate with OneBonsai's portal API (`tenants.js::resolveByCode()` is the single seam). |
| Rate limiting | None | Add `express-rate-limit` on `/api/instructor/login` and `/api/orgs/redeem` (~10 attempts / IP / 15 min is the standard baseline) |
| Logging | `console.log` to your terminal | Structured logger (`pino`) → log aggregator OR `journalctl` if on systemd |
| Health check | None needed | `GET /health` for the load balancer / uptime monitor |
| Update workflow | Save file, `node --watch` restarts | `git pull` + `npm install` + restart systemd unit, OR push to PaaS and let it redeploy |
| VR side `ServerUrl` | `http://<your-lan-ip>:3000` baked into the APK | `https://signaling.yourdomain.com` baked into the APK — **requires a re-cook**, see *Integration touchpoint* section below |

**None of this requires changing the wire protocol, the auth model, the
multi-tenant isolation, or any business logic.** It is purely
infrastructure plus a handful of small config tweaks. The system was
designed for this move — see Phase 6 backlog items in
[`Devlog.md`](Devlog.md) for the original "must happen before any
internet-facing deploy" notes that this doc is now operationalizing.

## Effort estimates

| Recipe | Target state | Estimated effort | When it's the right choice |
|---|---|---|---|
| **A.** Standalone subdomain on managed PaaS (Fly.io / Railway / Render) | `signaling.yourdomain.com` | ~half day | Fastest path to a working staging deployment. Right answer if you don't already have OneBonsai cloud infra to share with, or if you want to minimize ops surface. |
| **B.** Standalone subdomain on a VPS (Hetzner / DigitalOcean / Linode) | `signaling.yourdomain.com` | ~half day | Same outcome as A but you own the box. Right when OneBonsai has existing VPS-based infra you should slot into, or when long-term cost matters (€5/mo VPS vs $20+/mo PaaS at scale). |
| **C.** Subpath-embedded inside OneBonsai portal | `portal.onebonsai.com/instructor/` | ~1-2 days, requires coordination with portal team | Right long-term answer for production integration. Shared auth, single nav, but more wiring with the existing portal codebase. |
| **D.** Hardening checklist (recipe-agnostic) | Adds the 8 production-required tweaks to whichever recipe above | ~2-3 hours | **Mandatory before any internet-facing exposure** regardless of which recipe you picked. Most line items are 1-2 line additions; the bulk of the time is testing. |

A typical "Phase 1 production" plan is **Recipe A or B + Recipe D** ≈ one day end-to-end including the VR side re-cook + smoke test.

A typical "Phase 2 production" plan moves from A/B → C once OneBonsai's portal team is ready to take the embedding.

---

## Recipe A — Standalone subdomain on managed PaaS (~half day)

The fastest path. Picks Fly.io for the examples below because it has
first-class Socket.IO support (multi-region sticky sessions out of the
box, no extra config). Railway / Render / Heroku work equivalently
with minor command differences.

### A.1. Pre-flight (what you need before starting)

| Item | Where it comes from |
|---|---|
| Domain or subdomain you control DNS for | OneBonsai's DNS provider (likely Cloudflare or whoever OneBonsai uses) |
| Agora App ID + App Certificate | <https://console.agora.io> → Project Management. Either reuse the dev creds from `.env` or mint a fresh "Production" project (recommended — keeps test traffic from billing against prod). |
| Fly.io account + `flyctl` CLI installed | <https://fly.io/docs/hands-on/install-flyctl/> |
| Hex-encoded 32-byte random for `INSTRUCTOR_SESSION_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` — generate once, store securely, never commit |
| The 4 tenant codes already in `data/tenant-codes.json` decided final, OR a plan to manage tenant codes server-side post-deploy | If staging-only, copy `data/tenant-codes.json` as-is. If production, decide whether to scrub the demo entries before going live. |

### A.2. DNS

1. Decide the URL pattern. Default trajectory: `signaling.yourdomain.com` for the API + dashboard, served from the same origin (the dashboard is just static assets from `Web_Dashboard/public/` plus the same Express app — there's no split between "API" and "frontend").
2. Don't create the DNS record yet — Fly.io will give you a target hostname to CNAME to in step A.4.

### A.3. Repo prep

The repository is currently structured around the assumption that
`Web_Dashboard/` is a peer of `VR_Project/`. Fly.io wants to deploy
from a directory containing a `Dockerfile` or auto-detect a Node app.
Two options:

- **(preferred)** Deploy directly from the `Web_Dashboard/` subdirectory using `flyctl launch --no-deploy --copy-config` from inside `Web_Dashboard/`. Fly auto-detects the `package.json`, generates a `Dockerfile`, and only ships that subtree to its builders. Keeps the VR project's `VR_Project/Binaries/` and similar build artefacts out of the deploy.
- **(alternative)** Add a top-level `fly.toml` with `[build] build_target = "web"` and a multi-stage `Dockerfile` that selects only `Web_Dashboard/`. More setup, useful if you ever want to deploy multiple services from the same repo.

The rest of this recipe assumes the preferred option.

### A.4. Fly.io app creation

From inside `Web_Dashboard/`:

```bash
flyctl launch --no-deploy --copy-config
```

- App name: `onebonsai-vr-instructor-staging` (or your convention). Becomes the default `*.fly.dev` hostname before your custom domain attaches.
- Region: pick whichever Fly region is closest to most customers. For OneBonsai's EU customer base, `ams` (Amsterdam) or `fra` (Frankfurt) are good defaults.
- Postgres / Redis: **no** for now. We have no DB and Socket.IO state is in-memory.
- Deploy now: **no** — we still need env vars.

This generates a `fly.toml` in `Web_Dashboard/`. **Commit it** — it becomes part of the project's deploy contract.

Edit the generated `fly.toml` to set:

```toml
[env]
  PORT = "3000"
  DEFAULT_TENANT_ID = "onebonsai"
  AGORA_TOKEN_TTL_SECONDS = "1800"

[http_service]
  internal_port = 3000
  force_https = true              # 308-redirect any http:// to https://
  auto_stop_machines = "off"      # Socket.IO doesn't tolerate cold-start latency
  auto_start_machines = true
  min_machines_running = 1        # always have one machine warm
```

The `auto_stop_machines = "off"` + `min_machines_running = 1` combo is
important: Socket.IO clients reconnect aggressively and Fly's
machine-suspend feature confuses long-lived WebSocket sessions. Keep at
least one machine warm at all times. For staging this costs ~$2/mo;
for production scale up `min_machines_running` based on load.

### A.5. Secrets

```bash
flyctl secrets set \
  AGORA_APP_ID="<from-agora-console>" \
  AGORA_APP_CERTIFICATE="<from-agora-console>" \
  INSTRUCTOR_SESSION_SECRET="<hex-from-A.1>"
```

These land in Fly's secret store, are injected as env vars at runtime,
and are never visible in logs or `flyctl status`. **Do NOT commit any
of these to `fly.toml`'s `[env]` block** — that section is for non-secret
config only.

### A.6. Deploy

```bash
flyctl deploy
```

Watch the build output. Expect:
- Builder pulls Node 20 base image
- `npm install` runs
- `node server.js` starts
- Log line: `[VRIP] dashboard listening on http://localhost:3000` + `[VRIP] agora creds set: yes` + `[VRIP tenants] loaded N tenant code(s): ...`
- Fly health-checks the app on `internal_port = 3000`

If `agora creds set: NO` appears, your secrets didn't land — re-run `flyctl secrets set` and re-deploy.

### A.7. Custom domain

```bash
flyctl certs create signaling.yourdomain.com
flyctl certs show signaling.yourdomain.com
```

The `certs show` output gives you a CNAME target (`<app>.fly.dev`). Add
that CNAME at your DNS provider. Fly auto-provisions a Let's Encrypt
cert once DNS propagates (usually 1-5 minutes).

Verify with `curl -I https://signaling.yourdomain.com/health` — expect
`HTTP/2 200` and `vary: Accept-Encoding`.

### A.8. Coordinate with the VR developer

Tell them:
- New `ServerUrl` for production: `https://signaling.yourdomain.com`
- Scheme is `https://` (not `http://`)
- They'll need to re-cook the VR app with this URL in `DefaultGame.ini`
- Confirm the per-environment cook story — see *Integration touchpoint* section below

### A.9. Smoke test end-to-end

1. Open `https://signaling.yourdomain.com/` in a browser. Expect 302 redirect to `/login.html`.
2. Log in with code `0000000000` (OneBonsai demo) + a name. Expect to land on the empty grid view with header `OneBonsai (Demo) · <YourName>`.
3. Click "Spawn demo sessions". Expect 5 popup windows, 5 tiles appearing in the grid within ~2 seconds.
4. Click a tile, send a "Pause simulation" command. Expect the yellow PAUSE badge to overlay on the faker.
5. Run the Phase 6 cookie-auth smoke test against the new host:
   ```powershell
   $env:BASE = "https://signaling.yourdomain.com"
   .\Web_Dashboard\scripts\smoke-phase6.ps1
   ```
   All steps should pass (login sets cookie, `/me` returns tenant info with cookie, returns 401 without, `/` redirects without cookie, etc.).
6. With the VR developer's re-cooked APK, repeat the 2-device validation matrix from Devlog 2026-06-08.

### A.10. Apply the hardening checklist

See **Recipe D** below for the 8 mandatory production tweaks. Do them
before pointing real customers at the URL.

---

## Recipe B — Standalone subdomain on a VPS (~half day)

Same end-state as Recipe A, but you own the box and the cost is fixed
(€5/mo on Hetzner CX11). Right choice when OneBonsai has existing
VPS-based infra you should slot into.

### B.1. Pre-flight

| Item | Notes |
|---|---|
| VPS provisioned with Ubuntu 24.04 LTS (or whatever OneBonsai standard is) | 1 vCPU + 1-2 GB RAM is plenty for v1 |
| Public IPv4 (and ideally IPv6) addresses | Hetzner/Linode/DO all provide these by default |
| SSH access via key (not password) | Standard for any internet-facing VPS |
| DNS A/AAAA record `signaling.yourdomain.com` → VPS IPs | Set this up now so Caddy can provision the cert in step B.5 |
| Same Agora creds + session secret as Recipe A | |

### B.2. System packages

```bash
# As root or via sudo
apt update && apt upgrade -y
apt install -y curl git ufw
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
# Verify: node --version → v20.x
```

For Caddy (the reverse proxy):
```bash
# Caddy install per https://caddyserver.com/docs/install
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

### B.3. Firewall

```bash
ufw allow 22/tcp       # SSH
ufw allow 80/tcp       # HTTP (for Caddy → Let's Encrypt challenge)
ufw allow 443/tcp      # HTTPS
ufw enable
# Verify: ufw status → 3 rules above, 'active'
```

**Do not expose port 3000.** Node listens only on `localhost:3000`;
Caddy forwards from `:443` to it. Exposing 3000 publicly would let
attackers bypass TLS.

### B.4. Service user + app deploy

```bash
useradd -r -m -s /bin/bash vrip
sudo -u vrip -i

# As vrip:
git clone https://github.com/Tootatj/VR-Instructor-Portal.git
cd VR-Instructor-Portal/Web_Dashboard
npm ci --omit=dev      # production install; faster + no devDeps
```

### B.5. Caddy reverse proxy

Edit `/etc/caddy/Caddyfile`:

```caddyfile
signaling.yourdomain.com {
    reverse_proxy localhost:3000

    # Compression for the static HTML/JS/CSS.
    encode zstd gzip

    # Tighten the default headers (defense in depth on top of the
    # cookie's HttpOnly + SameSite already set by auth.js).
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
        -Server
    }

    # Access log to journald (queryable via journalctl -u caddy).
    log {
        output stderr
        format console
    }
}
```

```bash
systemctl reload caddy
journalctl -u caddy -f      # watch for cert provisioning success
```

Within 1-5 minutes you should see `obtained certificate for signaling.yourdomain.com`. Verify with `curl -I https://signaling.yourdomain.com/health` — expect `HTTP/2 200`.

### B.6. Env vars

As root, create `/etc/vrip.env` (mode 600, owned by `vrip`):

```bash
sudo install -o vrip -g vrip -m 600 /dev/null /etc/vrip.env
```

Then edit `/etc/vrip.env` (`sudo nano /etc/vrip.env`):
```
PORT=3000
DEFAULT_TENANT_ID=onebonsai
AGORA_TOKEN_TTL_SECONDS=1800
AGORA_APP_ID=<from-agora-console>
AGORA_APP_CERTIFICATE=<from-agora-console>
INSTRUCTOR_SESSION_SECRET=<hex-from-pre-flight>
```

**Set mode 600**, owner `vrip`. The Node process reads it; nobody else should.

### B.7. systemd unit

Create `/etc/systemd/system/vrip.service`:

```ini
[Unit]
Description=VR Instructor Portal — signaling + dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=vrip
Group=vrip
WorkingDirectory=/home/vrip/VR-Instructor-Portal/Web_Dashboard
EnvironmentFile=/etc/vrip.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=vrip

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true
PrivateDevices=true
ReadWritePaths=/home/vrip/VR-Instructor-Portal/Web_Dashboard/data

[Install]
WantedBy=multi-user.target
```

The `ReadWritePaths` line is so the server can persist any future
mutations to `data/tenant-codes.json` (currently read-only, but the
backlog item for in-app tenant management would need writes).

```bash
systemctl daemon-reload
systemctl enable --now vrip
systemctl status vrip          # should show 'active (running)'
journalctl -u vrip -f          # watch boot logs
```

Expect the same boot lines as Recipe A.6.

### B.8. Coordinate with the VR developer + smoke test + hardening

Same as Recipe A steps 8-10. The deploy mechanism differs but
everything downstream is identical.

### B.9. Update workflow

When new code lands on `main`:

```bash
sudo -u vrip -i
cd VR-Instructor-Portal
git pull
cd Web_Dashboard
npm ci --omit=dev    # only re-runs if package-lock.json changed
exit
sudo systemctl restart vrip
journalctl -u vrip -f --since "1 minute ago"
```

Expect ~5 seconds of downtime during the restart. For zero-downtime
updates, run two Node processes on different ports behind Caddy's
load-balancing config — but that's premature optimisation for v1.

---

## Recipe C — Subpath-embedded inside OneBonsai portal (~1-2 days)

The right long-term answer for production integration. URL becomes
`portal.onebonsai.com/instructor/` instead of a standalone subdomain.
Requires coordination with the OneBonsai portal team for the
reverse-proxy config + auth integration.

### C.1. The architecture

```
[Browser] ──→ https://portal.onebonsai.com/                  (existing OneBonsai portal)
                                  /instructor/...            (proxied to our Node app)
                                          ↓
                            [OneBonsai's Nginx / load balancer]
                                          ↓
                            [our Node app, internal :3000]
```

The instructor dashboard appears as a section of the existing portal.
Same domain, same SSL cert, same cookies, optionally shared auth.

### C.2. Server-side changes in `server.js` (small)

Express needs to know it's mounted at `/instructor/` so internal paths
work (`Set-Cookie` paths, redirect URLs, asset references). Two
options:

- **(preferred, no code change)** Run our Node app unchanged on a fixed
  internal port, and have the portal's reverse proxy strip the
  `/instructor/` prefix before forwarding:
  ```nginx
  location /instructor/ {
      proxy_pass http://internal-vrip:3000/;   # trailing slash strips the prefix
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header X-Forwarded-Prefix /instructor;   # for app awareness
  }
  ```
- **(alternative, app-aware)** Set a `BASE_PATH=/instructor` env var
  and have the Express app mount routes under that prefix. Requires
  ~30 lines of changes to `server.js` (an outer `express.Router()`
  + adjusting the dashboard's `index.html`/`grid.js`/`login.js` asset
  paths). Slightly more work but means the app works the same whether
  proxied or direct.

Recommend the first option for v1. The second is a clean refactor if
embedding becomes the long-term plan.

### C.3. Client-side asset paths

If you went with the preferred option in C.2, the asset paths in
`public/index.html`, `login.html`, `grid.js`, etc. are all relative
(`./js/grid.js`) and just work. Verify by loading the dashboard via
the proxied URL and checking the browser dev tools Network tab for any
404s.

If anything resolves to absolute paths (`/css/style.css` with a
leading slash), those break and need to be relative-rewritten. Grep
the project for absolute paths:

```bash
rg '"/(css|js|api)/' Web_Dashboard/public/
```

The Phase 6 dashboard uses relative paths throughout for exactly this
reason — but verify after any future changes.

### C.4. Cookie scoping

Currently `auth.js` sets the cookie without a `Path=` or `Domain=`
attribute, meaning it scopes to the response's path (`/`) and
hostname. Behind a subpath proxy this is still correct — the cookie
applies to `portal.onebonsai.com` and is sent for every request to
that host including `/instructor/*`.

If/when you want to *isolate* the instructor cookie from the rest of
the portal (e.g., logging out of the instructor view shouldn't log
out of the portal):
- Add `Path=/instructor` to the `buildCookieAttrs()` output in `auth.js`
- Rename `COOKIE_NAME` from `vrip_instructor` to something prefixed
  to avoid name collisions with portal cookies

Decide with the portal team based on their cookie naming conventions.

### C.5. Auth integration

Two paths for who logs the instructor in:

| Pattern | What | Effort |
|---|---|---|
| **(a) Separate logins** | Our existing code-based login (`/login.html`) stays. Instructor must log into the portal AND the instructor section separately. | Zero — works today. |
| **(b) SSO bridge** | Portal logs the user in via its own mechanism; signs a small JWT with `{ tenantId, instructorName, exp }`; passes it to our app via a header or shared cookie. `auth.js::attachInstructorToReq` recognizes the JWT and bypasses the cookie path. | ~1 day. Requires deciding the JWT signing scheme with the portal team. |

(a) is the right v1 — ship it, validate the embedding, then bridge auth in a follow-up. (b) is the production target.

### C.6. WebSocket upgrade through the proxy

Critical: Socket.IO uses WebSocket upgrade headers (`Upgrade:
websocket`, `Connection: Upgrade`). The Nginx config in C.2 includes
the right `proxy_http_version 1.1` + `proxy_set_header Upgrade ...`
lines. If those are missing, the dashboard's Socket.IO client will
fall back to long-polling, which technically works but doubles
latency and bandwidth. Verify in the browser dev tools Network tab —
the first request after login should be a WebSocket upgrade (status
`101 Switching Protocols`).

### C.7. Cross-cutting: shared CORS

Once you're on the same domain (`portal.onebonsai.com`), CORS becomes
moot — every request is same-origin. The CORS lockdown from Recipe D
still applies but with a single allowed origin = the portal's URL.

### C.8. Coordinate + smoke test

Same as Recipe A.8/A.9 but with the URL `https://portal.onebonsai.com/instructor/`.

---

## Recipe D — Hardening checklist (mandatory regardless of recipe)

These are the items that **must** be done before any internet-facing
exposure. They're independent of which recipe above you picked — apply
all 8 to whichever deployment you chose.

### D.1. Lock down CORS

Currently `server.js:236-241`:

```javascript
cors: {
    // v1 may run on a LAN per §7 — permissive CORS for development.
    // Tighten before any internet-facing deploy.
    origin: true,
    credentials: true,
}
```

Replace `origin: true` with the explicit allowed origin. For Recipe A/B:

```javascript
cors: {
    origin: process.env.DASHBOARD_ORIGIN ?? 'https://signaling.yourdomain.com',
    credentials: true,
}
```

For Recipe C, set `DASHBOARD_ORIGIN=https://portal.onebonsai.com`.

The credential cookie is the load-bearing piece here: without CORS
lockdown, any malicious site can make a cross-origin request that
carries the user's `vrip_instructor` cookie and impersonate them. The
`credentials: true` line is required for our cookie auth to work, so
the `origin:` MUST be narrowed.

The Express middleware also needs the same lockdown — check the top of `server.js`:

```javascript
// Add near the top, before any routes:
import cors from 'cors';
app.use(cors({
    origin: process.env.DASHBOARD_ORIGIN ?? 'https://signaling.yourdomain.com',
    credentials: true,
}));
```

(Or replicate the Socket.IO CORS settings if there's already an `app.use(cors(...))` somewhere — grep `server.js` for `cors(`.)

### D.2. Real session secret

Already covered in Recipe A.5 / B.6. The one thing to triple-check:
**rotate the secret if it's ever been on a dev machine that gets
re-imaged or sold.** Rotating invalidates every active session
immediately — users have to re-login. Plan rotations for low-traffic
windows.

### D.3. `trust proxy`

Behind any reverse proxy (Caddy, Nginx, Fly's load balancer), Express
sees the request as coming from `127.0.0.1` over `http`. The cookie's
`Secure` flag in `auth.js::buildCookieAttrs()` checks `req.protocol`
to decide whether to set the flag — without `trust proxy`, it always
sees `http` and skips the flag, leaving the cookie sendable over
unencrypted connections.

Fix: add to `server.js` after `const app = express()`:

```javascript
app.set('trust proxy', 1);     // trust 1 hop (the reverse proxy)
```

For Fly.io use `1` (one hop). For an Nginx/Caddy in front of Node on
the same box use `1`. For multiple hops (e.g., Cloudflare → Nginx →
Node) use `2` or higher per the [Express docs](https://expressjs.com/en/guide/behind-proxies.html).

### D.4. Rate limit `/api/instructor/login` and `/api/orgs/redeem`

Both endpoints accept a code from user input and validate it against
the registry. Without rate limits, an attacker could brute-force the
4-32-char code space. The "Code not recognized" generic error message
already prevents enumeration, but rate limits add a second line of
defense.

```bash
cd Web_Dashboard
npm install express-rate-limit
```

In `server.js` (or split into `src/rate-limit.js` if it grows):

```javascript
import rateLimit from 'express-rate-limit';

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,   // 15 minutes
    max: 10,                     // 10 attempts per IP per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'too_many_attempts' },
});

app.use('/api/instructor/login', loginLimiter);
app.use('/api/tenant/resolve',  loginLimiter);    // same threat model
```

The numbers (10 / 15 min) are conservative; tune based on traffic
patterns once you have real usage data.

### D.5. Health endpoint

Already exists per `Web_Dashboard/README.md`: `GET /api/health` returns
`{ ok, uptime }`. Wire it into:
- Recipe A: Fly.io will auto-detect; no extra config
- Recipe B: add `health_uri /api/health` to Caddy + a UptimeRobot
  monitor pointing at `https://signaling.yourdomain.com/api/health`
- Recipe C: hook into OneBonsai's existing monitoring per their team's conventions

### D.6. Structured logging

Currently `console.log` lines go to wherever the process's stdout
goes. For production:

```bash
cd Web_Dashboard
npm install pino pino-pretty
```

Replace the `console.log` calls in `server.js` (and any other
top-level files) with a `pino` logger. Pino emits JSON to stdout
which any log aggregator (Datadog, Loki, CloudWatch) can ingest
directly. For Recipe B (`journalctl`-based), pipe through
`pino-pretty` in dev mode for readable output.

Sample:
```javascript
import pino from 'pino';
const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
// ... later
log.info({ port: PORT, agoraCreds: haveAgoraCreds }, 'dashboard listening');
```

This is technically optional for v1 (`console.log` works), but
non-structured logs become painful at ~100+ events/sec.

### D.7. Tenant-code backups

`Web_Dashboard/data/tenant-codes.json` is now customer data. Three
backup options:
- **(Recipe A — Fly.io)** Fly volumes don't apply (we don't use one).
  Best: commit `tenant-codes.json` to git as part of the deploy
  contract, and treat git as the backup. Sensitive entries (real
  customer codes) probably shouldn't be in a public repo though —
  consider a private fork or fetching the file from a separate
  storage URL at boot.
- **(Recipe B — VPS)** Daily `cron` job that copies the file to a
  S3-compatible bucket. Even simpler: weekly `rsync` to a backup VPS
  in a different region.
- **(Recipe C — portal-embedded)** Bundle into OneBonsai's existing
  backup story for the portal infrastructure.

Long-term, the right answer is replacing `tenant-codes.json` with a
real database (SQLite is sufficient — single file, full ACID, runs
in-process; covered as a backlog item in `Devlog.md`) or the portal
API integration. v1 doesn't require this; just have a backup plan.

### D.8. Monitoring + alerting

Minimum viable: UptimeRobot or BetterStack free tier hits
`/api/health` every 5 minutes, alerts via email/Slack if it returns
non-200 for two consecutive checks. Takes 5 minutes to set up.

For production: error tracking via Sentry (free tier covers ~5K
events/month), metrics via Fly's built-in dashboard or Prometheus +
Grafana on the VPS. Scale these to OneBonsai's existing observability
stack — don't reinvent.

---

## Integration touchpoint with the VR side

This section is the **handoff contract** with whoever is doing the
[`HowToPort.md`](HowToPort.md) port. Coordinate on these specifics
*before* either of you finishes their side.

### What the web side commits to providing

| Item | Format | Example |
|---|---|---|
| **Stable URL** | `https://<host>` (no trailing slash, no path) | `https://signaling.onebonsai.com` |
| **Same URL for HTTP API and Socket.IO** | Both speak through the same Express app | n/a |
| **Wire protocol** | Unchanged from `Web_Dashboard/README.md` "API + Socket.IO surface" table | n/a |
| **Tenant codes** | Pre-configured in `data/tenant-codes.json` (or eventually via the OneBonsai portal API) | `5555555555` → `securitas` |

### What the VR side has to do

| Step | What | Where |
|---|---|---|
| 1. Update `ServerUrl` | Change `DefaultGame.ini` to point at the production URL | `VR_Project/Config/DefaultGame.ini`, section `[/Script/VR_Project.SignalingSubsystem]` |
| 2. Verify scheme | `https://` not `http://` for production. The C++ Socket.IO client and HTTP client both handle TLS transparently against system-trusted CAs (no extra config for Let's Encrypt). | `USignalingSubsystem::Initialize` reads the URL as-is |
| 3. Re-cook the APK | Use `.\Tools\Cook-VRApp.ps1 -Device quest\|pico` (see `.cursorrules` §8.2) | `Tools/Cook-VRApp.ps1` |
| 4. Sideload to test devices | Per the existing 2-device validation matrix from Devlog 2026-06-08 | n/a |
| 5. Smoke test | Register against a tenant code, verify the new device appears in `https://<production-url>/` for that tenant | n/a |

### Per-environment cook story

If you have both staging and production environments, the VR side needs to be able to cook against either without confusion. Three patterns to consider:

| Pattern | Tradeoff |
|---|---|
| **(a) Two builds**: cook one APK pointing at staging, one at production. Install whichever you want to test against. | Simplest. Manual switching. APK file naming becomes important (`VR_Project-Quest-staging-arm64.apk` etc.). Maybe extend `Cook-VRApp.ps1` with a `-Environment staging\|prod` flag that picks the matching `DefaultGame.ini` block. |
| **(b) Per-developer override**: each dev's machine has a `Saved/Config/Windows/Game.ini` override pointing at whichever env they want to test today. | Cleaner dev workflow but requires the per-developer override backlog item to ship first. |
| **(c) Dynamic URL discovery**: the VR app fetches the server URL from a known DNS TXT record or HTTPS metadata endpoint at boot. | Most flexible. Most complex. Premature for v1. |

Default trajectory: (a) with a `-Environment` flag added to `Cook-VRApp.ps1`. Two flags (`-Device`, `-Environment`) produce 4 deterministic APKs (Quest-staging, Quest-prod, Pico-staging, Pico-prod) that co-exist on disk. The script's existing INI-mutate-and-restore pattern extends naturally to the second flag.

### What to coordinate explicitly

Before either side starts: agree on the URL.
Before merging either change: smoke test together with a test device pointed at the new URL.
After production cutover: the VR dev MUST re-cook + push the new APK to every device — there's no auto-update mechanism in v1 (any device with the old `ServerUrl` keeps pointing at the old server).

---

## Common gotchas (we expect; documented before they bite)

These are the friction points we either hit during dev or are confident enough about from architecture that they're worth pinning up front. Add to this section as new ones surface during your first real deploy.

1. **Without `app.set('trust proxy', 1)`, the cookie `Secure` flag is never set behind a reverse proxy.** `auth.js::buildCookieAttrs()` checks `req.protocol === 'https'`. Without `trust proxy`, Express trusts only the immediate socket — which is `http` from the reverse proxy. Result: cookies missing the `Secure` flag, vulnerable to MITM on first-request downgrade attacks. See D.3.
2. **Socket.IO falls back to long-polling without correct WebSocket upgrade headers in your reverse proxy.** Symptoms: dashboard works but latency is 2-3× slower than expected; the browser dev tools Network tab shows repeated `xhr` requests on `/socket.io/` instead of a single `wss` connection with status `101`. Caddy handles this automatically; Nginx needs the `proxy_set_header Upgrade $http_upgrade` block per the C.2 example.
3. **`origin: true` in the Socket.IO CORS config is the default permissive mode** — fine for LAN dev, a security hole on the internet. Replace with the explicit `DASHBOARD_ORIGIN` env var. See D.1.
4. **Setting `INSTRUCTOR_SESSION_SECRET` after sessions exist invalidates every existing session.** All instructors must re-login. Plan rotations for off-peak hours.
5. **mDNS `.local` hostnames don't resolve over the public internet.** If a previous dev workaround used something like `signaling.local` for cross-LAN convenience, that won't work for the production URL — must be a real DNS record.
6. **The `Set-Cookie` header without an explicit `Domain=` attribute scopes to the exact hostname.** Cookies set on `signaling.yourdomain.com` are NOT sent to `app.yourdomain.com`. Behind Recipe C this matters: if the portal and the dashboard end up on different subdomains during migration, plan a `Domain=.yourdomain.com` config and accept that the cookie is then visible to every subdomain. Easier path: keep them on the same hostname.
7. **Fly.io's `auto_stop_machines = true` defaults break Socket.IO.** Long-lived WebSocket connections don't survive the machine going to sleep — clients reconnect, sessions get re-created server-side, but Agora channels don't seamlessly recover. Set `auto_stop_machines = "off"` and `min_machines_running = 1` (see A.4).
8. **Agora's CDN-hosted SDK URL (`https://download.agora.io/sdk/...`) requires the CDN to be reachable from the user's browser.** Some corporate networks block it. Mitigation: self-host the JS bundle in `Web_Dashboard/public/vendor/AgoraRTC_N-4.20.0.js` and update the four `<script src="...">` references. ~10-minute change, also helps the offline-LAN-degraded-mode story.
9. **`force_https = true` on Fly.io (or equivalent HTTP-to-HTTPS redirects) breaks Socket.IO long-polling fallback.** Modern Socket.IO clients open the initial handshake over HTTPS so the redirect doesn't usually trigger, but if a misconfigured client opens `ws://` it gets redirected mid-handshake and fails. Verify with the browser dev tools Network tab. If issues, ensure the VR app's `ServerUrl` uses `https://`.
10. **The static asset CDN cache (browsers, Cloudflare) holds onto old versions of `grid.js` / `index.html` longer than you'd think.** After deploys, hard-reload (Ctrl+Shift+R) before assuming the new code is broken. For production: add a build version to asset URLs (`grid.js?v=20260608`) or use Caddy's `header` directive to set short `Cache-Control` on HTML files.

---

## Operational topics

### Adding new tenants in production

Per the discussion in the chat history that led to this doc and the
existing `tenants.js` module docstring:

1. Edit `Web_Dashboard/data/tenant-codes.json` on the deployed server (or via a deploy-from-git workflow).
2. Restart the Node process (`systemctl restart vrip` on Recipe B, `flyctl deploy` on Recipe A).
3. Done. Existing VR builds can immediately register against the new code — no re-cook needed.

For high-frequency tenant changes, see the Devlog backlog item for an admin endpoint that does this without a restart.

### Backups

Per D.7. Critical files to back up:
- `Web_Dashboard/data/tenant-codes.json` — tenant registry, customer data
- `/etc/vrip.env` (Recipe B) or Fly secrets (Recipe A) — credentials

Don't back up:
- `Web_Dashboard/node_modules/` — reconstructible via `npm ci`
- Logs — kept by `journalctl` or Fly's log retention; back up only if compliance requires

### Update workflow

Recipe A:
```bash
flyctl deploy            # from Web_Dashboard/ on your machine
```

Recipe B:
```bash
sudo -u vrip -i
cd VR-Instructor-Portal && git pull && cd Web_Dashboard && npm ci --omit=dev
exit
sudo systemctl restart vrip
```

Recipe C: per OneBonsai portal team's deployment workflow.

### Monitoring + alerting

Minimum:
- Uptime check on `https://<host>/api/health` every 5 min
- Alert on 2 consecutive failures

Production:
- Sentry for error tracking (sign up at <https://sentry.io>, add `@sentry/node` to `server.js`, takes ~30 min)
- Log aggregator pointed at `journalctl -u vrip` (Recipe B) or Fly's log stream (Recipe A)
- Metrics: requests/sec, active sessions, Socket.IO connection count (add a `/api/metrics` endpoint with `prom-client` if you want a real Prometheus story)

### Rotating Agora credentials

When you suspect the App Certificate has leaked:
1. Mint a new project in the Agora console
2. Update `AGORA_APP_ID` + `AGORA_APP_CERTIFICATE` secrets (`flyctl secrets set` or edit `/etc/vrip.env`)
3. Restart the Node process
4. Any in-flight session loses its current token but auto-refreshes via the BP-side `RefreshToken` path (see Phase 4 Phase E in `Devlog.md`)
5. New sessions immediately use the new creds

No VR-side change required — the App ID is server-fetched per session via `/api/token`, not baked into the APK.

---

## Related project docs

- [`README.md`](README.md) — top-level project overview, prereqs, repo layout.
- [`HowToPort.md`](HowToPort.md) — counterpart of this doc: how to reuse the signaling layer in a different UE project. The VR developer's handoff doc.
- [`Web_Dashboard/README.md`](Web_Dashboard/README.md) — local-dev setup, full API + Socket.IO surface table, end-to-end smoke test recipe.
- [`Web_Dashboard/.env.example`](Web_Dashboard/.env.example) — annotated env var reference.
- [`.cursorrules`](.cursorrules) — master technical contract: wire protocol, performance bars, Agora topology, conventions.
- [`Devlog.md`](Devlog.md) — session-by-session decisions. Especially see the 2026-06-04 Phase 6 scope revision entry for the 4 dashboard embedding patterns + the 2026-06-08 backlog items being closed by this work.

---

## Change log

Append a row when this guide's prescriptions change (new recipe, new gotcha learned, hardening item added, deploy mechanism changes, etc.). Most-recent first.

| Date | Commit | What changed |
|---|---|---|
| 2026-06-08 | `<this commit>` | Initial guide. Four recipes (A: PaaS / B: VPS / C: subpath-embedded / D: hardening checklist), integration-touchpoint section with the VR developer, 10 common gotchas pinned in advance, operational topics (tenant management / backups / updates / monitoring / cred rotation). Created because `HowToPort.md` explicitly disclaims web deploy and the Web_Dashboard/README.md only covers local dev — a web-developer handoff needed a parallel doc. |
