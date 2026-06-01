# VR Instructor Portal

Real-time pairing, streaming, and command-console system that connects mobile
VR headsets (trainees) to a web-based instructor dashboard. A trainee on a
Quest 3 / Pico 4 Enterprise is paired to an instructor in a browser via a
4-digit code; the instructor sees the trainee POV at 720p / 30fps over Agora
WebRTC, talks bidirectionally, and dispatches JSON commands.

For full architecture, conventions, and performance constraints see
[`.cursorrules`](.cursorrules). For session-by-session progress, decisions,
and rollbacks see [`Devlog.md`](Devlog.md).

## Repository layout

```
.cursorrules        Master technical contract (architecture, conventions, perf bars)
Devlog.md           Operational ledger (session notes, decisions, rollbacks, backlog)
VR_Project/         Unreal Engine 5.5.4 mobile VR client
Web_Dashboard/      Node.js + Express + Socket.IO server + vanilla-JS SPA (not yet scaffolded)
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

1. Download **`Agora_RTC_FULL_SDK_4.5.0_Unreal.zip`** from the upstream v4.5.0 release:
   <https://github.com/AgoraIO-Extensions/Agora-Unreal-RTC-SDK/releases/tag/v4.5.0>
2. Unzip the archive.
3. Copy the inner `AgoraPlugin/` folder into `VR_Project/Plugins/` so the
   final path is exactly:

   ```
   VR_Project/Plugins/AgoraPlugin/
   ```

4. The plugin folder is listed in `.gitignore` — confirm with `git status`
   that it does **not** appear as untracked.

> **Use v4.5.0 specifically.** Newer 4.5.x releases have not been validated
> against UE 5.5 in this project. See the `Devlog.md` "2026-05-28 — Phase 2"
> entry for the rationale.

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

## Build and deploy to Quest

The canonical UAT command is documented verbatim in
[`.cursorrules` §8.2](.cursorrules). Quick reference (run from `VR_Project/`
in a **Windows Command Prompt** — *not* PowerShell, because `%CD%` expansion
differs):

```bat
"C:\Program Files\Epic Games\UE_5.5\Engine\Build\BatchFiles\RunUAT.bat" ^
  BuildCookRun ^
  -project="%CD%\VR_Project.uproject" ^
  -targetplatform=Android ^
  -cookflavor=ASTC ^
  -clientconfig=Development ^
  -build -cook -stage -package -archive ^
  -archivedirectory="%CD%\Build" ^
  -deploy -run
```

Pre-flight checks (verify *before* invoking the build — see
[`.cursorrules` §8.1](.cursorrules)):

1. Headset connected via a USB-C **data** cable (charge-only cables will not enumerate).
2. Developer Mode toggled on in the device's mobile companion app.
3. USB debugging authorized on the headset screen.
4. `adb devices` lists the headset with status `device` (not `unauthorized`, not `offline`).

See [`.cursorrules` §8](.cursorrules) for the full flag reference, build
variants, and the known-failure-signature triage table.

## Web Dashboard

Not yet scaffolded. The signaling server (Node + Express + Socket.IO) and
instructor SPA (vanilla JS / HTML / CSS) are fully specified in
[`.cursorrules` §3, §4.3, §5](.cursorrules), but the `Web_Dashboard/`
directory does not yet exist on disk.
