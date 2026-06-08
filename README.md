# VR Instructor Portal

Real-time pairing, streaming, and command-console system that connects mobile
VR headsets (trainees) to a web-based instructor dashboard. A trainee on a
Quest 3 / Pico 4 Enterprise is paired to an instructor in a browser via a
4-digit code; the instructor sees the trainee POV at 720p / 30fps over Agora
WebRTC, talks bidirectionally, and dispatches JSON commands.

For full architecture, conventions, and performance constraints see
[`.cursorrules`](.cursorrules). For session-by-session progress, decisions,
and rollbacks see [`Devlog.md`](Devlog.md).

For handoff-style "how to take this somewhere new" recipes:
- **Reusing the signaling layer in a different UE training app** (VR developer's recipe) → [`HowToPort.md`](HowToPort.md)
- **Deploying the web dashboard to a public domain** (web developer's recipe) → [`HowToDeploy.md`](HowToDeploy.md)

## Repository layout

```
.cursorrules        Master technical contract (architecture, conventions, perf bars)
Devlog.md           Operational ledger (session notes, decisions, rollbacks, backlog)
HowToPort.md        Recipe for reusing this project's signaling layer in another UE app
HowToDeploy.md      Recipe for deploying the web dashboard to a public domain (TLS, hardening, hosting options)
VR_Project/         Unreal Engine 5.5.4 mobile VR client
Web_Dashboard/      Node.js + Express + Socket.IO signaling server + vanilla-JS instructor SPA
Tools/              Per-device cook wrapper (Cook-VRApp.ps1) + future build/deploy scripts
```

## Prerequisites

| Requirement       | Version                          | Notes |
|-------------------|----------------------------------|-------|
| Unreal Engine     | **5.5.4** (locked)               | Install via Epic Games Launcher. |
| Visual Studio     | 2022 (Community is fine)         | Must include the **"Game development with C++"** workload — required to compile the project's C++ module and the Agora plugin source on first open. |
| Android Studio    | Ladybug or later                 | Provides JDK + SDK + NDK. See `Devlog.md` "System Remediation History" for known environment-variable gotchas (`JAVA_HOME`, `NDK_ROOT`, `cmdline-tools\latest`). |
| Git LFS           | latest                           | Required for the project's binary UE assets. Run `git lfs install` once per machine before cloning. |
| Test hardware     | Meta Quest 3 *or* Pico 4 Enterprise | Developer Mode on, USB debugging authorized. |

## Setup

### 1. Clone the repository

```bash
git lfs install
git clone https://github.com/Tootatj/VR-Instructor-Portal.git
```

### 2. Install the Agora UE plugin (manual — REQUIRED)

The **Agora-Unreal-RTC-SDK** plugin is **not committed** to this repository
(~800 MB of vendor-distributed prebuilt SDK binaries). Every developer and
CI runner must install it manually before opening the project:

1. Download **`Agora_RTC_FULL_SDK_4.5.1_Unreal.zip`** from the upstream v4.5.1 release:
   <https://github.com/AgoraIO-Extensions/Agora-Unreal-RTC-SDK/releases/tag/v4.5.1>
2. Unzip the archive.
3. Copy the inner `AgoraPlugin/` folder into `VR_Project/Plugins/` so the
   final path is exactly:

   ```
   VR_Project/Plugins/AgoraPlugin/
   ```

4. The plugin folder is listed in `.gitignore` — confirm with `git status`
   that it does **not** appear as untracked.

> **Use v4.5.1 specifically.** This is the version empirically verified
> against UE 5.5.4 in this project (PIE↔web-demo audio round-trip working,
> multiple play/stop cycles without crash). See the `Devlog.md` 2026-06-01
> "Phase 2 desktop completion + v4.5.1 confirmation" entry for the validation
> log. Do not silently bump to newer 4.5.x releases without re-running the
> Phase 2 PIE round-trip first.

> **Upstream repo:** <https://github.com/AgoraIO-Extensions/Agora-Unreal-RTC-SDK>

### 3. Open the project

1. Double-click `VR_Project/VR_Project.uproject`.
2. UE will detect the unbuilt project module + Agora plugin source and
   prompt to compile. Click **Yes** — first build takes ~1 minute.
3. Verify under **Edit → Plugins → AgoraPlugin** that the plugin is enabled.
4. Confirm the built-in **AndroidPermission** plugin is also enabled (required
   for runtime mic/camera prompts on Quest).

If UE refuses to launch with a "missing modules" error, Visual Studio's
"Game development with C++" workload is not installed (see Prerequisites).

## Build and deploy to a headset

**Use the per-device cook wrapper as the entry point** (handles the per-vendor
`[HMDPluginPriority]` mutation + APK renaming automatically):

```powershell
.\Tools\Cook-VRApp.ps1 -Device quest         # cook + deploy to Quest 3
.\Tools\Cook-VRApp.ps1 -Device pico          # cook + deploy to Pico 4 Enterprise
.\Tools\Cook-VRApp.ps1                       # auto-detect from `adb devices`
```

See [`.cursorrules` §8](.cursorrules) for the full pipeline (pre-flight
requirements, the underlying verbatim UAT command, flag reference, build
variants, output artifact paths, and the known-failure-signature triage
table). The wrapper exists because Quest and Pico require different
`[HMDPluginPriority]` blocks at cook time — see the Devlog 2026-06-08
follow-up entry for the rationale.

Pre-flight (verify *before* invoking the wrapper):

1. Headset connected via a USB-C **data** cable (charge-only cables will not enumerate).
2. Developer Mode toggled on in the device's mobile companion app.
3. USB debugging authorized on the headset screen.
4. `adb devices` lists the headset with status `device` (not `unauthorized`, not `offline`).
5. PowerShell execution policy allows running unsigned local scripts —
   one-time setup: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## Web Dashboard

The signaling server (Node 20+ / Express / Socket.IO) and the instructor
SPA (vanilla JS / HTML / CSS, served by the same Express app) live under
`Web_Dashboard/`. As of Phase 6 it ships multi-tenant cookie auth, the
OneBonsai-style 3×2 grid view with per-tile focus mode + command deck,
a code-based login flow, and a canvas-published faker tool for testing
the grid without N physical headsets.

For local development setup, see [`Web_Dashboard/README.md`](Web_Dashboard/README.md)
— install Node, copy `.env.example`, `npm run dev`, open `http://localhost:3000`,
and run the 2-minute end-to-end smoke test documented there.

For deploying the dashboard to a public domain (staging or production),
see [`HowToDeploy.md`](HowToDeploy.md) — covers PaaS (Fly.io / Railway),
VPS (Hetzner / DigitalOcean + Caddy + systemd), and subpath-embedded
patterns, plus the 8-item production-required hardening checklist and
the integration contract with the VR side.
