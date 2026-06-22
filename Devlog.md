# Developer Log: VR Instructor Portal

## Current Project Status

**Phase:** Phase 7 instructor-view rebuild **closed cross-vendor (2026-06-22)** — frame-hijacking stream verified on **Quest 3** (2026-06-18) and **Pico 4 Enterprise** (2026-06-22). Per-app interactive control plane (2026-06-15) remains live: headsets publish state via `EmitStateUpdate` / `EmitStateUpdateFromJson`, dashboard loads per-`appId` UI (`VRFT.js`), instructor commands route through app-scoped validation. **Known open item:** malformed `Format Text` JSON in `BP_VRPawn` can drop `data` fields on state updates (level picker metadata) — fix in editor or via a small C++ helper; a prior dashboard-side sync fix was reverted after it caused a focus-view "connecting" hang.

**Prior phases all closed.** Phase 1 (Agora cost-exposure mitigations) shipped 2026-06-11. Phase 6D (channel-swap + per-device cook wrapper) closed 2026-06-08. Phase 3 (Agora video streaming) closed 2026-06-03. Pinned Agora plugin **v4.5.1**. Canonical port guide: `HowToPort.md`; deploy ops: `HowToDeploy.md`; wire protocol: `Web_Dashboard/docs/state-updates.md` + `commands.md`.

This developer log tracks completed environment engineering, architectural constraints, resolved pipeline blockers, and current session work for the **VR Instructor Portal** project.

---

## Workspace Topology

```
C:\Users\Thomas\VR-Instructor-Portal\
├── .cursorrules        Master AI development contract & technical constraints guide
├── Devlog.md           This file — operational state tracking context ledger
├── Web_Dashboard/      Node.js + Express + Socket.IO signaling/command plane (not yet scaffolded)
└── VR_Project/         Unreal Engine 5.5.4 mobile standalone VR client
```

---

## System Remediation History

### 1. Legacy Android Studio Purge & Upgrade

- **Issue:** The environment contained a deprecated installation layout with stale configurations, outdated device profiles, and incompatible path mappings.
- **Resolution:** Completely uninstalled legacy components, explicitly purging old user settings and historical configuration structures. Installed a clean standard distribution of modern Android Studio (Ladybug layout), initializing fresh baseline paths.

### 2. Environment Variable Repair (`JAVA_HOME` & NDK Purge)

- **Issue:** Windows environment variables pointed to a non-existent `\jre\` subdirectory inside the old Android Studio layout. Concurrently, `NDK_ROOT` and `NDKROOT` pointed to an archaic NDK version (`21.4.7075529`), which would have broken modern cross-compilation target routing.
- **Resolution:** Manually updated the user variable configuration via System Properties. Rerouted `JAVA_HOME` to the modern JetBrains Runtime subdirectory (`\jbr\`). Deleted stale legacy `NDK_ROOT` and `NDKROOT` variables completely, allowing UE deployment scripts to auto-map modern SDK parameters.

### 3. Java Runtime Crash Bypass (`XmlSchema` Class Not Found)

- **Issue:** Running `SetupAndroid.bat` triggered `java.lang.NoClassDefFoundError: javax/xml/bind/annotation/XmlSchema`. The script's `IF EXIST` validation loop failed to find a modern toolchain path and fell back to an obsolete `...\Android\Sdk\tools\bin\sdkmanager.bat` incompatible with modern Java runtimes.
- **Resolution:** Android Studio had deployed the required command-line tools into a version-locked subdirectory (`...\cmdline-tools\8.0\`). Manually renamed that directory to **`latest`** to match the UE expectation. This forced execution through `...\cmdline-tools\latest\bin\sdkmanager.bat`, resolving the crash.

### 4. Application Identity & Packaging Loop Configuration

- **Issue:** The initial headless compilation pipeline crashed near the archive loop with `ExitCode=51 (Error_FailureGettingPackageInfo)`. UAT cooked all assets but aborted because it lacked a unique reverse-domain identifier (`PackageName`), causing `aapt.exe` to return `null`. The build command was also missing the explicit `-package` flag.
- **Resolution:** Set `PackageName=com.Thomas.VRProject` in `DefaultEngine.ini` under the `[/Script/AndroidRuntimeSettings.AndroidRuntimeSettings]` block. Refined the UAT command to include `-package` explicitly. Both changes were captured in `.cursorrules §8.2` (the canonical UAT command).

---

## Baseline Asset Configurations

### `/VR_Project/Config/DefaultEngine.ini`

Rendering pipeline tuned for Snapdragon XR2 thermal/perf envelope (Quest 3, Pico 4 Enterprise):

```ini
[/Script/EngineSettings.GameMapsSettings]
GlobalDefaultGameMode=/Game/VRTemplate/Blueprints/VRGameMode.VRGameMode_C
EditorStartupMap=/Game/VRTemplate/Maps/VRTemplateMap.VRTemplateMap
GameDefaultMap=/Game/VRTemplate/Maps/VRTemplateMap.VRTemplateMap

[/Script/Engine.RendererSettings]
; Core Mobile VR Rendering Path
r.ForwardShading=True
r.Mobile.ForwardShading=True
r.MobileHDR=False
vr.MobileMultiView=True
vr.InstancedStereo=True
r.Mobile.DisableVertexFog=True

; Anti-Aliasing (4x MSAA for crisp text/edges)
r.Mobile.AntiAliasing=3
r.AntiAliasingMethod=3
r.Mobile.MSAA.Samples=4

; Disabling High-End Desktop Features (Performance Safeguards)
r.Shadow.Virtual.Enable=0
r.RayTracing=False
r.DynamicGlobalIlluminationMethod=0
r.ReflectionMethod=0
r.GenerateMeshDistanceFields=False
r.DefaultFeature.AutoExposure=False
r.DefaultFeature.AmbientOcclusion=False
r.DefaultFeature.AmbientOcclusionStaticFraction=False
r.DefaultFeature.MotionBlur=False
r.Mobile.UseHWsRGBEncoding=True
r.AllowStaticLighting=True
r.SkinCache.CompileShaders=True

[/Script/AndroidRuntimeSettings.AndroidRuntimeSettings]
PackageName=com.Thomas.VRProject
bBuildForES31=False
bBuildForArm64=True
bBuildForX8664=False
bSupportVulkan=True
bSupportOpenGL=False
MinSDKVersion=32
TargetSDKVersion=34
bEnableDynamicMaxFPS=True
ExtraApplicationSettings=<meta-data android:name="com.oculus.supportedDevices" android:value="quest|quest2|questpro|quest3" />
bPackageForMetaQuest=True

[/Script/OculusXRHMD.OculusXRHMDRuntimeSettings]
; Lock Mobile VR Frame Rates
bSupportedDisplayRefreshRates=True
DefaultDisplayRefreshRate=72.0
bDynamicRefreshRate=True
```

---

## Session Ledger

### 2026-05-28 — SceneColorCopy experiment and rollback

A colleague provided four C++ files (`SceneColorCopyComponent.h/.cpp`, `SceneColorCopyViewExtension.h/.cpp`) designed to capture the post-tonemap scene color into a `UTextureRenderTarget2D` via `FSceneViewExtensionBase::SubscribeToPostProcessingPass`. To integrate them we scaffolded a brand-new C++ module (`VR_Project`) inside the project — five new files (`VR_Project.Target.cs`, `VR_ProjectEditor.Target.cs`, `VR_Project.Build.cs`, `VR_Project.h`, `VR_Project.cpp`) plus the four colleague files, and a patch to `VR_Project.uproject` adding the `Modules` array. The build succeeded.

Three sequential rendering issues then surfaced:

1. **Format mismatch crash in non-VR PIE.** `Assertion failed: InputDesc.Format == OutputDesc.Format` in `AddCopyTexturePass`. Root cause: post-tonemap scene color format varies per environment — `PF_FloatRGBA` on the colleague's machine, `PF_FloatR11G11B10` on this machine's non-VR PIE, `PF_B8G8R8A8` in VR Preview. Mitigated with **dynamic format detection**: a game-thread `AsyncTask` lazily reinitializes the output RT to match whatever format the renderer is actually using, skipping one frame to do it. This worked.

2. **VR Preview freeze.** Returning the flattened 2D from `FScreenPassTexture::CopyFromSlice` (the colleague's original return value) hung the VR render thread because downstream stereo passes expect a 2D array texture. Returning `FScreenPassTexture()` (invalid) instead caused `PostProcessSelectionOutline` to assert on `Inputs.SceneColor.IsValid()`. The post-process subscription approach is fundamentally incompatible with UE 5.5's instanced-stereo rendering chain (`vr.InstancedStereo=True` in `DefaultEngine.ini`).

3. **Black target plane.** Even in non-VR PIE — with the format auto-detection working, `AddCopyTexturePass` logging successful 3600+ times per session, the C++ writes confirmed by per-frame diagnostic logs, and the BP wiring proven correct against a static `UTexture2D` — the target plane in the level remained the material default. The dynamic `UTextureRenderTarget2D` object was being passed to `SetTextureParameterValue` but the MID's sampler did not display its contents. Sampler-source changes, sampler-type changes, and a Blueprint-side `Clear Render Target 2D` to a known color all failed to make the plane react. Root cause was never definitively isolated.

**Resolution:** Rolled back the entire experiment to return to a clean known-good Blueprint-only project state.

- Deleted `VR_Project/Source/` (all 9 C++ files).
- Removed the `Modules` array from `VR_Project.uproject`.
- Removed build artifacts: `Binaries/`, `Intermediate/`, `.vs/`, `VR_Project.sln`.
- Deleted the user-authored `Content/InstructorViewSystem/` folder (containing `BP_StreamScreen`, `M_SceneCaptureDisplay`, and test textures).
- Removed the `BP_StreamScreen` placeholder actor from `VRTemplateMap.umap`.

Re-verified the full UAT pipeline (build → cook → stage → package → deploy → run) on the connected Quest 3 in ~85 seconds (warm DDC). Committed and pushed as `f7011de`.

### 2026-05-28 — Pivot back to Agora RTC SDK approach

Returning to the prescribed architecture in `.cursorrules §1.3`:

```
UE Scene → SceneCaptureComponent2D → RenderTarget → push as custom video source → Agora
```

A separate `SceneCaptureComponent2D` actor (built-in UE component) renders at exactly 1280×720 / 30 fps, fully independent of the main view's post-process chain. No view extensions, no third-party C++ headers, stereo-safe by construction. The capture is monoscopic by design, which is exactly what the instructor stream needs.

**Phase 1 — Capture pipeline in pure Blueprint (in progress):**

- **1.1** Create `RT_InstructorStream` render target (1280×720, `RTF_RGBA8`, Clamp/Clamp, black clear color)
- **1.2** Create `M_RTStreamDebug` material (Surface / Unlit / Opaque, `TextureSampleParameter2D` named `StreamTex`, Sampler Source `Shared: Clamp`, Sampler Type `Color`, default texture = `RT_InstructorStream`, RGB → Emissive)
- **1.3** Add `SceneCaptureComponent2D` as a child of `VRPawn`'s Camera component, named `SceneCaptureStream`. Properties: `TextureTarget=RT_InstructorStream`, `CaptureSource=Final Color (LDR) in RGB`, `bCaptureEveryFrame=false`, `bCaptureOnMovement=false`, `FOVAngle=90`, `Projection=Perspective`, relative transform zeroed
- **1.4** Drive captures at exactly 30 fps via `SetTimerByFunctionName` on `BeginPlay` (rate `0.0333` s, looping) calling a `CaptureFrame` BP function that invokes `CaptureScene()`
- **1.5** Drop a `Plane` actor in `VRTemplateMap` sampling the RT via `M_RTStreamDebug`
- **1.6** Verify in non-VR PIE → VR Preview → Quest deploy

### 2026-05-28 — Phase 2: Agora plugin install + BP join flow (in progress)

**Plugin selection.** After surveying the Unreal+Agora ecosystem, settled on **`AgoraIO-Extensions/Agora-Unreal-RTC-SDK`** (official, actively maintained). Picked the **v4.5.0** release rather than v4.5.1 because 4.5.0 is the most recent release with explicit UE 5.3/5.4 validation in the upstream release notes — closer to our 5.5 target than the older 4.4.x line. UE 5.5 is not yet on the official compatibility matrix, but the plugin loaded and compiled cleanly on first open.

**Why not a custom WebRTC build:** Agora's plugin ships pre-built Android `arm64-v8a` `.so` binaries, has a documented Blueprint API (`Get Agora Rtc Engine`, `Initialize`, `Enable Audio`, `Join Channel`, plus an `IRtcEngineEventHandler` UObject for event binds), and offloads all the codec/network plumbing we would otherwise own. It also has working precedent in shipping VR titles.

**Install discipline.** The unpacked plugin is **814 MB** of pre-built SDK binaries. It is **not committed** — `.gitignore` now excludes `VR_Project/Plugins/AgoraPlugin/`. Each developer / CI runner installs it manually:

1. Download `Agora_RTC_FULL_SDK_4.5.0_Unreal.zip` from <https://github.com/AgoraIO-Extensions/Agora-Unreal-RTC-SDK/releases/tag/v4.5.0>.
2. Unzip and copy the inner `AgoraPlugin/` folder to `VR_Project/Plugins/AgoraPlugin/`.
3. Open `VR_Project.uproject` — UE will compile the plugin on first launch (~1 min).
4. Confirm enabled via `Edit → Plugins → AgoraPlugin` (should be on automatically if the folder is in place; also enable the built-in `AndroidPermission` plugin for the runtime mic/camera prompts).

**Channel topology decision.** Using `CHANNEL_PROFILE_COMMUNICATION` rather than `LIVE_BROADCASTING` for the first sanity test. Communication mode is symmetric (every participant is implicitly a publisher), so no explicit `SetClientRole(Broadcaster)` call is needed for the initial round-trip audio test against Agora's web demo. If we later need true broadcast semantics (1-to-many audience), revisit and add the client-role node + per-side mode switches.

**BP_VRPawn wiring — current state (compiles, not yet tested live).** The `BeginPlay` execution chain now ends with an Agora join sequence appended after the existing SceneCapture timer:

```
[existing] SetTimerByFunctionName(CaptureFrame, 0.0333s, looping)
   ↓
Request Android Permission (Permissions: String array; RECORD_AUDIO, MODIFY_AUDIO_SETTINGS,
   INTERNET, ACCESS_NETWORK_STATE, READ_PHONE_STATE, CAMERA, WRITE_EXTERNAL_STORAGE)
   ↓
Delay (0.5s — lets the Android permission dialog resolve before SDK init)
   ↓
Initialize (Target = Get Agora Rtc Engine; Context = RtcEngineContext struct with App Id + ChannelProfile=COMMUNICATION)
   ↓
Enable Audio (Target = Get Agora Rtc Engine)
   ↓
Join Channel (Target = Get Agora Rtc Engine; Token, Channel Id, Info="", UID=0)
```

**Not yet wired.** Event handler binds. The plugin exposes existing event handlers via `Get Event Handler` (a pure node off the engine, with three output pins: `Handler Type`, `Event Handler`, `Event Handler Ex`). The middle `Event Handler` pin is the one to bind off. Pending event subscriptions before we can verify connection state:

- `OnJoinChannelSuccess(Channel, Uid, Elapsed)` → print confirmation
- `OnError(Err, Msg)` → red print for diagnostics
- `OnUserJoined(Uid, Elapsed)` → confirm web-demo peer arrival
- `OnLeaveChannel(Stats)` → confirm clean teardown

**Credentials.** App ID and a 24-hour temporary token (for channel `test`) were generated in the Agora console and pasted directly into the `Make RtcEngineContext` and `Join Channel` nodes for the prototype. These are **prototype-only**; per `.cursorrules §4.1` and `§4.3.1`, production credentials live in server env vars and tokens are minted server-side and refreshed mid-session. Phase 4 (server-side `agora.js`) replaces these hard-coded values.

**Next step:** wire the four event binds off `Get Event Handler`, then sanity-test in non-VR PIE against the Agora basic voice-call web demo (<https://webdemo.agora.io/basicVoiceCall/>) using the same App ID, channel `test`, and token. Once join + bidirectional audio confirmed on desktop, deploy to Quest and repeat. Custom video frame push (RT → Agora external video source) is Phase 3, after audio is proven.

### 2026-06-01 — Re-introducing C++ module for Agora plugin compile chain

The `AgoraIO-Extensions/Agora-Unreal-RTC-SDK` v4.5.0 plugin ships with C++ source files that UnrealBuildTool must compile from inside the project's build graph. A pure-Blueprint project has no build graph, so opening the project with `Plugins/AgoraPlugin/` in place silently skips the plugin compile and the Agora BP nodes never resolve. Re-introducing a minimal C++ module is the standard fix.

**Workflow used:** opened the project *without* `Plugins/AgoraPlugin/` on disk → `Tools → New C++ Class` to scaffold the module (UE generated the `Source/` tree + a placeholder `MyClass`) → closed the editor → dropped the v4.5.0 `AgoraPlugin/` folder into `Plugins/` → reopened, allowing UE to compile both the project module and the plugin's C++ sources in one pass.

**Scope of this change — explicitly NOT a return to the SceneColorCopy approach.** The 2026-05-28 rollback eliminated a *view-extension* C++ module that subscribed to `FSceneViewExtensionBase::SubscribeToPostProcessingPass` and broke instanced stereo (`vr.InstancedStereo=True`). This new module is empty by design: it exists solely so UBT will compile the Agora plugin and link its `arm64-v8a` `.so` and Win64 `.lib` binaries into the build. The eventual `UAgoraVideoPump` (Phase 3) will live here as a single self-contained `UActorComponent` that reads from `RT_InstructorStream` and pushes RGBA frames to `IMediaEngine::pushVideoFrame()` — no view extensions, no `AddCopyTexturePass`, no MID-sampling.

**Files added (committed):**

- `VR_Project/Source/VR_Project.Target.cs` — Game target, `BuildSettingsVersion.V5`, `ExtraModuleNames = { "VR_Project" }`.
- `VR_Project/Source/VR_ProjectEditor.Target.cs` — Editor target, same settings.
- `VR_Project/Source/VR_Project/VR_Project.Build.cs` — module dependencies: `Core`, `CoreUObject`, `Engine`, `InputCore`. The Agora plugin module name will be added to `PrivateDependencyModuleNames` when Phase 3 lands.
- `VR_Project/Source/VR_Project/VR_Project.h` / `.cpp` — module entry point (`IMPLEMENT_PRIMARY_GAME_MODULE(FDefaultGameModuleImpl, VR_Project, "VR_Project")`).

**Files removed before commit:**

- `Source/VR_Project/MyClass.h` / `MyClass.cpp` — the UE wizard's default boilerplate used to trigger module scaffolding. Inherits from nothing, referenced nowhere; deleted to keep the module surface intentionally empty until Phase 3.

**`.uproject` patch:** re-adds the `Modules` array with `{ Name: "VR_Project", Type: "Runtime", LoadingPhase: "Default" }`. This re-enables editor-side hot-reload of the project module and tells UBT that the `Source/VR_Project/` directory is a real module, not orphan files.

**`.gitignore`:** `VR_Project/Plugins/AgoraPlugin/` remains gitignored (800 MB of vendor binaries — re-verified by `git check-ignore`). Install instructions unchanged from the 2026-05-28 entry.

**Validation:** project opens, plugin compiles cleanly on first open (~1 min cold), no new warnings in the Output Log beyond the pre-existing OpenXR localization noise. Full UAT BuildCookRun → deploy to Quest 3 still works. No runtime behavior change — the Agora App ID and 24h temporary token are still hard-coded in the `Make RtcEngineContext` and `Join Channel` BP nodes; the four event-handler binds (`OnJoinChannelSuccess`, `OnError`, `OnUserJoined`, `OnLeaveChannel`) remain the next concrete unit of work before the Phase 2 audio round-trip can be tested.

### 2026-06-01 — Phase 2 desktop completion + v4.5.1 confirmation

PIE↔web-demo audio round-trip is working. Channel name standardized as `Test01` (case-sensitive); the temp token is regenerated in the Agora console and bound to this exact channel name. The four event handler binds (`OnJoinChannelSuccess`, `OnError`, `OnUserJoined`, `OnLeaveChannel`) all fire and print to the Output Log via `LogBlueprintUserMessages`.

**Final BeginPlay chain in `VRPawn.uasset`:**

```
SetTimerByFunctionName(CaptureFrame, 0.0333s, looping)
  -> Request Android Permission (RECORD_AUDIO, MODIFY_AUDIO_SETTINGS, INTERNET,
       ACCESS_NETWORK_STATE, READ_PHONE_STATE, CAMERA, WRITE_EXTERNAL_STORAGE)
  -> Delay 0.1s   (NOTE: bump to >= 0.5s before Quest deploy — see backlog)
  -> Initialize (Get Agora Rtc Engine, Context = { eventHandlerType=EventHandler,
       appId=<…>, channelProfile=COMMUNICATION, audioScenario=DEFAULT,
       areaCode=GLOBAL, autoRegisterAgoraExtensions=true })
  -> Bind Event to OnJoinChannelSuccess -> Custom Event OnAgoraJoined -> Print
  -> Bind Event to OnError              -> Custom Event OnAgoraError  -> Print
  -> Bind Event to OnUserJoined         -> Custom Event OnAgoraPeerJoined -> Print
  -> Bind Event to OnLeaveChannel       -> Custom Event OnAgoraLeft   -> Print
  -> Enable Audio
  -> Join Channel (Token=<…>, ChannelId="Test01", Uid=0)
```

**Lifecycle (`EndPlay`):**

```
Event EndPlay -> Leave Channel -> Release (Sync=true)
```

The lifecycle chain is non-optional. Without it, the second PIE play after a stop crashes with `EXCEPTION_ACCESS_VIOLATION` deep in `agora_rtc_sdk` / `libaosl` — the SDK is a true singleton (per its own API docs: *"only one IRtcEngine instance is supported per app"*) and re-`Initialize` on a half-cleaned-up instance dereferences a null. `Sync=true` blocks the game thread ~50–200 ms during teardown but guarantees full resource release before PIE reaps the BP context.

**One crash diagnosed mid-session:** first `Join Channel` attempted with a token minted for a different channel name than what was passed to the BP node. The SDK didn't return `-110 ERR_INVALID_TOKEN` cleanly — it crashed in native code with the same access-violation signature. Fix was to regenerate the temp token in the Agora console specifically bound to `Test01`. **Lesson for Phase 4:** server-side token minter must always mint per-channel; never reuse a token across channel names even within the same App ID.

**Plugin version revision: v4.5.0 → v4.5.1.** The 2026-05-28 entry pinned v4.5.0 for its explicit UE 5.3/5.4 validation in the upstream release notes. The user actually installed v4.5.1 (downloaded from `/releases` rather than the specific tag link). v4.5.1 startup log:

```
LogAgora: Display: FAgoraPluginModule - StartupModule:
  Agora SDK Version: 4.5.1 Build: 591539  UnrealVersion: UE 5.5.4
```

It initialized, joined, published audio, received remote audio, left, released, and re-initialized cleanly across multiple PIE iterations. The five `LogClass: Error: ... is not initialized properly` warnings on startup (`FUABT_CodecCapLevels`, `FUABT_MixedAudioStream`, `FUABT_LocalAudioMixerConfiguration`) are pre-existing reflection bugs in the plugin source with no runtime impact. The Python warning about `OnAudioDeviceStateChanged` name collision with UE's built-in AudioMixer module is also cosmetic.

Decision: pin v4.5.1 going forward (`README.md` + `VR_Project/Plugins/README.md` updated to match). The v4.5.0 references in the 2026-05-28 entry stay as the historical record of what was decided at that time.

**Validation:** stop-and-restart PIE 5x in a row, no crash, fresh `Initialize 0` → `Joined channel=Test01 uid=<n>` → `LEFT channel` each iteration. Browser side correctly sees the trainee join and leave each cycle.

**Next concrete step:** deploy the same APK to Quest 3 with the canonical UAT command (`.cursorrules §8.2`), bump the BeginPlay `Delay` from 0.1s → 0.5s first (Android permission dialog needs settle time on cold first launch), then repeat the round-trip on-headset. After Quest verification, Phase 2 is fully complete and Phase 3 (video pump) begins.

### 2026-06-01 — Phase 2 on-headset verification complete

Deployed the Phase 2 BP via the canonical UAT command (`.cursorrules §8.2`) to the connected Quest 3. Full pipeline timing: BuildCookRun `~57 minutes total` (first cold build with the new C++ module — UBT compiled the project module + 24 Agora extension `.so` files for `arm64-v8a` from scratch). Subsequent warm rebuilds are expected at the previously-recorded `~85 s` baseline once DDC is populated.

**One auto-recovered deploy hiccup:** first `adb install -r` failed with `INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package com.Thomas.VRProject signatures do not match newer version`. The previous on-device APK was signed with a different debug certificate than the one the current build chain produced (likely a different machine or a wiped keystore in the interim). UAT auto-retried with a clean `adb install` (no `-r`), which uninstalls first and reinstalls fresh — succeeded immediately. Worth knowing this is automatic and harmless; no manual `adb uninstall` step is required.

**On-headset test results:**

1. **First cold launch after install — partial failure (mic publish silent):**
   - Quest displayed Android RECORD_AUDIO permission dialog.
   - BP `Delay` was set to **`0.1 s`** (not the 0.5s recommendation), so `Initialize` fired before the user had even seen the dialog, let alone tapped Allow.
   - Network-level join succeeded: green `Joined channel=Test01 uid=<n>` printed (visible via in-game `Print to Screen`).
   - But the SDK's mic capture path silently failed because RECORD_AUDIO was not yet granted when `EnableAudio` attempted to open the device.
   - Symptom: phone browser (peer) could not hear the Quest, even though the Quest was in the channel.

2. **Close-and-relaunch from app library — full success:**
   - Killed the running app via the Quest's universal menu, relaunched from app library (no reinstall — preserved the now-granted permission state).
   - Android skipped the permission dialog (already granted from step 1).
   - Mic was available the instant the SDK initialized; the 0.1s delay no longer mattered.
   - **Bidirectional audio confirmed:** Quest mic audible on phone browser, phone mic audible through Quest speakers, no artifacts, no perceptible latency issues (subjective — not yet measured against the §6 budget of ≤ 400 ms glass-to-glass).

**Permanent fix queued in backlog:** bump BP `Delay` from `0.1 s` to `0.5 s` (or `1.0 s` for cushion against permission-dialog render latency on fresh installs). This eliminates the cold-launch race so the first-launch-after-install also publishes audio without requiring the close-and-relaunch workaround. Not blocking for development iteration (any further deploys reuse the granted permission), but mandatory before any production release or any CI install scenario.

**Build environment notes from this run (both harmless):**

- `Visual Studio 2022 compiler version 14.44.35222 is not a preferred version. Please use the latest preferred version 14.38.33130` — UE 5.5 prefers MSVC 14.38, the dev machine has 14.44. Build succeeded anyway. If we ever care about silencing this, install the 14.38 toolset via VS Installer (Modify → Individual components → "MSVC v143 - VS 2022 C++ x64/x86 build tools (14.38)"). Not currently worth the time.
- `UnrealTrace: Failed to start server; ExitCode=12293` — Unreal Insights trace server collision (another instance already running). Doesn't affect build or runtime. Ignore.

**Phase 2 is now closed.** All four event handler binds fire as expected on real hardware, the lifecycle (join / publish / subscribe / leave / release) is clean, and the credentials we baked into the BP (App ID + per-channel `Test01` token) are validated. Phase 3 begins next: push `RT_InstructorStream` as an Agora custom video source so the instructor sees the trainee POV.

### 2026-06-01 — Phase 3 C++ video pump scaffolded

Audited the Agora plugin v4.5.1 Blueprint surface and confirmed `pushVideoFrame` and `setExternalVideoSource` are **not** BP-exposed — they live only in the native `agora::media::IMediaEngine` interface (`Plugins/AgoraPlugin/.../include/IAgoraMediaEngine.h`). Verified the UE singleton wrapper `agora::rtc::ue::AgoraUERtcEngine::Get()` exposes `queryInterface(AGORA_IID_MEDIA_ENGINE, ...)`, which is the supported way to obtain the media-engine pointer from the plugin-owned singleton. Verified `agora::media::base::ExternalVideoFrame` field layout (`type`/`format`/`buffer`/`stride`/`height`/`timestamp` are the only fields we set; everything else defaults via its constructor).

**Implementation — `UAgoraVideoPump : UActorComponent` (~200 LOC of C++):**

- `VR_Project/Source/VR_Project/VR_Project.Build.cs` — added `"AgoraPlugin", "RenderCore", "RHI"` to `PrivateDependencyModuleNames`.
- `VR_Project/Source/VR_Project/AgoraVideoPump.h` — `UCLASS(BlueprintSpawnableComponent)` with `SourceRT` (TObjectPtr<UTextureRenderTarget2D>), `PumpIntervalSeconds` (defaults to 1/30 s = 33.33 ms per §1.3), and BP-callable `StartVideoPump` / `StopVideoPump`. Header takes zero Agora SDK includes — the cached `IMediaEngine*` is held as `void*` so downstream BPs and engine reflection have no transitive Agora dependency.
- `VR_Project/Source/VR_Project/AgoraVideoPump.cpp` — `StartVideoPump` resolves the media engine via `queryInterface(AGORA_IID_MEDIA_ENGINE, ...)`, calls `setExternalVideoSource(true, false, VIDEO_FRAME)`, and starts a looping `FTimerHandle`. Each timer tick calls `PumpFrame`, which captures a millisecond timestamp on the game thread and then `ENQUEUE_RENDER_COMMAND`s a render-thread lambda that does `FRHICommandListImmediate::ReadSurfaceData` into a reused `TArray<FColor>` (no per-frame alloc) and calls `IMediaEngine::pushVideoFrame()`. Pixel format is `VIDEO_PIXEL_BGRA` to match UE's `FColor` in-memory byte order on both DX (Windows) and Vulkan B8G8R8A8 (Quest mobile-forward). `StopVideoPump` clears the timer, disables the external source, and `FlushRenderingCommands()` to drain any in-flight lambda before the component is torn down (the lambdas capture `this` raw, so the flush is the safety boundary).

**Why no `FRHIGPUTextureReadback` (async path) yet:** the synchronous `ReadSurfaceData` on the render thread is ~1–2 ms at 1280×720 RGBA8 on Adreno 740, well inside §6's 4 ms video-capture budget. Adding async readback now would cost a frame of latency for no measurable budget win. The .cpp documents this as the upgrade path if profiling shows the cost is actually higher.

**Pending Blueprint wiring on `VRPawn`** (no code changes from here on — pure BP):

1. Add `Agora Video Pump` component to `VRPawn`.
2. Set `Source RT` = `RT_InstructorStream` in the component's details panel.
3. Add `Enable Video` BP node to the BeginPlay chain — place it between the existing `Enable Audio` and `Join Channel` nodes.
4. After `Join Channel` (or — safer — wired off the existing `OnJoinChannelSuccess` event), call the component's `Start Video Pump` function. EndPlay teardown is automatic: the component's own `EndPlay` calls `StopVideoPump`, which runs before the BP's existing `Leave Channel → Release` chain (component EndPlay fires before actor-level BP EndPlay event).

**Pending first compile.** Project hasn't been rebuilt against the new source files yet — first attempt should be a `Build Solution` from the .sln, not a hot reload, so the new `AgoraVideoPump.generated.h` is produced by UHT before the .cpp tries to consume it.

### 2026-06-01 — Phase 3 PIE green-frame debug session and root cause

After the C++ pump compiled and the BP wiring landed (`AgoraVideoPump` component on `VRPawn` with `SourceRT=RT_InstructorStream`, `Enable Video` added between `Enable Audio` and `Join Channel`, `Start Video Pump` wired off `OnJoinChannelSuccess`), both PIE and a Quest build joined the channel cleanly but the web demo's video pane showed a **uniform solid color** (green in PIE, black on Quest). Audio remained perfect bidirectionally throughout — the regression was purely on the video path.

Initial hypothesis (`RHICmdList.ReadSurfaceData` not transitioning RT out of RTV state) led to a rewrite swapping the render-thread enqueue for a synchronous `FTextureRenderTargetResource::ReadPixels()` call on the game thread. This did not fix the green frame — both code paths produced the same symptom. (Both APIs ultimately call into the same RHI readback; the "transition" theory was wrong for our format.)

Adding instrumentation to the pump (1 Hz log lines reporting `ReadPixels` return value, buffer size, and three sample pixel values) and then a follow-up `pushVideoFrame ret=N` log line was the breakthrough. Three runs of PIE with the diagnostic build revealed:

1. `ReadPixels=1` (success) every tick, buffer correctly sized at 921600 pixels.
2. Pixel values were **valid, varied, fresh scene content** — e.g. `P0=(B95, G64, R48)` brown, `Pmid=(B116, G84, R67)` tan — changing frame-to-frame as the player moved their head in VR preview.
3. `pushVideoFrame ret=0` on every push — the Agora SDK was accepting every frame without complaint.

So our entire client-side pipeline was provably healthy. The receiver still saw green. Conclusion: the SDK was accepting frames into its queue but silently **dropping them at the publish stage**.

**Root cause:** the Agora SDK's `ChannelMediaOptions::publishCustomVideoTrack` field defaults to `false`. The basic `Join Channel` BP node uses default media options and only enables `publishMicrophoneTrack` automatically. Even with `setExternalVideoSource(true, false, VIDEO_FRAME)` called and `pushVideoFrame` returning success, the publisher silently discards everything because there is no published custom video track on the connection. The web demo allocates a video element (we *are* publishing — just nothing visual) and shows green as its codec's "no frames received" fallback.

**Fix (pure Blueprint, no code change):** in the `OnJoinChannelSuccess` event chain on `VRPawn`, insert an `Update Channel Media Options` BP node before `Start Video Pump`. Split its `Options` struct pin and set:

- `Publish Custom Video Track Value` = `AGORA TRUE VALUE` *(critical)*
- `Publish Camera Track Value` = `AGORA FALSE VALUE` *(recommended — explicit "we have no camera")*
- Everything else left at `AGORA NULL VALUE` (= "don't change this option") or its existing value.

The plugin's `FUABT_Opt_bool` exposes a clean 3-state enum: `NULL` (don't update), `TRUE` (set on), `FALSE` (set off). Only fields explicitly set to a non-NULL value are applied. Confirmed working immediately after this single BP edit — web demo showed real scene content in PIE.

**Key lesson for future Agora work** (worth pinning to `.cursorrules` when Phase 4 lands): any time you push custom audio or custom video via `pushAudioFrame` / `pushVideoFrame`, you MUST also flip the corresponding `publishCustom*Track` flag in `ChannelMediaOptions` via `Update Channel Media Options` or by joining with explicit options. `pushVideoFrame ret=0` does not mean "the frame was sent"; it only means "the frame was queued in the SDK". The publisher decides what to actually broadcast.

**Diagnostic logging is still in `AgoraVideoPump.cpp`** — three log sites marked `[DIAGNOSTIC — remove after Phase 3 green-frame issue is resolved]`: the `StartVideoPump DIAG` line dumping RT identity, `PumpFrame DIAG: ReadPixels` 1 Hz pixel sampler, and `PumpFrame DIAG: pushVideoFrame ret` 1 Hz return-value sampler. Total overhead is six log lines per second; safe to leave in the Quest build that's currently cooking. Cleanup is a follow-up task once Quest verification is signed off.

### 2026-06-01 — Phase 3 Quest build verification (in flight)

UAT build kicked off ~15:43 with the canonical `.cursorrules §8.2` command. First compile of `AgoraVideoPump.cpp` for both Win64 and arm64 passed cleanly. Cook phase started without errors. Estimated total wall time ~6 min based on the previous build. Result will be visible in the next session as a completed background task in the terminals folder. Pass criterion: web demo on phone hotspot shows real scene content in the video pane once the Quest deploys and joins the channel — same outcome as PIE, just on Vulkan/arm64 instead of DX12.

### 2026-06-03 — Phase 3 polish (perf + color) consolidated

Consolidates two batches of work that were not committed at the time they were performed:

**(A) 2026-06-02 — perf pass, executed on a secondary workstation, never pushed.** Three changes landed locally on the other PC and propagated back via repo sync today. None of them were captured in the Devlog at the time.

1. **`UAgoraVideoPump::PumpFrame` rewritten from synchronous `ReadSurfaceData` / `ReadPixels` to asynchronous `FRHIGPUTextureReadback`.** The 2026-06-01 third entry called this out as the planned upgrade path "if profiling shows the cost is actually higher" — Quest profiling confirmed exactly that. The synchronous readback was internally calling `FlushRenderingCommands`, stalling the game thread ~2–3 ms per tick (≈6–9% of game-thread budget at 30 Hz). The new path enqueues `EnqueueCopy` on the render thread and harvests last tick's already-completed staging buffer via `Lock`/`Unlock` on the next tick. Trade-off: ~1 pump tick (~33 ms) of added latency for zero game-thread stall — well inside the §6 ≤ 400 ms glass-to-glass budget. Single-buffered with a `bReadbackInFlight` guard to skip ticks where the GPU hasn't finished yet (rare at 30 Hz on Adreno 740).
2. **SceneCapture timer interval `0.00333` → `0.0333` in `VRPawn`.** The 2026-06-01 third entry flagged this as a 10× over-capture (300 Hz where the spec says 30 Hz). Fixed in BP. Combined with (1), Quest frame-rate spikes are gone.
3. **Diagnostic logging removed from `AgoraVideoPump.cpp`.** Three `[DIAGNOSTIC — remove after Phase 3 green-frame issue is resolved]` sites from the green-frame debug session are deleted. The pump now emits only `StartVideoPump`/`StopVideoPump` lifecycle lines + one `Error` line if the media engine fails to resolve.

**(B) 2026-06-03 — dark-receiver color fix, this session.** Symptom was "stream looks fine in headset but very dark in the browser." Critical disambiguator from the user: rendering `RT_InstructorStream` onto a Plane via `M_RTStreamDebug` in-world looked perceptually correct in VR. That ruled out exposure, capture-source mode, and scene lighting — the SceneCapture was writing correct color into the RT. The problem was strictly in the bytes handed to Agora.

Root cause: **linear-vs-sRGB encoding mismatch on the readback path.** On mobile + `r.MobileHDR=False`, `Capture Source = Final Color (LDR) in RGB` writes linear color into the RT (it captures before the hardware sRGB encode that the main view's framebuffer gets via `r.Mobile.UseHWsRGBEncoding=True`). The material path round-trips through `Sampler Type = Color` which decodes sRGB → linear on sample, so two "wrong" steps cancel and the plane looks correct. But `FRHIGPUTextureReadback::Lock` returns the raw stored bytes with no decode — those linear bytes go to `pushVideoFrame`, the H.264 encoder treats them as sRGB-encoded (standard video convention), and the browser displays linear `0.5` as if it were sRGB-encoded `0.5` → ≈2.4× darker than intended. Exactly the symptom.

Fix: flipped `RT_InstructorStream` Render Target Format from `RTF_RGBA8` to **`RTF_RGBA8_SRGB`**. The SceneCapture now writes sRGB-encoded bytes directly; raw readback produces correct bytes for the H.264 encoder; the browser shows correctly-exposed scene content. Zero C++ change, zero runtime cost (the GPU does the encode on store for free). Validated in PIE → Agora web demo immediately after the flip.

**Why the level-wide Post Process Volume approach (proposed 2026-06-01) was not viable.** Mobile forward renderer with `r.MobileHDR=False` strips out the screen-space post passes a PPV would normally target (bloom, AO, tonemapper, eye adaptation) — dropping a PPV in the level had no measurable effect on capture brightness. The fallback path investigated this session would have been a per-pixel sRGB encode loop in `PumpFrame` (cheap LUT, ~0.3–0.6 ms on a Quest game thread), but the RT format flip made it unnecessary.

**Key lesson for future RT → Agora work** (worth pinning to `.cursorrules` alongside the 2026-06-01 `publishCustomVideoTrack` lesson): when pushing pixel buffers to Agora via `pushVideoFrame`, the RT must hold **sRGB-encoded bytes** (`RTF_RGBA8_SRGB` or equivalent), not linear. Material samplers hide this asymmetry because they auto-decode on sample; raw readback exposes it.

**Net state of Phase 3 after these three batches:** end-to-end stream is correctly exposed, runs at the spec'd 30 Hz, has no game-thread readback stall, and contains no leftover diagnostic noise. Pending: fresh Quest verification of the polished build (the 2026-06-01 in-flight build is obsolete — it pre-dates all three polish items).

### 2026-06-03 — Phase 3 Quest verification (PASSED) + Web_Dashboard introduction

**Quest verification of the polished build — passed on hardware.** Fresh UAT BuildCookRun (`.cursorrules §8.2`) deployed to Quest 3. All three Phase 3 polish items confirmed on Vulkan/arm64:

- Correct exposure on the receiver — `RTF_RGBA8_SRGB` honored on Vulkan; browser side matches what the headset wearer sees.
- Stable 30 fps under head movement — `0.0333` SceneCapture timer + async `FRHIGPUTextureReadback` hold up on Adreno 740.
- Bidirectional audio still functional — no regression from the perf/color changes.

**Phase 3 is now fully closed.**

**Clean-rebuild gotcha worth pinning to operational memory.** The first UAT attempt of the session failed in 80 s with 20 `redefinition of …` errors in `GenericPlatform.h` during the arm64 compile of `AgoraVideoPump.gen.cpp`. Diagnosis: stale `Intermediate/` from the 2026-06-01 in-flight build. That earlier build was using a *different* `AgoraVideoPump.cpp` (synchronous `ReadPixels`) AND a *different* `.Build.cs` (no `AgoraPlugin`/`RenderCore`/`RHI` deps). UBT reused the cached UHT-generated `.gen.cpp` + PCHs against today's polished code, ending up with two non-canonicalised paths for the same engine header (mixed forward/backslash in `Runtime\Core\Public/GenericPlatform/GenericPlatform.h`), which defeats `#pragma once`.

Cure per `.cursorrules §8.4`: `rmdir /s /q` of `Binaries/`, `Intermediate/`, `Build/`, `Saved/StagedBuilds/`. (`Intermediate/Android/...` hit the Windows MAX_PATH limit and needed the `robocopy /MIR <empty>` trick to delete — standard Windows long-path workaround.) Cold rebuild after clean succeeded in **5 m 44 s**.

**Lesson:** any time a `.cpp` is structurally rewritten (sync → async, etc.) AND `.Build.cs` deps change in the same session — especially if either change happened on a different workstation that this PC never ran a cold cook against — force a clean of `Intermediate/` before the next BuildCookRun. Live Coding hot-reload would have caught the include-path issue earlier; cold cooks bypass that signal.

**Web_Dashboard introduction — first piece of Phase 4 lands.** New top-level `Web_Dashboard/` folder with two coexisting operating modes:

- **Mode A — Step 1 static MVP receiver.** Single-page vanilla JS + Agora Web SDK v4.20.0 from CDN. Two-column layout (`.stream-view` left, `.control-deck` right) so the Phase 5 command deck slots into the right panel without restructuring the markup. Form-based credentials (App ID + channel + token) persist to `localStorage`. CSS design tokens isolated in `public/css/tokens.css`. No build step; serve `public/` with `npx serve` or `python -m http.server`. Self-hosted replacement for `https://webdemo.agora.io/basicVideoCall/`.

- **Mode B — Phase 4 server scaffold.** `server.js` (Express + Socket.IO entry, kept thin per §4.3) + `src/agora.js` + `src/pairing.js` + `src/commands.js` + `docs/commands.md`. Deps: `express` ^5.2, `socket.io` ^4.8, `agora-token` ^2.0, `dotenv` ^17.4. Implements:
  - `getAgoraCredentials(tenantId)` indirection — single seam for the future multi-tenant credential split (§4.3.1).
  - `mintToken({ tenantId, channel, uid, role })` — 30-min default TTL, per-channel binding (the 2026-06-01 token-mismatch crash lesson), usage row per issuance to stdout.
  - `channelNameFor(tenantId, code)` — centralises the canonical `t-<tenantId>-<pairingCode>` naming so neither client nor BP ever hand-builds the string.
  - In-memory `ROOMS` registry keyed by 4-digit code, handles `headset:register` / `instructor:join` / `disconnect` lifecycle, broadcasts `session:status` (`waiting` | `connected` | `reconnecting`).
  - `POST /api/token` endpoint gated on a registered pairing code (closes the "any rando mints a token for any channel" hole).
  - `instructor:command` → `headset:command` relay with full §5.2 schema validation; unknown / malformed payloads dropped + logged, never forwarded.

  **Server scaffolded but not yet wired to the SPA.** The static MVP still uses the manual token-paste flow. Wiring the SPA to the server (replace the manual token field with a 4-digit code field that calls `/api/token` after `instructor:join`) is the next discrete unit of work.

- **Step 1.5 — bidirectional voice on the MVP.** Closes the `.cursorrules §1.3` "bi-directional voice" requirement. Browser publishes the instructor's mic via `AgoraRTC.createMicrophoneAudioTrack({ AEC, ANS, AGC })` + `client.publish()`. Three live controls added under the video per §2.B.3: mic mute (toggles `micTrack.setEnabled`), speaker mute (sets remote audio volume to 0; preserves slider position), volume slider (0–100, scales remote audio track via `setVolume`). Graceful degradation: if mic permission is denied or no input device exists, the join still succeeds, video + receive-audio still work, mic button shows "Mic unavailable" disabled. Verified on hardware: trainee in Quest 3 hears instructor through Quest speakers, instructor hears trainee through laptop speakers, both directions clean.

**Browser secure-context note.** `getUserMedia()` (the mic request) only works on `https://` or `http://localhost`. Serving the page from a LAN IP without HTTPS will reject the mic request. Phase 4 will need to either tunnel via HTTPS or document the localhost-only constraint for the v1 instructor workflow.

### 2026-06-03 — Phase 4.5: OneBonsai multi-session grid + session faker

Landed the OneBonsai-branded grid view, the session-faker tool, and the server endpoints that connect them. The instructor dashboard is no longer a single-session SPA — it's a tenant-scoped grid with click-to-focus + command deck. The legacy single-session view is preserved at `/single.html` as a known-good debug fallback.

**Why now.** Conceptual discussion converged on "we sell to a company (e.g., Securitas), they monitor all their active VR sessions in a grid, click into one to command it." OneBonsai is the dogfood tenant. To test that UX with one Quest + one Pico, we need synthetic publishers — the faker tool — to populate the grid alongside real headsets. All three pieces shipped this session.

**Server additions (`Web_Dashboard/`).**

- `GET /api/config` — safe-to-expose client config (`appId`, `defaultTenantId`). One source of truth; clients stop baking values into HTML.
- `GET /api/sessions?tenantId=X&page=N&pageSize=M` — paginated tenant-scoped session discovery. Initial page-load entry point.
- Socket.IO `instructor:subscribe-tenant { tenantId }` — grid-view instructors land here instead of the 1:1 `instructor:join`. Acks with the initial session list, then receives live `sessions:changed` broadcasts on every headset register/disconnect.
- Socket.IO `sessions:changed { tenantId, sessions }` — tenant-scoped fan-out. Each instructor socket joins `tenant:<id>:instructors` and receives only its own tenant's updates.
- `headset:register` extended with optional `scenario`, `traineeName`, `source` fields. Stored in `ROOMS` along with a `startedAt` unix-ms timestamp so the grid tile can show session duration.
- `instructor:command` extended with optional `code` field — grid-view instructors target a specific session per command instead of being pinned 1:1 to a room. Server enforces tenant scope (cross-tenant commands rejected). Legacy 1:1 path still works without `code`.
- `DEFAULT_TENANT_ID` in `.env.example` changed `default` → `onebonsai`.

**Faker tool (`public/faker.html` + `js/faker.js`).** New page that lets us populate the grid with synthetic VR sessions. Each faker:

1. Connects to the Phase 4 Socket.IO server.
2. Emits `headset:register { code, tenantId, scenario, traineeName, source:'faker' }`.
3. `POST /api/token` for a publisher token.
4. Generates an animated procedural video on an HTML canvas — deterministic hue per code, drifting gradient, moving horizon line, bouncing dot, scenario/trainee/code overlay, live timer.
5. Publishes via `AgoraRTC.createCustomVideoTrack({ mediaStreamTrack: canvas.captureStream(24) })` — no webcam permission, fully procedural.
6. Listens for `headset:command` and renders a yellow command-received overlay (2.5 s) plus a sticky "PAUSED" overlay when `pause_simulation:true` — verifies the command round-trip end-to-end.

Launcher mode at `/faker.html?spawn=N` opens N popups with pre-canned OneBonsai scenarios (Fire Training / Forklift Sim / Confined Space Rescue / Electrical Lockout / Fall Arrest Drill / Hazmat Response / Confined Crane Op / Welding Safety). Closing a popup drops that session from the grid — exactly as a real headset would.

**Stub mode.** Faker checkbox "register session metadata but don't publish video." Use when a real Quest or Pico is the actual video source on a code: the stub keeps a Socket.IO connection alive (so the grid sees the session in the registry), but skips Agora; the real headset is the sole publisher on that channel. When stub mode is selected, the registered `source` is `'headset'` so the grid pill says LIVE not FAKER. Closing the stub tab prunes the room, matching real-headset lifecycle.

**Grid view client (`public/index.html` + `js/grid.js`).** Two modes coexist in one page:

- **Grid mode (default):** 3×2 CSS Grid of tiles, paginated when sessions > 6. Header shows "OneBonsai — Live Training Sessions" + session count + Prev/Page N of M/Next controls + "Spawn demo sessions" shortcut + link to the debug view. Each tile is a self-contained Agora client subscribed to its session's channel (video only, no audio in grid mode). Tile shows scenario + trainee name + status + LIVE/FAKER pill. Click or Enter/Space focuses a tile.
- **Focus mode:** clicked tile expands to fill the stage, side panel reveals the §5.2 command deck (Pause / Resume / Reset Position / Change Environment with map-name input / Trigger Event with event-type input). Audio is subscribed in focus mode + instructor mic is published (best-effort, falls back to receive-only if denied). Speaker toggle, mic toggle, volume slider all wired. Per-command ACK feedback in a rolling log. Back-to-grid restores the grid view and re-subscribes its tiles.
- **Subscribe-only-visible:** entering focus mode tears down ALL grid tile clients (frees bandwidth + CPU for the focused stream + avoids browser background-pause behavior). Exiting focus mode re-subscribes the current page's tiles fresh.

Backed up the previous single-session SPA as `/single.html` (loads `js/single.js`) with a "→ grid view" link in its header for navigation. Anyone still using the manual-token paste flow finds it intact.

**Demo flow (~2 minutes, validated locally).** `npm run dev` → open `/` → header shows `Live · tenant onebonsai` → click "Spawn demo sessions" → 5 popups appear and register, grid populates within ~2 s → click a tile → focus mode + command deck → click "Pause simulation" → faker overlays PAUSED, command log line shows `→ pause_simulation (code XXXX)` → Resume → Back to grid. End-to-end signaling + token mint + multi-publisher Agora subscription + command relay all exercised in one click sequence.

**Getting real Quest / Pico builds into the OneBonsai grid.** Stub mode is the bridge until proper Phase 4 headset wiring lands. Recipe (per device):

1. **Pick a 4-digit code per device.** E.g. `1111` for Quest, `2222` for Pico. Keep them disjoint.
2. **Generate a temp token** in <https://console.agora.io> > Project Management > the project > Generate Token > channel name `t-onebonsai-1111` (or `-2222`), TTL 24 h, no UID restriction. Note the token string.
3. **Open `BP_VRPawn` in UE.** Find the `Join Channel` node at the tail of the BeginPlay chain (per the 2026-06-01 entry). Update:
   - `ChannelId` literal from `Test01` → `t-onebonsai-1111` (or `-2222`).
   - `Token` literal → the new token from step 2.
4. **Cook + deploy.** `.cursorrules §8.2` UAT command unchanged. For per-device builds, the BP edit happens once per cook — there's no parametrisation yet. (Adding command-line parameter support is the path to a single-APK multi-device build; deferred for now.)
5. **On the dashboard PC.** Start `npm run dev`. Open `http://localhost:3000`. Open `/faker.html`, tick "Stub mode", enter:
   - Tenant ID: `onebonsai`
   - Code: `1111` (matching the Quest's hardcoded channel suffix)
   - Scenario: e.g. "Fire Training"
   - Trainee: e.g. "Demo — Quest 3"
   Click Start. The status reads `Stub for code 1111 — real headset publishes the video`. The grid now shows a LIVE-pilled tile for that code, awaiting video.
6. **Launch the Quest app.** It publishes to `t-onebonsai-1111`; the grid tile picks up the video stream. Repeat the stub-mode step in another tab for the Pico's code `2222`.
7. **Stretch goal (separate session): BP `headset:command` handler.** Bind an Agora-channel-message-equivalent event in the BP to consume the four §5.2 commands and act on them (toggle a global pause var on `pause_simulation`, etc.). Currently the round-trip ends server-side: the relay fires successfully (visible in the command log + server stdout), but the BP has no listener yet. The faker has a listener as a reference implementation; replicating it in BP is straightforward once the UE Socket.IO plugin is installed.

**Pico 4 Enterprise sideload notes.** The existing Quest APK (`VR_Project/Build/Android_ASTC/*.apk`) may install directly on a Pico 4 Enterprise in Developer Mode via `adb install -r <apk>`. Most enterprise Pico devices honor the install regardless of the Meta-specific `<meta-data android:name="com.oculus.supportedDevices" />` baked in by `bPackageForMetaQuest=True` in `Config/DefaultEngine.ini`. If the install is refused, the cleanest fix is to flip `bPackageForMetaQuest=False` and strip the `ExtraApplicationSettings` line in a per-platform `Config/Android/AndroidEngine.ini` override (UE's standard pattern), then re-cook a Pico-specific APK. Runtime cross-platform parity should "just work" via OpenXR — the controllers, head tracking, and standard XR action set are identical between Meta and Pico's OpenXR runtimes. Hand-tracking is the one feature that uses a vendor-specific OpenXR extension and may need the corresponding Pico plugin enabled in `.uproject` if hands are used; controllers-only flows are unaffected.

**Net state.** The OneBonsai grid view is fully testable today with the faker. With per-device BP edits + stub-mode bridges, both real headsets join the grid as additional LIVE tiles. Phase 5 BP command handlers + full Socket.IO subsystem remain on the backlog as the architecturally-clean follow-up.

### 2026-06-03 — Phase 4.5 Quest verification (PASSED) + faker CSS layout fix

Real Quest 3 successfully joined the OneBonsai grid as a tile alongside web-fakers. End-to-end validation of the multi-session pipeline with a real VR app.

**Recipe used (per the Phase 4.5 entry's stub-mode bridge plan).**

1. **Agora console:** generated a 24 h temp token bound to channel `t-onebonsai-1111` (channel name follows the canonical `t-<tenantId>-<pairingCode>` convention so the server's `/api/token` mints with the same string when the dashboard later subscribes).
2. **`BP_VRPawn` edits:** in the `Join Channel` node at the tail of BeginPlay — `ChannelId` literal `Test01` → `t-onebonsai-1111`, `Token` literal replaced with the fresh string. Compile + save.
3. **Pre-deploy BP polish:** bumped the early `Delay` node `Duration` from `0.1` → `0.5` s (the previously-deferred fix from the 2026-06-01 on-headset permission-race entry — relevant because this was a fresh-install scenario with a renamed channel + token rather than an `adb install -r` update).
4. **UAT BuildCookRun:** canonical `.cursorrules §8.2` command. Cold cook (Intermediate had been touched since the last Phase 3 verification build) — total wall time 8 m 49 s. APK packaged, archived to `Build/Android_ASTC/`, `adb install` succeeded, `adb shell am start` launched the app, UAT tailed logcat as designed.
5. **Dashboard side:** opened `/faker.html`, ticked **Stub mode**, entered tenant `onebonsai` + code `1111` + scenario "Fire Training" + trainee "Demo — Quest 3", clicked Start. Faker registered via `headset:register` with `source: 'headset'` (the stub-mode override), the grid tile appeared immediately labeled correctly with the LIVE pill.
6. **Headset wake-up:** within ~2-3 s of putting on the Quest, the tile's status flipped from "Waiting for video" → "Live" and started showing the trainee POV. End-to-end pipeline confirmed:
   - Real headset publishing to Agora SD-RTN ✓
   - Server's `/api/token` minting a subscriber token bound to the same `t-onebonsai-1111` channel ✓
   - Grid's per-tile Agora client subscribing and rendering the video ✓
   - Stub mode correctly providing only the session metadata while the Quest provides the video ✓
   - 0.5 s `Delay` eliminated the cold-launch permission race (no `EXCEPTION_ACCESS_VIOLATION` in logcat, no muted audio symptom) ✓

**UAT gotcha encountered + resolved.** First build attempt aborted in 7 s with `Unable to build while Live Coding is active. Exit the editor and game, or press Ctrl+Alt+F11 if iterating on code in the editor or game`. Cause: the UE editor was still open from the BP edits. Live Coding holds the build artifacts locked, blocking UAT from relinking. Resolution: closed the editor entirely — also freed ~6 GB of RAM and made the subsequent cook noticeably faster. Worth pinning to operational memory: **after any BP edit cycle, close the editor before invoking UAT.** Pressing Ctrl+Alt+F11 in the editor to toggle Live Coding off is the lighter alternative when the editor needs to stay open.

**Faker page CSS layout fix.** The stub-mode checkbox row on `/faker.html` was visibly broken — the checkbox rendered as a full-width styled rectangle and the description text was squeezed into a narrow column on the right. Root cause: the `.field input, .field textarea { width: 100%; padding:...; background:...; border:...; }` rule from the form-element styling was matching the stub-mode checkbox (which lives inside a `.field--inline` label), turning it into a giant form-field-shaped block. Fix: added an explicit reset block scoped to `.field--inline input[type="checkbox"]` (`width: auto; padding: 0; background: none; border: none; border-radius: 0; accent-color: var(--color-accent)`) plus a `.field--inline span { flex: 1 1 auto; min-width: 0 }` so the description fills the remaining horizontal space. Verified by hard-refresh on the running faker page — checkbox renders as a normal small square, description text flows alongside.

**Lesson (worth pinning).** Sub-modifier classes that change a parent's flex direction (`.field` column → `.field--inline` row) need to also defensively reset child-element styles the parent established for the previous direction. Putting a checkbox inside a label class designed for text inputs is a common pattern that needs explicit unstyling.

### 2026-06-03 — Phase 4.5 Pico 4E sideload attempt (PARKED — empirical 2D-fallback finding)

Followed up the Quest verification by attempting to sideload the same APK onto a Pico 4 Enterprise (PUI 5 / Android 10 / API 29, manufacturer:Pico model:A8110, abi:arm64-v8a). Two distinct obstacles surfaced, the second of which is the genuinely interesting one.

**Obstacle 1: `INSTALL_FAILED_OLDER_SDK`.** `adb install -g` rejected the Quest APK because the manifest declared `minSdkVersion=32` (Android 12L) but Pico runs API 29. Root cause: `bPackageForMetaQuest=True` in `Config/DefaultEngine.ini` enforces Meta's current store spec of minSdk 32+ at build time. Workaround applied: temporarily lowered `MinSDKVersion=32 → 29` and set `bPackageForMetaQuest=False`. Rebuilt + redeployed via UAT (`-deploy -device=PA8E50MGH1110583D`, ~2-3 min — incremental cook, manifest-only change). APK installed cleanly on Pico (`adb.exe ExitCode=0`).

**Obstacle 2 (the real one): app runs on Pico but in 2D, not in VR.** Launched via `adb shell am start -n com.Thomas.VRProject/com.epicgames.unreal.GameActivity`, pre-granted `RECORD_AUDIO`. Pico screenshot (sent by user) shows the UE template scene rendered as a curved 2D Android panel inside the Pico's home environment — Pico's controller laser ray visible, Pico's "earth-in-space" home background bleeding around the panel. Classic OpenXR-runtime-not-bound symptom.

**Root cause (confirmed by analysis, not yet by logcat).** The UE build uses Meta's `OculusOpenXRLoader` (bundled by the OculusXR/MetaXR plugin). That loader is hardcoded to look for **Meta's** OpenXR runtime — it doesn't probe the Android system for vendor-alternative OpenXR runtimes. On the Pico:

- Pico ships its own OpenXR runtime (system-level since PUI 5+).
- Meta's loader doesn't find Meta's runtime → falls back silently to no-XR.
- UE's XR system initializes to "no XR" → app boots as a normal Android Activity.
- Pico's OS sees a non-VR Android app → composites it as a 2D panel in the home environment.

The clean failure mode (no crash, no FATAL in logcat, no Vulkan errors) supports this diagnosis cleanly. APK install + Android plumbing + arm64 binary + rendering pipeline are all fine — only the XR handshake fails.

**Decision: parked.** The OneBonsai grid-view demo target is fully covered by the Quest path (validated in the previous entry). Pico parity is real cross-platform work that doesn't fit a config-flag flip. Reverted `MinSDKVersion` and `bPackageForMetaQuest` back to their Meta-store-compliant values so the current Quest build path stays clean. The Pico's APK install + ini changes are not preserved; next Pico work cycle restarts from the same starting point.

**Concrete options recorded for the future Pico work session.**

1. **Swap OculusXR plugin → vanilla Khronos `OpenXR` plugin.** UE's built-in `OpenXR` plugin uses the system's OpenXR loader rather than a vendor-bundled one. Should work on both Quest (Meta runtime) and Pico (Pico runtime) from a single APK. Trade-off: loses Meta-specific extensions (hand tracking, anchors, controller models) and needs Quest re-validation. ~30-45 min plus testing.
2. **Install PICO Unreal Integration SDK + maintain two build flavors.** Each device gets its native runtime + extensions. Largest footprint but production-grade. Use `Config/Android_Multi/` to split the build flavors. ~1-2 hours including SDK download from Pico developer portal.
3. **Pico 4 Enterprise OS update path (PUI 5 → PUI 6/Android 13).** Settings → General → System Update. May require Pico Business Suite enrollment. Even if successful, *won't* solve Obstacle 2 — Meta's loader still won't find Meta's runtime on Pico hardware regardless of PUI version. Only useful if we keep `minSdk=32` and want to install the Quest APK on Pico without rebuilding.

**Things learned worth pinning.**

- `bPackageForMetaQuest=True` is a build-time enforcer, not just a tag. It actively overrides `MinSDKVersion` upward to whatever Meta's current spec requires (currently 32). For Pico-compatible sideload builds, this flag must be off.
- Meta's `OculusOpenXRLoader` and Khronos's vendor-neutral `OpenXR` loader are mutually exclusive. The OculusXR plugin bundles the former and assumes it will be the active loader at runtime — it won't gracefully cede to a system loader if Meta's runtime is missing.
- The Pico's "fall back to 2D panel inside home environment" behavior is a clean failure mode that's easy to misdiagnose as a Pico bug. It's actually Pico's OS doing the right thing with a non-VR Android app. The actual failure is on the UE/Meta-loader side.

### 2026-06-03 — Phase 4 Phase A: USignalingSubsystem live on Quest (PASSED end-to-end)

C++ `UGameInstanceSubsystem` shipped that speaks the dashboard's Socket.IO wire protocol from the headset side. Real Quest 3 boot trace now reads, end-to-end, in logcat: `Initialize: code=1498 ...` → `state -> Connecting` → `SocketIO Connected ...` → `headset:register ack ok` → `POST /api/token` → `200: channel=t-onebonsai-1498 expiresAt=...` → `state -> Live`. The grid view shows the headset tile labeled `Code 1498 — Quest Trainee — Fire Training` without any faker stub, and dashboard usage logs the same channel name. The Phase A goal — *prove the C++ Socket.IO plumbing + the wire protocol on a real device before any BP refactor* — is met.

**Architectural decisions taken (all confirmed against the .cursorrules §4.2 BP-first / C++-only-where-needed rule).**

- **Language: C++ `UGameInstanceSubsystem`**, not a BP-only solution. Reason: state machine + HTTP + async + ack-callback management would be unmaintainable in BP graph form, and the existing AgoraPlugin precedent shows C++ scaffolding is acceptable when the alternative is a multi-page BP nightmare. BP surface is preserved via `UPROPERTY(BlueprintReadOnly)` for the four credentials (AgoraAppId/Channel/Token + State enum) and four `BlueprintAssignable` delegates (OnCredentialsReady, OnTokenRefreshed, OnStateChanged, OnHeadsetCommand). The BP-layer refactor for Phase B reads these via standard "Get Signaling Subsystem" variable reads — no custom BP nodes were added.
- **Plugin: `getnamo/SocketIOClient-Unreal` v2.9.0** (pinned because its `.uplugin` declares `EngineVersion: 5.5` exactly — later v2.10.0 → 5.6, v2.11.0 → 5.7 will compile against 5.5 but generate a marketplace-mismatch warning). MIT-licensed, source-built. Cloned with submodules (`asio`, `rapidjson`, `websocketpp`) into `VR_Project/Plugins/SocketIOClient/`, gitignored per the AgoraPlugin pattern. Install recipe added to `VR_Project/Plugins/README.md`. First cold cook compiles all three bundled C++ libs for both Win64 and Android — adds ~90 s to the cook. Subsequent cooks reuse the built `.a`/`.lib` artifacts.
- **Pairing code: random per cold launch, recalled across hot reconnects.** Code generated once in `Initialize`, retained across socket-drop / reconnect cycles within the same boot. New cold launch → new code. The `[/Script/VR_Project.SignalingSubsystem]` INI section accepts a `PairingCodeOverride=XXXX` for fleet pinning when needed (e.g., a single Quest under a specific tile in a long-running demo room).
- **BP integration shape: "wait for credentials" gate.** BP_VRPawn's BeginPlay (Phase B) binds to `OnCredentialsReady` before running the `Initialize → Join Channel` chain. The literal pins on `Make RtcEngineContext` and `Join Channel` get replaced with `Get Signaling Subsystem → AgoraAppId / AgoraChannel / AgoraToken` reads. The plumbing handles the race where the subsystem may already be `Live` before BeginPlay runs — a State==Live branch fires `OnSignalingReady` directly; otherwise binding to the multicast.

**Files shipped this session.** All new:

- `VR_Project/Source/VR_Project/SignalingSubsystem.h` — public surface (enum, struct, four delegates, four BP-readable credentials, BP-callable `RefreshToken`).
- `VR_Project/Source/VR_Project/SignalingSubsystem.cpp` — `Initialize` (config + code-gen + socket open) / `Deinitialize` (graceful `headset:end` emit + `SyncDisconnect`) / `EmitHeadsetRegister` (with ack-callback handler that triggers `FetchToken`) / `FetchToken` (HTTP POST with JSON body; on 200, populates the four credentials, schedules refresh, broadcasts `OnCredentialsReady` / `OnTokenRefreshed`) / `ScheduleTokenRefresh` (timer at `expiresAt − 300 s`, clamped to `[30 s, 1 hr]`) / `HandleHeadsetCommandEvent` (parses the schema-relevant fields per `docs/commands.md` into an `FSignalingCommand` struct and broadcasts) / `SetState` (single source of truth for state transitions + delegate fan-out + logging).

Modified:

- `VR_Project/VR_Project.uproject` — enable `SocketIOClient` plugin for `Win64` + `Android`.
- `VR_Project/Source/VR_Project/VR_Project.Build.cs` — add `SocketIOClient`, `SIOJson`, `HTTP`, `Json` to `PrivateDependencyModuleNames`.
- `VR_Project/Config/DefaultGame.ini` — new `[/Script/VR_Project.SignalingSubsystem]` section with `ServerUrl`, `TenantId`, `Scenario`, `TraineeName`. **URL must be quoted** — UE's INI parser otherwise truncates `http://192.168.50.162:3000` to `http:` at the first `:` it sees outside of `Key=Value` (see "Lessons" below).
- `.gitignore` — added `VR_Project/Plugins/SocketIOClient/`.
- `VR_Project/Plugins/README.md` — full install recipe + version pinning rationale.
- `Web_Dashboard/src/pairing.js` — added `headset:end` handler (Phase E session-end), authz-gated to the socket holding the room's `headsetSocketId`. Pruning the room immediately closes the §5.1 protocol gap where the only previous removal path was the disconnect handler firing after a ~30 s socket timeout.
- `Web_Dashboard/README.md` — documented `headset:end` in the API surface table; rewrote the "Real headset wiring" section to reflect that hardcoded BP literals are now gone (replaced with subsystem variable reads).

**Build cycle: four UAT iterations to get to green.** Captured here because each failure exposed a real plugin / UE quirk worth pinning:

1. **v1 → `error C2065: 'ESIOConnectionCloseReason' undeclared`** in `SignalingSubsystem.gen.cpp`. Root cause: UHT generates reflection code for the `HandleSocketDisconnected(TEnumAsByte<ESIOConnectionCloseReason>)` UFUNCTION signature, which means the enum *must* be visible in the header — a forward declaration is insufficient because UHT also needs to emit the metadata. Fix: `#include "SocketIONative.h"` in `SignalingSubsystem.h` before `GENERATED_BODY()`. Lesson: any UCLASS that exposes a plugin type in a UPROPERTY/UFUNCTION signature must include that plugin's header transitively — `class FooBar;` forward decls only work for raw pointer params, not UFUNCTION/UPROPERTY reflected ones.
2. **v2 → at-runtime: `LogVRIPSignaling: Initialize: ... server=http: ...`** + `SocketIO: USocketIOClientComponent::Connect attempt while in invalid world`. Two distinct bugs in one boot trace. Root cause #1 (server URL truncated): UE's INI parser sees `Key=Value` semantics but treats `:` as a token separator in *unquoted* values, so `ServerUrl=http://192.168.50.162:3000` parses as `ServerUrl="http"` and discards everything after the first `:`. Fix: wrap the value in double quotes — `ServerUrl="http://192.168.50.162:3000"`. Lesson: any URL-typed INI value with a port number needs to be quoted. Root cause #2 (invalid world): `USocketIOClientComponent::Connect` checks `bLimitConnectionToGameWorld` against `GetWorldFromContextObject(this)` — but the component lives on the GameInstance (no actor outer) so it has no world. Fix attempt #1 (set the flag to false manually) compiled but only got past the world-check.
3. **v3 → at-runtime: `Assertion failed: IsValid()` in `TSharedPtr::operator->()` deep in `USocketIOClientComponent::Connect`.** Crashed the process. Root cause: `Connect` does `NativeClient->MaxReconnectionAttempts = ...` as one of its first lines, but `NativeClient` (a `TSharedPtr<FSocketIONative>`) is only allocated in `InitializeComponent()` — which is called by UE's actor-component lifecycle when the component is registered with an actor. A component created via `NewObject<>()` on a non-actor outer never runs `InitializeComponent`. Fix attempt #1 (call the private `InitializeNative()` directly) — fails to compile, the method is `protected:`.
4. **v4 (compile failure) → discovered `USocketIOClientComponent::StaticInitialization(WorldContextObject, bValidOwnerWorld)`** — the plugin's *public* documented entry point for exactly this case (component-without-actor). It internally sets `bStaticallyInitialized=true`, `bLimitConnectionToGameWorld=false`, `bShouldAutoConnect=false`, then calls `InitializeNative()`. Three of my hacky lines collapse to one supported API call. Lesson worth pinning: **always grep a plugin's public C++ surface for `StaticInitialization` / `StandaloneInit` / similar before reaching for `NewObject + private-method-workaround`.** Plugin authors anticipate the non-actor case more often than not.
5. **v5 → green.** Cook + package + install: `AutomationTool exiting with ExitCode=0`. Launch + 15 s wait → server's `/api/sessions?tenantId=onebonsai` shows `{ code:"1498", source:"headset", ... }`, logcat shows the full state machine trace including a clean reconnect cycle (connection blip ~700 ms after first connect, subsystem auto-recovered with same code).

**Phase E session-end (server side) shipped same cycle, BP side deferred.** The C++ side of `Deinitialize → EmitHeadsetEnd()` plus the server-side `headset:end` handler are both live. Means: when the Quest app is killed cleanly (back-button exit, `am force-stop`, `Deinitialize` chain on GameInstance unwind), the room is pruned from `ROOMS` immediately and the grid tile disappears the instant the trainee finishes. Without this, the disconnect-driven cleanup waits for Socket.IO's ~30 s heartbeat timeout. Authz is socket-id-checked so a malicious actor can't end someone else's session by guessing a 4-digit code.

**Phase E token-refresh: C++ side done; BP wiring (bind to Agora's `OnTokenPrivilegeWillExpire` → call subsystem `RefreshToken` → in `OnTokenRefreshed` call Agora's `renewToken`) pending Phase B's BP refactor.** The subsystem already auto-refreshes at `expiresAt − 300 s` via a `FTimerHandle` as a safety net, so a fully-headless run is already protected against token expiry even without the BP wiring. The BP path on top of that gives Agora's own expiry signal a clean handler instead of letting it tick down to fail-and-recover.

**What this enables for Phase B (next).** With server-minted credentials reaching the subsystem, the BP refactor in Phase B is mechanical: three pin replacements + one new gating Custom Event. The hardcoded `t-onebonsai-1111` channel literal + the 24-hour temp token in `BP_VRPawn` can be deleted entirely. Every Quest cooked from then on can join the OneBonsai grid as its own tile under its own random code with zero per-device configuration — the "stub mode" on the faker becomes unnecessary for real headsets, and the same APK runs on a fleet of any size.

### 2026-06-03 — Phase 4 Phase B: BP refactor done, server-minted credentials end-to-end on Quest + Pico

`BP_VRPawn` no longer contains any hardcoded Agora channel name or token. The literal pins on `Make RtcEngineContext` (AppId) and `Join Channel` (Channel + Token) have been replaced with `Get Signaling Subsystem` variable reads of `AgoraAppId`, `AgoraChannel`, `AgoraToken`. A new `OnSignalingReady` Custom Event hosts the old Agora init chain; `BeginPlay` (after the 0.5 s permission-grant delay) checks `Signaling Subsystem → State`: if `Live` it fires `OnSignalingReady` directly, otherwise it binds the event to `OnCredentialsReady` and waits. Race-safe in both directions (subsystem may finish before or after the pawn spawns).

**Validation captured on hardware.** Cooked + sideloaded a Universal-config build (MinSDK=29, `bPackageForMetaQuest=False`, `bPackageDataInsideApk=True` to avoid the Pico/OBB-on-Android-10 issue) to both devices simultaneously. Both appeared in the OneBonsai grid as separate tiles, each with its own random per-launch pairing code minted by the server (`t-onebonsai-XXXX`), each playing its own Agora video stream. Zero stub-mode bridges, zero per-device BP edits, zero hardcoded credentials anywhere. The faker tool is now genuinely optional — its only remaining use is multi-tile UI testing without burning real headset batteries.

**Two device-config side-quests landed in the same arc.**

- **Pico/Android-10 OBB trap.** `bPackageForMetaQuest=False` reverts UE to its standard Android split-into-APK-plus-OBB content-delivery mode. The OBB sideload onto the Pico (`adb push main.1.com.Thomas.VRProject.obb /sdcard/Android/obb/.../`) worked but UE refused to read it after the initial `No Google Play Store Key. No OBB found.` dialog locked the app into a "give up" state on first launch. Permanent fix: `bPackageDataInsideApk=True` + `bDisableVerifyOBBOnStartUp=True`. Bakes the cooked `.pak` directly into the APK (188 MB → 281 MB) and turns off UE's OBB integrity check at boot. Single artifact, no `/sdcard/Android/obb/` orchestration ever needed. Trade-off accepted because the Meta-store-compliant build flavour (next entry) re-flips both back.

- **Quest 2D regression from the universal config.** The first universal build worked on both devices but ran the Quest in a flat 2D Android panel inside Meta home. Root cause: `bPackageForMetaQuest=False` *does* skip the Meta VR manifest entries (`com.oculus.intent.category.VR` intent-filter, `com.oculus.vr.focusaware`, `com.oculus.ossplash`) — Quest's launcher needs those to treat the app as immersive instead of 2D. Confirmed by inspecting the cooked `Intermediate/Android/arm64/AndroidManifest.xml`. Resolution: split into two cook profiles for this Phase B validation cycle (Quest-VR-compliant config vs Pico-compatible config), and accept the constraint that the Pico ran 2D for this validation. The actual fix — universal APK that boots stereo on both — required the PICOXR plugin and is captured in the next entry.

### 2026-06-03 — Pico VR Phase A: universal APK boots stereo VR on both Quest + Pico

Pico 4 Enterprise now renders the training scene in proper immersive stereo VR (90 Hz target, single compositor layer, `PxrMetric` logging actively from the Pico runtime — the diagnostic signal that proves the app is the active immersive layer source). The same APK boots stereo on Quest 3 via Meta's runtime. Cross-vendor VR from a single artifact.

This closes the "Pico cross-platform parity" backlog item from the 2026-06-03 *Pico 4E sideload attempt (PARKED)* entry. The diagnosis there (Meta's `OculusOpenXRLoader` is hardcoded to Meta's runtime, won't probe for vendor alternatives) was correct but the fix path I sketched (Khronos OpenXR loader swap) turned out to be the wrong one. The right fix was option 2 (PICO Unreal Integration SDK), executed faster than expected because PICOXR is well-engineered and "drop in + flip one config flag" really is the install workflow.

**Plugin choice: PICO Unreal Integration SDK v3.4.1 (LTS).** Picked from five Pico-published UE plugins after a brief analysis:

- **PICOXR ✅** — LTS Integration SDK. Pico's proprietary HMD/Input/EyeTracker/MR runtime. Direct functional equivalent of Meta's stack on Quest. Production-recommended.
- **PICOOpenXR** ❌ — Alternative path using stock Khronos OpenXR + Pico-specific extensions. Conflicts with PICOXR (both register HMD providers). Architecturally cleaner but requires more careful Meta plugin isolation. Deferred as a v2 refactor candidate.
- **PICOEnterprise** ⏸ — Kiosk mode + MDM hooks for enterprise fleet deployments. Useful for the Securitas-style customer scenario later; not needed for VR rendering now.
- **PICOSpatialAudio** ❌ — Agora handles all our audio path. Not applicable.
- **OnlineSubsystemPICO** ❌ — Pico store / leaderboards / cloud-save. Not applicable to a sideloaded enterprise app.

**Universal-APK strategy.** Both Meta and Pico HMD providers are enabled in the same APK; at boot they self-elect based on which device runtime is present (PICOXR detects PICO runtime, OpenXR/Meta detects Meta runtime, only one wins). The two providers coexist peacefully in the same process. APK footprint grows ~50 MB (PICOXR's native libs) — acceptable given we get rid of the per-device cook + sideload cycle.

**Cross-vendor config in `Config/DefaultEngine.ini`:**

- `MinSDKVersion=29` (lowest common denominator — Pico 4E runs PICO OS on Android 10 = API 29).
- `bPackageForMetaQuest=True` (Meta's manifest injection for Quest's "treat as immersive" launcher heuristic — `com.oculus.intent.category.VR`, `focusaware`, `ossplash`).
- Pico-side manifest entries (`pvr.app.type=vr`, runtime libs, controller meta-data) come from PICOXR's `PICOXR_UPL.xml` automatically — no `ExtraApplicationSettings` work needed.
- New `[/Script/PICOXRHMD.PICOXRSettings]` block keeps Pico feature flags minimal: controllers only, no eye/face/body tracking, no MR/anchors. UPL conditionally injects the matching `<meta-data>` and permission entries based on these flags, so a build that doesn't need eye tracking doesn't ask for `EYE_TRACKING` permission.

**Build #1 of #2: failed with the predicted Java method conflict.** UE 5.5 + `bPackageForMetaQuest=True` injects `AndroidThunkJava_IsOculusMobileApplication() { return true; }` into the generated `GameActivity.java`. PICOXR's UPL also injects the same method (lines 354-359 of `PICOXR_UPL.xml`) — same name, same signature → `error: method ... is already defined in class GameActivity` from javac.

**Fix shipped as a documented patch to the upstream `PICOXR_UPL.xml`.** Commented out PICOXR's copy with a clear `<!-- PATCH (OneBonsai/...) -->` block explaining the conflict, the rationale, and the functional impact (zero — both copies return `true`; Pico hardware is binary-compatible with the Oculus-mobile detection layer). The patch survives PICOXR plugin updates only if reapplied — captured as a step in `VR_Project/Plugins/README.md` so any dev who re-downloads PICOXR after a Pico SDK update knows to re-apply it.

**Build #2: green.** ~3 min incremental cook (only the Java step changed). Sideloaded to Pico, launched, immediately observed:

- `PxrMetric: FPS=78/90, LayerCnt=1, Pkg=com.Thomas.VRProject` — Pico's compositor reporting our app is the sole active VR layer at near-target framerate. This metric only prints for the active immersive app; 2D apps don't produce it.
- `APxrRuntime: PXRSDK_PM ENGINE FPS: 78` — UE render thread keeping up.
- Server `/api/sessions` reports `{ code: 7164, scenario: "Fire Training", source: "headset" }` — full signaling subsystem boot + Agora join confirmed.

**Things learned worth pinning.**

- **PICOXR ≠ PICOOpenXR.** Two separate Pico UE plugins with overlapping names, mutually exclusive at runtime. PICOXR is the proprietary HMD provider (preferred for production); PICOOpenXR is a standards-based alternative that requires careful Meta-plugin isolation. Picking both at the same time produces "two HMD providers registered" + crashes.
- **`bPackageForMetaQuest=True` is more than a Quest splash-screen flag.** It actively injects the `IsOculusMobileApplication` Java method into the generated `GameActivity.java` — which collides with any plugin (PICOXR included) that also tries to inject the same method. The cleanest fix is to comment out the plugin's copy and let UE's injection win.
- **PICO 4 Enterprise runs Android 10 / API 29.** Set `MinSDKVersion=29` for cross-vendor builds. Meta's API 32 floor is a *store* check, not an install-time check; a sideloaded universal APK with MinSDK=29 + Meta manifest entries + PICOXR works on Quest 3 just fine.
- **The Pico's `pvr.app.type=vr` and Meta's `com.oculus.intent.category.VR` are independent manifest markers.** Both can live in the same `<application>` and `<activity>` block — Quest reads one, Pico reads the other, no conflict.

**Net state after this entry.** The OneBonsai grid view runs on heterogeneous fleets: any combination of Quest 2/3/Pro/3S + Pico Neo3/4/4E from a single APK. Per-device config is now strictly an `adb install` + the device's own VR launcher. Phase C (in-VR pairing HUD widget) and Phase D (`OnHeadsetCommand` BP graph for `pause_simulation` and friends) are the natural next stops.

### 2026-06-04 — Phase 6 scope revision: hook into existing OneBonsai app-management portal

Discovery during a "how would this eventually look in production" planning conversation: **OneBonsai already operates an internal app-management portal** that handles organization registration for other in-house apps. Apps in that ecosystem open fresh from install, prompt the user to enter a *registration code* in VR, hit the portal's backend, and the portal binds the device to a company/domain forever after. This is exactly the Organization Pairing Code (OPC) layer that the 2026-06-03 multi-tenant strategy discussion sketched out — except OneBonsai has already built it for other apps and we just need to plug in.

**Architectural shape now confirmed: two stacked codes, two systems, one wire format.**

| Layer | Source | Built where | Lifetime |
|---|---|---|---|
| **Organization Registration Code (OPC)** | Existing OneBonsai portal | Done (used by other in-house apps) | Persisted on device, set once at first install |
| **Session Pairing Code** | `USignalingSubsystem` | Done (Phase 4A) | Random per cold launch, retained across hot reconnects |

The two layers compose cleanly. The OPC determines *which tenant* the headset belongs to; the session code determines *which instructor view* a given session shows up under within that tenant. Channel naming becomes `t-<tenantId>-<pairingCode>` exactly as we've been using `t-onebonsai-XXXX` — the only change is `<tenantId>` becomes a runtime value read from the persisted OPC redemption response rather than a hardcoded INI string.

**Concrete wiring for the eventual implementation (captured here so the design is ready when we start the work):**

- **Headset side (first launch only):** UMG widget that prompts for the OPC. On submit → `HTTP POST <portal-domain>/api/register/redeem { code }` → 200 returns `{ tenantId, displayName, ... }`. Persist tenantId via `FFileHelper::SaveStringToFile` into `FPaths::ProjectSavedDir()/Config/OneBonsaiRegistration.ini` (or equivalent). On every subsequent launch, read it back and skip the UMG.
- **Headset side (always):** `USignalingSubsystem::LoadConfig` reads tenantId from the persisted file instead of `DefaultGame.ini`. Falls back to INI value if the persisted file is missing (lets us keep `onebonsai` as the dev/CI default without registration).
- **Portal side:** add `POST /api/register/redeem` if it doesn't already exist for OneBonsai's app codes (it almost certainly does — that's the whole point of the existing portal). No other portal-side changes if their existing endpoint shape matches.
- **Signaling server side:** trivial. Already keys everything on tenantId. Maybe add a `GET /api/tenants/:id/info` endpoint that round-trips to the portal to confirm the tenant exists + fetch display metadata for the grid header.

**Instructor overview embedding — four patterns ranked by effort.**

| Pattern | What it is | Effort |
|---|---|---|
| **A. iframe embed** | Portal iframes our `https://signaling.onebonsai.com/?tenantId=X` into an "Instructor" tab | ~1 hour |
| **B. Subpath reverse-proxy** | Portal proxies `/instructor/*` → our Node server (same domain, shared cookies) | ~half day |
| **C. JS SDK embed** | Extract grid + focus view into `@onebonsai/instructor-portal-sdk`; portal imports + mounts into a `<div>` | ~2 days |
| **D. Full port** | Rewrite grid + focus + command deck inside the portal's frontend stack, calling our Socket.IO server as pure backend | ~1 week |

**Recommendation:** ship A first (afternoon of work, working "Instructor" tab); upgrade to B when iframe auth context becomes annoying; only invest in C/D if product demand specifically calls for tighter visual integration than B provides. Worth noting that the web dashboard was built in dependency-free vanilla JS specifically so we have the option of doing C/D later without first having to undo a framework choice.

**Server-side production hardening required before any embedding pattern goes live** (independent of which pattern is chosen):

- **Auth.** Currently none. Must accept the portal's auth tokens (JWT with `tenantId` claim or equivalent), enforce on every `/api/*` + every Socket.IO event that touches tenant data. Middleware lives in front of `pairing.js`/`commands.js`/`agora.js`.
- **CORS.** Currently `*`. Lock to specific OneBonsai domains.
- **TLS.** Currently HTTP. Production needs HTTPS — required anyway for browser `getUserMedia()` mic access in focus mode.
- **Persistent storage.** In-memory `ROOMS` registry stays (sessions are ephemeral by design). New: small DB (SQLite is fine; Postgres if we want managed) for per-tenant Agora project IDs + pairing audit logs. The `getAgoraCredentials(tenantId)` seam mandated by `.cursorrules §4.3.1` is already there — it just currently returns the same hard-coded `.env` value for every tenant.

**Effort estimate revised.** Original Phase 6 ballpark was 2 weeks of work (build customer admin page + OPC generation + auth + persistence + embedding). With the OPC layer pre-built by OneBonsai's existing portal, **Phase 6 drops to roughly 1 week**:

- ~1 day: UE first-launch UMG + tenantId persistence + subsystem integration
- ~half day: portal endpoint integration (if not already shaped right)
- ~3-5 days: server hardening (auth + CORS + TLS + DB for per-tenant Agora creds)
- ~1 hour - 2 days: embedding integration depending on pattern A vs C

**Open decisions for when Phase 6 actually starts.**

1. Which embedding pattern is the v1 target? Default assumption: A → B trajectory.
2. What auth does OneBonsai's portal already issue? JWT vs session cookie determines the middleware shape on our side.
3. Per-tenant Agora projects, or single shared Agora project with per-tenant channel namespacing? The latter is operationally simpler; the former gives clean billing splits per customer. Likely depends on Agora's pricing tiers + how OneBonsai bills customers.
4. Does the portal's existing redemption endpoint return tenantId in the shape we want, or do we need a new endpoint specifically for VR-app registration? Cosmetic question — both work.

**Things to keep stable across Phase 6.** Don't break the existing `t-<tenantId>-<pairingCode>` channel naming convention — it's load-bearing across server, BP, and (after the persistence change) the registration redemption response. The `USignalingSubsystem` public API surface (the 4 BP-readable credentials + 4 delegates + the state machine) should also stay stable — that's what makes the layer drop-in portable per `HowToPort.md`. Phase 6 is internal plumbing (where does `TenantId` come from at boot) plus deployment hardening, not an API redesign.

### 2026-06-04 — Phase 6 Phases A/B/C: server-side multi-tenant layer

Implemented the server half of the single-code multi-tenant model sketched out in the scope-revision entry above. **Significant simplification confirmed during planning:** the user's vision is *one* code per tenant (e.g. `5555555555` → Securitas), used for **both** VR device registration (one-time first-launch) and instructor dashboard login. No separate instructor login codes, no per-instructor accounts — anonymous instructors with an optional display name ("Jan is watching") are enough. Cuts the auth surface significantly versus an OAuth-flavoured per-instructor design.

**What landed (the entire dashboard server is now multi-tenant-aware, with no VR-side changes yet).**

- **`Web_Dashboard/data/tenant-codes.json`** — static lookup table mapping codes to `{ tenantId, displayName }`. Three demo tenants seeded: OneBonsai (code `0000000000`), Securitas (`5555555555`), CustomerX (`7777777777`). **Designed to be replaced wholesale with an HTTP call to OneBonsai's existing client-management portal once it exposes an API** — the JSON file *is* the contract spec for that integration. Swap the body of `resolveByCode()` in `src/tenants.js`, leave every consumer untouched.

- **`Web_Dashboard/src/tenants.js`** — `resolveByCode(code) → {tenantId,displayName}|null`, `getTenantInfo(tenantId)`, `isKnownTenant(tenantId)`. Validates the JSON at boot (logs the loaded tenant list — `[VRIP tenants] loaded 3 tenant code(s): onebonsai, securitas, customerx`). Codes normalised to lowercase + trim; pattern is alphanumeric 4-32 chars but digit-only is preferred (the VR text-entry widget defaults to numeric keyboard, which is much faster on a controller than the alphanumeric one).

- **`Web_Dashboard/src/auth.js`** — signed-cookie sessions (HMAC-SHA256 over a base64url JSON payload). **Deliberately zero new dependencies** — the whole flow is ~50 lines vs pulling in `cookie-parser` + `express-session` + a session store + `jsonwebtoken`. Includes Express middleware (`attachInstructor`, `requireInstructor`) and a Socket.IO equivalent (`attachInstructorToSocket`). Dev fallback: if `INSTRUCTOR_SESSION_SECRET` isn't in `.env`, a per-process ephemeral random secret is generated — login works, but every server restart invalidates all sessions. The startup log loudly warns about this.

- **`server.js` — four new endpoints + auth gate on existing ones:**

  | Endpoint | Auth | Purpose |
  |---|---|---|
  | `POST /api/tenant/resolve` | none (code is the credential) | VR side — first-launch code → `{tenantId, displayName}` |
  | `POST /api/instructor/login` | none | Same code + optional name → sets `vrip_instructor` cookie |
  | `POST /api/instructor/logout` | none | Clears cookie |
  | `GET /api/instructor/me` | cookie required | Dashboard boot uses this to discover its tenant + render header |
  | `GET /api/sessions` | cookie required | Tenant taken from cookie, `?tenantId=X` query removed |
  | `GET /` | cookie required | Redirects to `/login.html` if no session |

- **`public/login.html` + `js/login.js` + CSS additions** — clean dark-themed login card matching the existing design tokens; centered single-code input field (monospace, big, letter-spaced — looks like a 2FA prompt). Remembers the instructor's *name* (not the code) in localStorage for convenience.

- **`public/index.html` + `js/grid.js` updates** — header now shows an `instructor-chip` with `Tenant · Name` plus a Sign Out button. Boot fetches `/api/instructor/me` instead of `/api/config.defaultTenantId`; 401 hard-redirects to login. Socket.IO connects `withCredentials: true` so the cookie travels on the handshake.

- **`src/pairing.js` — two security tightenings:**
  1. `headset:register` now rejects any `tenantId` not in the registry (defence-in-depth — a misbehaving headset can't create sessions in arbitrary tenant namespaces by tampering its register payload).
  2. `instructor:subscribe-tenant` **ignores the payload's `tenantId` entirely** and uses the cookie's tenantId. Closes the gap where a logged-in Securitas instructor could otherwise emit `instructor:subscribe-tenant { tenantId: "customerx" }` over the socket and bypass the REST auth.

**Validation.** Wrote `scripts/smoke-phase6.ps1` covering all 11 endpoint × auth state combinations. All pass. Browser-validated end-to-end by the user: log in as Securitas, hit `http://localhost:3000/api/sessions?tenantId=customerx` directly in the address bar → response correctly reports `"tenantId":"securitas"` (cookie wins, URL parameter silently ignored). Multi-tenant isolation is real, not theatrical.

**Two things in the original scope-revision entry that turned out to be wrong / simpler.**

1. The original plan (the "two stacked codes" table above) imagined a separate OPC layer issued by OneBonsai's portal. User clarified: it's *one* code per tenant, used for both VR + instructor. Phase 6A reflects this — no separate "OPC" type, just a single `code → tenant` lookup. If OneBonsai's portal already has the same shape (one code per tenant), the future integration is literally a one-line `fetch()` swap inside `resolveByCode()`.
2. The original effort estimate had "~3-5 days: server hardening (auth + CORS + TLS + DB)" as a single bucket. The cookie-auth layer alone was a few hours, not days, because we skipped the per-instructor account model. CORS, TLS, and persistent DB are still TODO but they're each independent and small.

**What this means for portability into OneBonsai's existing VR apps.** The user noted those apps already have a VR panel for entering registration codes (built for the existing company-management system). Phase 6D will be designed with that in mind: the `UTenantRegistry` C++ subsystem owns all logic (HTTP + persistence + state), exposes `RedeemCode(FString) → callback` as the entire BP-callable surface, and the `WBP_RegistrationGate` UMG widget we ship is *optional* — host apps wire their existing panel's Submit button straight into `TenantRegistry->RedeemCode(InputText)` and bind `OnRegistrationChanged` to hide their panel. To be documented in `HowToPort.md` under a "BYO code-input UI" section once Phase 6D lands.

**Next:** Phase 6D (the VR half) — `UTenantRegistry` GameInstanceSubsystem with `RedeemCode/IsRegistered/GetTenantId/ClearRegistration`, persistence to `Saved/Config/OneBonsaiRegistration.json`, hook into `BeginPlay`, swap `USignalingSubsystem::LoadConfig` to read from registry. ~1 day estimated; will conclude with a 2-device test (Quest registers as Securitas, Pico as CustomerX, two instructor logins see fully separated grids).

### 2026-06-05 — Phase 6D shipped (rescued write-up) + channel-swap fix (cure video pump drop on mid-session tenant swap)

Two pieces in one entry: the Phase 6D delivery write-up that yesterday's session ended before getting to, and a same-day bug-and-fix that came out of validating it end-to-end.

**Phase 6D delivered (yesterday afternoon, undocumented until now).** The Phase 6 A/B/C entry above ended with a "Next: Phase 6D" promissory note. Phase 6D actually shipped about three hours later but the Devlog write-up didn't make it in before EOD. Pieces that landed:

- `Source/VR_Project/TenantRegistry.{h,cpp}` — `UTenantRegistry` `UGameInstanceSubsystem`. Persists `Saved/Config/OneBonsaiRegistration.json` (`{tenantId, displayName, code, registeredAtUnix, schemaVersion}`). Public BP API: `RedeemCode(code, callback) → POST /api/tenant/resolve`, `ClearRegistration`, pure getters (`IsRegistered`, `GetTenantId`, `GetDisplayName`, `GetRegistrationCode`), `OnRegistrationChanged` multicast.
- `SignalingSubsystem` modifications — `Initialize` now calls `Collection.InitializeDependency(UTenantRegistry::StaticClass())` to fix the race (without it, signaling occasionally read an empty registry and fell through to the INI dev fallback). Reads `tenantId` from `Registry->ResolveTenantIdForSignaling()` instead of the INI. Subscribes to `OnRegistrationChanged` to handle the three runtime paths: unregister-from-registered (Path A — tear down socket + clear creds + park), redeem-while-disconnected (Path B — open socket on the new tenant), and direct switch-org (Path C — leave + rejoin).
- `[/Script/VR_Project.TenantRegistry]` INI block with `bAllowUnregisteredBoot=False` for production-style strict mode (signaling refuses to boot until the user redeems a code; the INI `TenantId` becomes a dev-only fallback that's only consulted when `bAllowUnregisteredBoot=true`).
- `Content/UI/WBP_RegistrationGate.uasset` — UMG widget with text input + status row; calls `RedeemCode` and surfaces success/error from the callback. The reference UI; explicitly *optional* per the *BYO code-input UI* design in `HowToPort.md` — host apps already wired into OneBonsai's existing company-management system can drive `RedeemCode` from their own panel and skip this widget entirely.
- `Content/UI/BP_RegistrationGateActor.uasset` — world-space widget host (3D-VR-friendly placement; `WBP_RegistrationGate` is a UMG widget, this actor wraps it for in-scene placement).
- `BP_VRPawn` updates — registration-gate spawn on `BeginPlay` if `!IsRegistered()`, hide on `OnRegistrationChanged → IsRegistered()==true`.

Validated end-to-end on the desk yesterday: fresh install → enter `0000000000` → registered as `onebonsai`; restart app → auto-resumes into the same tenant without re-prompting (persistence works). All Phase 6D acceptance criteria green.

---

**The bug that fell out of validation: mid-session tenant swap silently broke the video pump.** Same session, two-step repro: register as `onebonsai`, video shows on the OneBonsai grid. Without restarting, hit "switch organisation" (`ClearRegistration`) and re-redeem with `5555555555` (Securitas). The headset correctly registers under the new tenant — server logs `headset:register tenant=securitas`, `/api/sessions` shows the new session in the Securitas tenant — but the new instructor sees a **black tile**. The pump's own log was clean (`StartVideoPump: pumping 1280x720 @ 30.0 Hz`, no errors, `pushVideoFrame` returning 0), which is what made it sneaky.

**Root cause: no contract between the registry-swap path and the Agora channel lifecycle.** Walked the state machine:

1. `ClearRegistration` → `HandleRegistrationChanged` Path A → tears down the *socket* + clears credentials + sets state `Disconnected`. Does **not** tell anything about the *Agora channel*. Pump keeps pushing 30 fps into the engine's external video source.
2. `RedeemCode("5555555555")` → success → `HandleRegistrationChanged` Path B → opens a new socket → re-registers → re-fetches token → fires `OnCredentialsReady` for the *second* time with `AgoraChannel = "t-securitas-XXXX"`.
3. The BP `OnCredentialsReady` graph was authored for first-boot — it does `RtcEngine.Initialize` + `JoinChannel`. On the second fire it tries to Initialize-or-Join into an engine still sitting in the old channel. Agora 4.x doesn't clean that up implicitly; the *old* channel's local video track stays live, the *new* channel has no published local video.
4. Instructor on the Securitas tenant joins `t-securitas-XXXX`, sees no published video → black tile. Pump is still happily pushing frames into the old channel's track that nobody is subscribed to.

**Fix shape: explicit "channel changed" signal + pump-restart wrapper.**

- New `USignalingSubsystem` BP-assignable delegate `OnAgoraChannelChanged(NewChannel)`. Empty `NewChannel` = "leave-only, no rejoin coming" (Path A — `ClearRegistration` without follow-up `RedeemCode`). Non-empty = "swap to this channel" (Path B/C after `/api/token` returns the new credentials).
- New `bHasFiredInitialCredentials` gating flag. First successful non-refresh `/api/token` still fires `OnCredentialsReady` (BP first-boot init path is untouched); every subsequent non-refresh credentials fetch routes through `OnAgoraChannelChanged` instead, so the BP first-boot `Initialize`+`JoinChannel` graph only ever runs once. Token refreshes (`bWasRefresh=true`) keep firing `OnTokenRefreshed` unchanged — they're within-channel rotations and don't trigger a channel transition.
- New `UAgoraVideoPump::RestartForNewChannel()` BP-callable — wraps `StopVideoPump(); StartVideoPump();`. The reason a wrapper is needed (and not just "call `StartVideoPump` again"): the `setExternalVideoSource(false)` → `setExternalVideoSource(true)` toggle inside the stop/start pair is what actually rebinds the external frame source to the *new* channel's newly-created local video track. `setExternalVideoSource` is engine-scope, not channel-scope, but the binding to the local video track resets on `LeaveChannel`. Calling only `StartVideoPump` when already running is a no-op and would not fix the binding.

**BP wiring on `BP_VRPawn` (the user-facing part).** Single new event graph:

```
On Agora Channel Changed (NewChannel)
  ├─ Branch [NewChannel == ""]
  │    True  → VideoPump.StopVideoPump → Agora.LeaveChannel
  │    False → VideoPump.StopVideoPump
  │             └─ Agora.LeaveChannel
  │                └─ Agora.JoinChannel(NewChannel, Signaling.AgoraToken, Signaling.AgoraUid)

Agora OnJoinChannelSuccess (existing)
  └─ VideoPump.RestartForNewChannel    (idempotent; no-op on first boot too — Stop early-exits if nothing's running)
```

Wired in the editor; `VRPawn.uasset` updated in this commit.

**Validation.** PIE single-device, three independent scenarios green:

1. **First-boot registered.** Cold launch → `Initialize: server=... persisted=yes tenant=onebonsai` → socket opens → credentials ready → BP `Initialize`+`JoinChannel` runs once → pump starts → instructor sees video.
2. **Switch-org mid-session (the bug repro).** From scenario 1, `ClearRegistration` → log shows `OnAgoraChannelChanged("")` → `StopVideoPump: stopped` → `Agora LeaveChannel ok`. Then `RedeemCode("5555555555")` → `OpenSocket → /api/token 200 channel=t-securitas-XXXX` → log shows `subsequent credentials → firing OnAgoraChannelChanged(t-securitas-XXXX)` → BP leaves the old channel, joins the new one, pump restarts → instructor on Securitas dashboard sees video.
3. **Restart while already registered.** Stop PIE, start PIE → `Initialize: persisted=yes tenant=securitas` → same path as scenario 1 but with the persisted tenant. No re-prompt, video resumes immediately.

**Side discovery: stale-INI gotcha worth pinning.** `DefaultGame.ini` had `ServerUrl="http://192.168.50.162:3000"` from a previous session's network. Current LAN IP was `192.168.0.119`. UE's `GConfig` is load-once-at-editor-startup; editing the source INI on disk does **not** hot-reload into the in-memory `GConfig` even across PIE sessions. The fix is just to restart the editor — `ReloadConfig <Class>` exists but only re-applies in-memory config to live instances, doesn't re-parse source INI files. Bumped the committed IP to the current LAN value as a chore; the long-term hygiene fix (per-dev override via `Saved/Config/Windows/Game.ini`, or mDNS `.local` hostname so the IP doesn't matter at all) is in the backlog rather than this commit's scope.

**Things learned worth pinning.**

- **`OnCredentialsReady` is a one-shot in BP-author mental model, not a stream.** The C++ implementation was firing it on every non-refresh `/api/token` success, which is correct from the "credentials are now ready" perspective but wrong from the BP "this is the cue to Initialize the Agora engine" perspective. Splitting into `OnCredentialsReady` (first-boot only) + `OnAgoraChannelChanged` (subsequent) is a clearer contract and is what we should have shipped originally.
- **Agora 4.x `setExternalVideoSource` is engine-scope, but its *effective binding* to a local video track resets on `LeaveChannel`.** Calling `setExternalVideoSource(true)` once at app start and then `JoinChannel/LeaveChannel/JoinChannel` will silently stop publishing video on the second `JoinChannel`. The toggle-off-toggle-on pattern is the right cure; `RestartForNewChannel` makes that single-call from BP.
- **The pump's "silent success" failure mode (everything green in logs, no video at the receiver) is the worst possible diagnostic surface.** Worth considering as a follow-up: log a periodic heartbeat on the pump side ("pushed N frames in last 5s") so a missing heartbeat on the receiver becomes a one-grep root-cause clue.

**Net state.** Phase 6D + this fix are end-to-end stable on a single device for all three runtime paths (cold-boot-registered, register-mid-session, switch-org-mid-session). Yesterday's "next: 2-device test" item carries over — but the multi-device case is mostly de-risked by single-device validation since the headset-side state machine is now proven.

### 2026-06-08 — Phase 6 closeout: 2-device validation passes (HMD-priority regression caught + Pico input gap closed)

Phase 6's last open acceptance criterion — *the* 2-device test of multi-tenant isolation on real cross-vendor hardware — landed today: Quest 3 + Pico 4 Enterprise both registered, both publishing video, both visible only in their own tenant's instructor dashboard, across an exhaustive matrix of pairings (same-tenant both devices, cross-tenant both devices, single-device-only, mid-session switch-org via `ClearRegistration` + `RedeemCode`). The cookie-bound dashboard authorization holds end-to-end: a Securitas-logged-in browser sees only the Securitas-registered headset's tile regardless of which physical device is on which code; the same physical Pico that was on CustomerX in run 1 is correctly invisible to the Securitas instructor in run 2 after registry swap. **Phase 6 is now end-to-end stable on real cross-vendor hardware.**

The session also surfaced two regressions worth pinning. Both were caught + worked around today; one has a proper fix queued (universal-APK selection), the other is a permanent project-level gap that needed closing (Pico controller input bindings). Both are captured in this commit alongside the Devlog entry.

---

**Regression #1: HMD-priority block from Phase 6D commit `26fefa1` doesn't actually self-elect on Pico.**

Symptom: Pico-side cold launch of the universal APK that was happily running on the Quest produced a black "loading" screen indefinitely. PICOXR's `JNI_OnLoad` fired (logcat: `PxrAPI xrVersion S2.2.0.0`), the Java lifecycle (`onCreate → onStart → onResume → topResumedGained`) completed cleanly in ~100 ms, but the UE native runtime then produced **zero** `UE:`-tagged log lines for the entire boot window. After ~8s the Pico compositor surfaced `report loading start in 8s` / `pre_display_error has lasted for 7.5s` and force-ANR'd the process via `system_server → tombstoned`. The app stayed alive (`pidof` returned the PID for the full window) but the main thread was stuck deep in HMD init somewhere before any UE log buffer flushed.

Diagnosis path: the useful clue was `clientPid=2832` in the Pico's `DumpUtils: LastResumed 3D` block — the Pico compositor's record of "which app is the active XR client" stayed at PID 2832 (`com.pvr.vrshell`, i.e. the Pico's home environment) even though our `GameActivity` was the foreground 3D activity per `LastResumed 3D activityName=com.epicgames.unreal.GameActivity`. **We were the foreground activity but never connected as an OpenXR client.** That ruled out a UE-loadLibrary hang (process was running native code, PICOXR's `JNI_OnLoad` had succeeded) and pointed straight at HMD provider selection going wrong.

Root cause: Phase 6D commit `26fefa1` added `[HMDPluginPriority] OpenXR=10, PICOXRHMD=0` to fix a Quest-side `CalculateRenderTargetSize` assertion, on the assumption that "On Pico the OpenXR module fails to find a Meta runtime, PICOXRHMD's IsHMDConnected returns true, and PICOXR wins as the fallback." **That assumption doesn't hold on Pico OS 5+.** Pico ships a generic OpenXR runtime layer alongside the proprietary PICO runtime, so UE's OpenXR plugin's `IsHMDConnected()` returns true on Pico too. With `OpenXR=10` priority it wins HMD selection on Pico, half-initializes against the wrong (generic OpenXR) runtime, and never produces a VR frame — and doesn't yield back to PICOXRHMD either, so PICOXR's render path is never engaged. The Pico compositor sees us as the foreground app and waits for our first frame, never gets one, ANRs us.

Workaround applied (this commit): `DefaultEngine.ini` `[HMDPluginPriority]` flipped to `OpenXR=0, PICOXRHMD=10`. This makes the repo state a Pico-targeted APK. The same APK cooked from this checkout would re-trigger the original Quest assertion (`CalculateRenderTargetSize` returning 0/0 from PICOXR's quest-side `IsHMDConnected=true`), so the live Quest install on the office device retains its pre-flip APK from earlier in the day and stays untouched. **The universal-APK promise from the 2026-06-03 Pico-A entry is broken until a proper fix lands.** Cooking model is per-device for now. Proper fix on backlog; candidates are (a) a C++ runtime probe in the HMD provider selection seam that hard-disables the wrong plugin per detected device, (b) a per-device cook profile (`Config/Android_Pico/AndroidEngine.ini` overlay), or (c) a patch to either plugin's `IsHMDConnected()` so it actually probes its specific runtime rather than accepting the generic OpenXR loader's success. Each has its own footgun set; pick during the next session.

The committer's mental model of "both plugins probe their specific runtimes and only one wins" turned out to be aspirational rather than what the code actually does — both plugins lean on the generic OpenXR loader's `xrEnumerateInstanceExtensionProperties` returning success, which it does on both runtimes that ship a loader.

---

**Regression #2 (more accurately: a pre-existing gap that Phase 6D's `WBP_RegistrationGate` finally surfaced): Pico controllers track but no button input reaches Enhanced Input.**

Symptom: after the HMD-priority workaround, Pico booted stereo VR at 90/90 fps with PICOXR active, controllers were visible and tracked correctly (poses updated as the user moved them), and `WBP_RegistrationGate` rendered as expected. But trigger pulls didn't click on the gate's text input or any UMG button. Grip and thumbstick equally inert.

Root cause: project IMCs (`IMC_Menu`, `IMC_Default`) were authored against OpenXR / `OculusTouch_*` key codes only. PICOXR's UE plugin doesn't impersonate those — it registers a parallel set of `PICOTouch_*` `EKeys` (36 in total, extracted from `UnrealEditor-PICOXRInput.dll` for an authoritative list — trigger/grip/A/B/X/Y/thumbstick/thumbrest/home/menu/volume/system × left/right × click/touch/axis). With no IMC row mapping any of those, the entire PICOXR input set was disconnected from the project's Input Actions. The Quest had been quietly carrying the project on this gap until WBP_RegistrationGate became the first BP/UMG node to depend on cross-vendor menu-interact input.

Fix applied (this commit, in `IMC_Menu.uasset` and `IMC_Default.uasset`): added PICOTouch-side rows to each affected IA, alongside the existing OpenXR/Meta bindings. Same IAs, just additional Key rows per mapping. Both vendors now fire the same actions; the existing `BP_VRPawn` event graphs are unchanged. Quest is harmless because it never fires `PICOTouch_*` keys; Pico is now functional because it fires them through bindings that point at the same Input Actions Quest already triggers via `OculusTouch_*`. Coverage applied:

- `IMC_Menu` (the gate-unblocking core): `IA_Menu_Interact_Left/Right_Pressed`/`_Released` → `PICOTouch_Left/Right_Trigger_Click`; `IA_Menu_Cursor_Left/Right` → `PICOTouch_Left/Right_Thumbstick_X`/`_Y`; `IA_Menu_Toggle_Left/Right` → `PICOTouch_Left_Y_Click` / `PICOTouch_Right_B_Click`.
- `IMC_Default` (locomotion + grab + shoot): `IA_Move` → `PICOTouch_Left_Thumbstick_X`/`_Y`; `IA_Turn` → `PICOTouch_Right_Thumbstick_X`; `IA_Grab_Left/Right_Pressed`/`_Released` → `PICOTouch_Left/Right_Grip_Click`; `IA_Shoot_Left/Right` → `PICOTouch_Left/Right_Trigger_Click`.

The three other IMCs (`IMC_Hands`, `IMC_Weapon_Right`, `IMC_Weapon_Left`) were left untouched — they'd need the same audit before any features that depend on them ship as cross-vendor. Added to backlog.

---

**Side chore: `DefaultGame.ini` `ServerUrl` bumped from `192.168.0.119` to `192.168.50.162`** (current LAN). Same stale-INI gotcha as the Friday entry, will keep biting until the per-developer override backlog item lands. Committed as a chore.

---

**Things learned worth pinning.**

- **"Zero `UE:` log lines + Java lifecycle completed cleanly + native process still alive" is the diagnostic shape of an HMD-provider deadlock during render-thread init.** UE's `LogInit:` chatter normally starts during `FEngineLoop::PreInit`, which runs *after* native `System.loadLibrary` but *before* the HMD provider's first frame is required. If something blocks during HMD provider startup before UE flushes its log buffer (e.g. an OpenXR loader doing a synchronous handshake against a runtime that's wrong for the device), nothing gets logged anywhere — UE-side or vendor-side — and the only diagnostic surface is the platform compositor's "app didn't produce a frame" timeout. Worth pinning because logcat looks deceptively healthy (Java tags fine, vendor SDK tags fine), and the absence of UE chatter is what tells you the answer.
- **Pico's `pre_display_error: has lasted for Ns` + `clientPid=<vrshell-pid>` is a strong "your app never registered as an XR client" signal.** Faster to grep for than chasing tombstones.
- **PICOXR plugin and Meta OpenXR plugin both claim `IsHMDConnected = true` on devices they have no business driving.** Neither does a real runtime-specific probe — both lean on the generic OpenXR loader's success, which the OS-level XR loader provides on both vendors. The HMD selection priority therefore decides *everything* on a multi-plugin universal APK; treating priority as a hint that "resolves to the correct provider by self-election" is wrong.
- **`PICOTouch_*` is the EKey prefix UE uses for Pico controller inputs** (not `PICOXR_*` or `PICO_Touch_*`, both of which seemed plausible at various points during the diagnosis). Authoritative list lives in the strings table of `UnrealEditor-PICOXRInput.dll`; one-liner extraction with `[System.Text.Encoding]::ASCII.GetString(File.ReadAllBytes(...)) | regex` is the fastest path when the plugin ships without source headers.
- **Editor-side `.uasset` IMC edits do not need an editor restart to take effect at cook time** — cook re-serializes every uasset from its on-disk form. (Pinned here because the 2026-06-05 `GConfig`-doesn't-reload gotcha for source INIs primed a "do I need to restart the editor?" worry. Different mechanism, different rules.)

---

**Net state after this entry.** Phase 6 is done. Multi-tenant isolation works end-to-end on real Quest 3 + Pico 4 Enterprise across the full pairing matrix tested today. Universal-APK promise is broken pending a proper fix; this commit is honest about the regression (the INI state is Pico-only, the next Quest cook from this checkout will assert without flipping `[HMDPluginPriority]` back). Project IMCs now have first-class Pico controller support for menu interaction + core locomotion; three other IMCs await the same audit. Next session naturally points at either (a) the proper universal-APK fix so we can collapse back to one cook, or (b) the deployment + project-port work that the morning planning conversation queued up (env-aware config plumbing → staging deploy → port → embed).

### 2026-06-08 (follow-up) — Universal-APK fix shipped via per-device cook script

The morning entry above flagged "universal-APK promise is broken pending a proper fix" as the most urgent piece of debt blocking the deploy/port/embed work. This entry closes that loop in the same calendar day. The fix shape is the (b) option from the earlier backlog item: a per-device cook profile, implemented as a PowerShell wrapper script that mutates `[HMDPluginPriority]` for the duration of one UAT invocation, restores it via a guaranteed `try/finally`, and renames the produced APK so both vendors' artifacts co-exist on disk.

**Why (b) and not (a) or (c).** Approach (a) — a C++ runtime probe in a `UVRBootstrapSubsystem` that hard-deregisters the wrong HMD modular feature before `FEngineLoop` reaches HMD selection — is the cleanest "one APK, deterministic" model. But it requires confidence about FEngineLoop init ordering that we don't have without instrumenting + measuring: `IModularFeatures::UnregisterModularFeature` may or may not be honored if HMD selection has already iterated the feature list, and getting that wrong leaves us with the *same* failure mode we're trying to fix plus a harder-to-debug code path. Approach (c) — patching PICOXR's and Epic's `IsHMDConnected()` to actually probe the vendor-specific runtime — is the most correct but requires either a forked plugin (perpetual merge overhead) or upstream PRs (timeline outside our control). Approach (b) is the lowest-risk path that delivers a deterministic build pipeline today; it leaves (a) and (c) on the table for if/when the script's two-APK output becomes friction.

**What landed.**

- `Tools/Cook-VRApp.ps1`: new ~170-line PowerShell script. Public surface: `-Device quest|pico|auto`, `-DryRun`, `-NoDeploy`, `-Configuration Development|Shipping`. Auto-detect resolves the target by running `adb devices` (must show exactly one) then `adb shell getprop ro.product.manufacturer` (Oculus → quest, Pico → pico, else error). Pre-flight refuses to run if `DefaultEngine.ini` has uncommitted edits — protects against clobbering dev work-in-progress on the INI. INI mutation uses raw `[System.IO.File]::ReadAllBytes` / `WriteAllBytes` to preserve line endings byte-identically (so the restored file produces zero `git diff`). The cook itself invokes UAT verbatim per `.cursorrules` §8.2 via `cmd /c` (needed for `%CD%` semantics). On a successful cook the APK is renamed from UE's default `VR_Project-arm64.apk` to `VR_Project-Quest-arm64.apk` or `VR_Project-Pico-arm64.apk`. On any failure path (UAT non-zero exit, PowerShell exception, Ctrl-C) the `finally` block restores the INI from an in-memory byte snapshot before the script exits.
- `DefaultEngine.ini`: `[HMDPluginPriority]` baseline restored to the Quest values (`OpenXR=10, PICOXRHMD=0`). This matches what the editor's VR Preview / PIE wants for the Quest+Link in-editor workflow that dominates dev time. The "Pico-targeted (temporary)" comment block from this morning's commit is replaced by a permanent block explaining the per-device cook model + pointing at the script. The original Phase 6D comment block above it stays as historical context, but its closing sentence ("Same APK, deterministic selection per device") is revised to acknowledge that the universal-priority hypothesis was wrong on PICO OS 5+ and to forward-reference the new model.
- `.cursorrules` §8.2 ("The Canonical UAT Command") restructured. The verbatim UAT command is preserved as the authoritative reference for what the wrapper invokes, but the new top of the section makes the wrapper the canonical entry point and notes that direct UAT use is only for debugging the wrapper or reproducing UAT-side issues in isolation. §8.4 (Variants) updated to express each variant as a wrapper flag combination (`-NoDeploy`, `-Configuration Shipping`, `-DryRun`). §8.6 (Output Artifacts) updated to document the per-device renamed APK paths.
- `HowToPort.md` gotcha #12 fully rewritten. The old text described the manual-flip workaround. The new text describes the regression briefly, then the script-based resolution, then a short porting note: drop `Tools/Cook-VRApp.ps1` alongside the C++ files into the target project and adjust the script's `$priorityValues` / `$repoRoot` / `$uprojPath` constants. TL;DR table row for "PICOXR + universal-VR config" also updated.

**Design rationale worth pinning.**

- **The cook wrapper does NOT try to be a universal-APK lie.** A previous-generation hack would have been to keep the marketing-friendly "universal APK" terminology and have the script auto-detect at install time (i.e., a smart launcher .exe that picks the right `.so` to load). That would compound the original mistake: hiding the cross-vendor split inside an opaque wrapper rather than making it explicit at the cook entry point. The script's per-device flag is intentionally visible because cooking artifacts that target different hardware should not look interchangeable in `Binaries/Android/`. Two distinct APK names = two distinct mental models.
- **The "refuse to run if `DefaultEngine.ini` is dirty" pre-flight is load-bearing.** Without it, the failure mode of "dev edited INI for some other reason, ran the script, script crashed mid-cook" would silently lose the dev's edits when the finally block restored from the pre-mutation snapshot. The current behaviour (early-exit with an explanatory error pointing at `git status`) trades a small inconvenience (stash before running) for a strict no-data-loss guarantee.
- **Why the script lives at repo root in `Tools/` and not inside `VR_Project/`.** The script touches paths in both `VR_Project/` (the cook target) and `.cursorrules` (the project convention reference) and is a peer of the other top-level repo artifacts (`README.md`, `Devlog.md`, `Web_Dashboard/`). Putting it inside `VR_Project/` would tie it to UE's editor-managed asset tree. A top-level `Tools/` folder leaves room for future build/deployment scripts (e.g. `Tools/Publish-Dashboard.ps1` when staging deploy lands).
- **Why a PowerShell script and not a Python script or a UAT-native cook profile.** PowerShell is the dev's primary shell (per the system context), already on every Windows dev machine, and integrates cleanly with `adb` + `cmd /c`. A Python equivalent would add a runtime dependency for no benefit. A UAT-native cook profile (Build/Android_Quest/AndroidEngine.ini overlay + UAT extension) was considered but rejected as more invasive — it would require touching Engine source paths or a custom `BuildCookRun` argument list, neither of which is justified by the small mutation surface (two integer assignments in one INI section).

**Validation.** The script's dry-run mode (`.\Tools\Cook-VRApp.ps1 -Device <d> -DryRun`) was used to verify the mutate-and-restore semantics produce zero `git diff` for both `-Device quest` (no-op against the Quest baseline) and `-Device pico` (round-trip through OpenXR=0/PICOXRHMD=10 and back). A full cook + deploy + smoke-test on real hardware for each vendor remains the next physical-validation step but is gated on having the headsets to hand again; the in-script pre-flight + try/finally restore + `git status` check provides a solid theoretical guarantee that a live cook either succeeds and produces a renamed APK or fails and leaves the working tree exactly as it was found.

**Net state.** The per-device cook wrapper is the canonical build entry point as of this entry. The repo `DefaultEngine.ini` is back to the Phase 6D Quest baseline (`OpenXR=10, PICOXRHMD=0`), which means: (a) editor PIE / VR Preview works for Quest+Link out of the box for any dev who pulls latest; (b) a naive `RunUAT.bat` invocation from this checkout produces a working Quest APK; (c) a Pico cook requires the wrapper but is one command (`.\Tools\Cook-VRApp.ps1 -Device pico`) with no manual INI ceremony. The "Proper universal-APK HMD selection fix" backlog item is closed by this entry. The deploy → port → embed plan from the morning planning conversation is unblocked.

### 2026-06-08 (audit) — Agora minute-leak exposure review

Triggered by an "if a headset is left on, won't this burn Agora minutes?" question while writing `HowToDeploy.md`. Audited the cleanup paths across all three sides (headset C++, server, browser JS) to ground the answer rather than guess.

**What's already protected** (the audit's reassuring half): clean-exit paths are solid. `USignalingSubsystem::Deinitialize` emits `headset:end` + sync-disconnects the socket; `UAgoraVideoPump::EndPlay` stops the pump. `HandleRegistrationChanged` does the same on `ClearRegistration`. Server's `pairing.js` disconnect handler prunes rooms after Socket.IO's ~30s timeout. Dashboard pages all have `beforeunload` handlers that call `client.leave()`. Token TTL (30 min default) is a self-correcting safety net for the absolute worst case — even a hung client gets booted from Agora after 30 min.

**What's not protected** (the audit's concerning half): six risk areas, none individually catastrophic but compounding at fleet scale. The dominant one: **no "user took off headset → leave channel" handler anywhere**. The Quest's proximity sleep stops the renderer but the app process + Agora SDK keep publishing. Same on Pico (probably worse). One forgotten overnight headset ≈ $0.72; a 20-device classroom forgotten over a weekend ≈ $58. Other risks: signaling-disconnect doesn't trigger Agora leaveChannel (capped at 30 min by token TTL, so bounded), backgrounded browser tabs keep subscribing (no `visibilitychange` handler), publisher minutes accrue while no instructor is subscribed (the dominant per-session waste — ~10 min/session typical), no server-side session-length cap, no usage/spending visibility (discovery is via the monthly Agora bill).

**No code changes today.** Full sizing + recommended phasing pushed into the new "Agora cost-exposure mitigations" backlog item below. Recommended Phase 1 (~4-5 hours: billing alert + HMD-worn-state idle detection + browser visibilitychange) should land before any real customer traffic. Phase 2 (server-side safety net + usage endpoint) can wait until first revenue-bearing deployment. Phase 3 ("no subscribers → headset idle" auto-leave) is genuinely optional and only worth it if Agora cost becomes a meaningful line item.

### 2026-06-11 — Agora cost-exposure Phase 1 shipped (code half)

Shipped the two code-half mitigations from the 2026-06-08 (audit) entry. The third Phase 1 line item (Agora console billing alert) is a 5-minute manual console click captured as a walkthrough in `HowToDeploy.md` § D.9. After all three are in place, Phase 1 is closed end-to-end.

**Headset side — `UHeadsetPresenceMonitor` (new C++ component, ~120 LOC):**

- New `HeadsetPresenceMonitor.h/.cpp` — `UActorComponent` with a low-frequency `FTimerManager` timer (default 30 s, range 5–300 s). Each tick reads `GEngine->XRSystem->GetHMDDevice()->GetHMDWornState()` (API correction caught at first compile: `GetHMDWornState()` lives on `IHeadMountedDisplay`, NOT on `IXRTrackingSystem` — the 2026-06-08 audit entry cited the wrong interface; route through `GetHMDDevice()` instead), accumulates `NotWorn` duration, and fires `OnHeadsetIdleStarted` once after `IdleThresholdSeconds` (default 120 s) of consecutive `NotWorn`. On the first `Worn` sample after idle, fires `OnHeadsetIdleEnded`. `Unknown` is treated as `Worn` by default (`bTreatUnknownAsWorn=true`) — the conservative choice for cross-vendor deployment because PICOXR's worn-state reporting through the generic OpenXR + `IXRTrackingSystem` path is less reliable than Quest's (often returns `Unknown` when the headset is off). The Pico note in the header documents the inverse setting for Pico-dominant deployments.
- No direct Agora SDK or signaling calls from this component. Same architectural boundary as `UAgoraVideoPump`: C++ owns what BP can't reach (XR system probe + timer + threshold accounting); BP owns the Agora engine lifecycle. BP wiring on `BP_VRPawn`:
  - `OnHeadsetIdleStarted` → `SignalingSubsystem::EmitHeadsetEnd` (server prunes the room) → Agora `Leave Channel` (stops publishing, kills the bill) → `UAgoraVideoPump::StopVideoPump`.
  - `OnHeadsetIdleEnded` → `SignalingSubsystem::RequestSessionResume` (re-emits `headset:register` + re-fetches a fresh token, which because `bHasFiredInitialCredentials` is true fires `OnAgoraChannelChanged`, which the existing channel-swap BP graph from Phase 6D handles — no new BP wiring required for the rejoin cascade itself).
- `VR_Project.Build.cs` — added `HeadMountedDisplay` to `PrivateDependencyModuleNames` for `IXRTrackingSystem.h`. Vendor plugin selection is still controlled by `[HMDPluginPriority]` per the 2026-06-08 per-device cook recipe; this dependency is just the abstract interface.

**Headset side — `USignalingSubsystem` exposure (~30 LOC):**

- `EmitHeadsetEnd` made public + `UFUNCTION(BlueprintCallable, Category = "Signaling")`. Was already implemented; just wasn't reachable from BP. Safe to call when not connected or already-disconnected (no-op in both cases) so the BP graph doesn't need to guard.
- New `RequestSessionResume` BP-callable that re-runs `EmitHeadsetRegister` on the existing socket. Idempotent via `bRegisterInFlight`. The fresh `/api/token` cascade fires `OnAgoraChannelChanged` (because `bHasFiredInitialCredentials` is already true from the original boot) — that's the existing Phase 6D channel-swap path, so no new BP graph branches are needed for the resume side either.

**Web side — `grid.js` visibility-aware suspension (~80 LOC):**

- `document.visibilitychange` listener. On `hidden`: walk every tile client's `remoteUsers` and `unsubscribe(user, 'video')`, walk the focused client's `remoteUsers` and unsubscribe both video and audio, `setEnabled(false)` on the focus mic, swap each tile's UI to a "Paused (tab hidden)" placeholder. On `visible`: walk each client's still-current `remoteUsers` and re-subscribe to whatever's still publishing. We do NOT call `client.leave()` — staying joined to the channel keeps the resume latency at one `subscribe()` round-trip (~500 ms) instead of a full re-join + token-mint. Mic is `setEnabled(false)` rather than `unpublish` because re-enabling is instantaneous; re-publish would re-prompt for mic permissions on some browsers.
- Refactored the `user-published` handlers in both the grid (tile) path and the focus path: extracted `subscribeAndPlayTileVideo(entry, user)` and `subscribeAndPlayFocusTrack(user, mediaType)` helpers so the same subscribe-and-render logic is called from both the original event handler and the visibility-resume path. Added `state.suspended` guard so both `user-published` handlers no-op while hidden (the resume sweep picks them up).
- Mic auto-unmute on resume is deliberately NOT done. If the instructor's tab was hidden for a long meeting break, they may not want to be live the instant they switch back; explicit unmute via the existing mic toggle button is the safer UX. The mic indicator stays muted with the existing UI affordance.

**Cost impact (Phase 1 alone, vs the 2026-06-08 audit baseline):**

- Quest's proximity-sleep "headset on the desk publishing all night" path: bounded from 8h × $0.09/h ≈ $0.72/device/night → 2.5min × $0.09/h ≈ $0.004/device/incident. ~180× reduction.
- "Instructor backgrounded the dashboard tab over a weekend" path: bounded from 6-tile-grid × 48h × $0.05/h ≈ $14.40/forgotten-tab → effectively zero (sub-second of subscription per visibility flip).
- Both paths now have a deterministic cap independent of how long anyone actually leaves things running.

**What's still in front of P1 closure:**

- BP wiring on `BP_VRPawn` for the two `UHeadsetPresenceMonitor` events. ~30 min — drag the new component onto `VRPawn`, wire `OnHeadsetIdleStarted` to the three-node chain (`EmitHeadsetEnd` → `Leave Channel` → `Stop Video Pump`), wire `OnHeadsetIdleEnded` to a single `RequestSessionResume` node. Reference patterns are the existing `OnAgoraChannelChanged` graph (for the resume side, which falls out for free) and the existing `BeginPlay` Agora init chain (for the leave-channel side, just executed in reverse order).
- Manual: log into Agora console → Billing → set monthly threshold alert. The walkthrough is in `HowToDeploy.md` § D.9 (updated this commit to be step-by-step actionable, replacing the previous "coordinate with the VR developer to wire …" placeholder).
- 2-device verification at idle threshold: leave a Quest and a Pico on the desk with the app running, watch `LogVRIPPresence` in logcat fire `OnHeadsetIdleStarted` after 2 min, verify the dashboard tile flips to "ended" (signal that the server received `headset:end`), put the headset back on, watch `OnHeadsetIdleEnded` fire + the tile reappear under the same code. Standard cross-vendor matrix from 2026-06-08 — should take 15 min once both devices are charged.

P2 (server-side max-session-duration safety net + per-tenant usage tracking endpoint) and P3 (no-subscribers headset idle) remain in the backlog at their original sizings — neither needs to land before the first production rollout.

### 2026-06-11 (fix) — Quest verification caught a fundamental design flaw + delegate-driven rewrite

First on-Quest verification of the morning's Phase 1 work failed in an interesting way. The headset was taken off the head at 14:28:00 UTC+2. The 120 s threshold should have triggered `OnHeadsetIdleStarted` at 14:30:00. It never fired. Logcat showed no `LogVRIPPresence` activity at all after take-off, and dashboard server log showed no `headset:end` arriving (room `5981` still active, Agora token still good for ~26 more minutes).

**Diagnosis.** Dumped `/proc/<pid>/status` + the full UE log buffer, which revealed the actual mechanism:

- Process state: `S (sleeping)` — alive but not scheduling the game thread.
- **All log lines after take-off show frame counter `[173]` frozen for 2.5 minutes straight.** The only log activity is `LogAudioMixer` warnings from a worker thread (which keeps running and snapshots the stale `GFrameCounter` every 5 s).
- Frame [0]/[1] timestamps put the freeze at roughly take-off + a few seconds. Game thread stopped ticking ~80–90 s before our 120 s threshold would have fired.

**The 2026-06-08 audit was specifically wrong** about Quest's behavior. The audit claimed *"Quest's proximity sleep stops the renderer but the app process keeps publishing"*. Actually Quest's OS suspends the entire game thread after a short grace period — `FTimerManager` stops ticking with it, so any polling-based design is dead in the water on Quest. The Agora SDK on its own native threads keeps the channel membership alive (= still billable) but our poll-based timer never reaches its threshold.

**Fix.** Switched `UHeadsetPresenceMonitor` from poll-only to two-path detection:

1. **PRIMARY — push-based via `FCoreDelegates::ApplicationWillDeactivateDelegate` / `ApplicationHasReactivatedDelegate`.** These fire *synchronously on the game thread* BEFORE the OS suspends the app. The deactivate handler is our one clean opportunity to emit `headset:end` + `LeaveChannel` before the freeze. BP graph wiring on `BP_VRPawn` is unchanged — the same `OnHeadsetIdleStarted` / `OnHeadsetIdleEnded` events are now broadcast from the delegate handlers as well as the timer.
2. **FALLBACK — pull-based polling as before.** Kept as a slow-rate safety net for desktop dev (PIE / non-VR Editor) where the deactivate delegates don't fire on simple alt-tab, and as a defensive backstop for any vendor whose OS doesn't fire the lifecycle delegates reliably.

Both paths route through new `EnterIdle(Reason)` / `ExitIdle(Reason)` helpers that own the `bIsIdle` state machine — neither path can double-fire the BP events, and `Reason` string flows into the log line so a forensic read-back can tell which path tripped.

**Bonus behavior:** the deactivate path also fires on Quest's universal menu, Guardian setup, system notification overlays, etc. We treat those as "idle" — pause publishing for the overlay's duration, auto-resume on close. Slightly more aggressive than strictly necessary but the cost arrow points the right way (saves minutes during overlays) and the UX impact is small (~1 s dashboard tile flicker on brief overlays).

**Why this took until Quest verification to surface:** the design was based on a reasonable mental model (Quest suspends renderer, not game thread) that turns out to be wrong. The C++ test path through `UnrealBuildTool` confirms compilation but can't simulate the Quest OS lifecycle. PIE-on-PC also wouldn't reproduce because the desktop UE editor doesn't aggressively suspend on alt-tab. The only way to catch this was to run on real Quest hardware — exactly what the 2026-06-08 cross-vendor verification matrix exists for. The bug was caught in the verification cycle it was meant to be caught in.

Verified clean Win64 compile + link via UBT after the rewrite. On-device retest pending the same cook + sideload cycle as before. Devlog 2026-06-11 entry above amended to reflect the corrected design; the original "BP timer on BP_VRPawn polls every 30 s" wording from the 2026-06-08 audit entry stays as-is for historical accuracy (the corrected diagnosis is in *this* entry).

### 2026-06-15 (afternoon) — Phase 7 instructor-view rebuild: IN PROGRESS, mid-integration, NOT committed

**Status: paused at end-of-day, all work uncommitted on local working tree. User picks up tomorrow on a different PC via external drive (same repo, .git intact, in-flight changes travel with it).** Last committed rev is `c39c161` (this morning's per-app control-plane milestone). Everything below is on top of that, none of it pushed.

**What this is.** Replacing the Phase 1/2 `SceneCaptureComponent2D` pipeline (which re-renders the entire scene a second time at 30 Hz to feed Agora) with a "frame hijacking" approach contributed by an external collaborator. New pipeline copies the *already-rendered* stereo frame from one eye into a `UTextureRenderTarget2D` via a `FSceneViewExtension` hook in `PostRenderView_RenderThread` — zero re-render cost. Plus a Mixed-Reality overlay path that composites Quest passthrough camera (via AndroidMedia `vidcap://rear`) over the hijacked frame in a material using HLSL FOV-warping. Pico MR no-ops cleanly (PICOXR uses a different seethrough API not in scope for this pass).

**Locked design decisions (made + confirmed earlier today via interactive AskQuestion):**
- Module placement: C++ in `VR_Project/Source/VR_Project/` + content in new `Content/InstructorView/` folder (NOT a separate plugin — defer plugin extraction to the future `OneBonsaiSignaling.uplugin` pass).
- Pico MR: Quest-only for now; Pico VR-only with MR no-op. Render hijack itself is cross-vendor.
- MR trigger: new **app-agnostic** instructor command `set_mr_mode` with `{enabled: bool}` payload — slots into the per-app control plane shipped this morning.
- Stream resolution: keep 1280×720 (override the colleague's 2016×1760 default at the `StartRenderHijacking` call site).
- Old SceneCapture path: disabled in `BP_VRPawn` but NOT deleted, for one-click revert during device testing.

**Done by agent (uncommitted but on disk):**
- C++ files dropped into `VR_Project/Source/VR_Project/`:
  - `RenderHijackingSubsystem.h/.cpp` — colleague's code with `PICOOOO_API` → `VR_PROJECT_API` rename + new static BP helper `GetRecommendedInputResolution()` that returns `(1500,1850)` for PICOXR runtime and `(1720,1760)` for OpenXR/Quest (detected via `GEngine->XRSystem->GetSystemName().Contains("PicoXR")` — more robust than the colleague's suggested `GetEnabledPlugins().Contains("PicoXR")` which would mis-detect on our universal cook that links both plugins simultaneously).
  - `SceneColorCopyViewExtension.h/.cpp` — colleague's code verbatim (no API tag needed; non-UCLASS).
- `VR_Project.Build.cs` — added `Renderer` module to private deps + `PrivateIncludePathModuleNames` (needed for `FPostProcessMaterialInputs` / `FScreenPassTexture`; may need iteration on first compile).
- `VR_Project.uproject` — enabled `AndroidMedia` plugin (Android-only). **Still pending: `AndroidPermission` plugin** — surfaced during BP wiring as missing for `Check Permission` node; verify it's enabled before tomorrow's first cook (Edit → Plugins → search "Android Permission" → enable if off).
- `DefaultEngine.ini` — `+ExtraPermissions=android.permission.CAMERA` (Quest-only path; Pico ships the perm but never requests it). Also added a `[CoreRedirects]` block to remap `/Script/PICOOOO.RenderHijackingSubsystem` → `/Script/VR_Project.RenderHijackingSubsystem` so the colleague's BP can resolve our class. **In practice the user opted for manual node-swap fixup instead — the redirect is still in place as a belt-and-braces for any other PICOOOO refs that surface.**
- `Web_Dashboard/src/commands.js` — `set_mr_mode` validator added to global `COMMAND_VALIDATORS`. App-agnostic in protocol, opt-in in implementation.
- `Web_Dashboard/docs/commands.md` — new §5 documenting `set_mr_mode` + Pico no-op caveat.
- `.cursorrules` §5.2 — `set_mr_mode` documented with opt-in qualifier.
- `Web_Dashboard/public/index.html` — Enable MR / Disable MR buttons in the focus-view command deck.
- `Web_Dashboard/public/js/grid.js` — `set_mr_mode` branch in `wireCommandDeck` dispatcher with string→boolean coercion.
- Content: 6 `.uasset` files copied to `VR_Project/Content/InstructorView/` (`BP_InstructorViewLogic` 171 KB, `M_InstructorView` 24 KB, `MP_QuestCam` 1.4 KB, `MP_QuestCam_Video` 2.9 KB, `MS_QuestCamera` 1.6 KB, `RT_InstructorView` 4.5 KB).

**Done by user (uncommitted but on disk):**
- `BP_InstructorViewLogic` — colleague's BP loaded with broken class refs (their module was `PICOOOO`, the BP's `Get Subsystem`/`Start Render Hijacking`/`Get Output Render Target` nodes all degraded to "self" because the class path didn't resolve). User opted for manual node-swap fixup rather than relying on the CoreRedirect: deleted the broken nodes, re-added fresh `Get Game Instance Subsystem (URenderHijackingSubsystem)` → `Start Render Hijacking` and `Get Output Render Target` nodes. **Verify when picking up tomorrow:** the `Start Render Hijacking` node has Width=1280, Height=720, and Input Width/Height Override wired from `Get Recommended Input Resolution` (NOT hardcoded Quest values — hardcoded values break Pico). Also worth opening `BP_InstructorViewLogic` and confirming Compile is green + the file is saved. As of this snapshot, `git status` does NOT list `BP_InstructorViewLogic.uasset` as modified, which means either UE auto-saved it back to its on-disk content (unlikely after a meaningful edit) OR the user hasn't pressed Save yet — first thing to verify tomorrow.
- `BP_InstructorViewLogic` — created two new Custom Events: `StartCamera` and `StopCamera` (colleague's .md listed them as recommendations, not pre-built). Implementation follows the .md spec: `Check Permission("android.permission.CAMERA")` → on success → `Open Source` / `Close` on `MediaPlayer` + `Set Scalar Parameter Value` on `DynamicMaterial` (`IsUsingMR` = 1 / 0).
- `BP_VRPawn` — modified (`git status` shows the .uasset is dirty). At minimum: `BP_InstructorViewLogic` added to it as a **ChildActorComponent** (colleague's BP turned out to be parented to `Actor`, not `ActorComponent` despite the .md saying ActorComponent; using it as a ChildActorComponent is the right call here — re-parenting would have risked breaking the colleague's graph). Phase 3 wiring was IN PROGRESS at end of day — `set_mr_mode` handler wiring via `Get Child Actor` → `Cast To BP_InstructorViewLogic` → promote to local var → `Start Camera`/`Stop Camera` per the call chain documented today. **Almost certainly not yet wired:** `UAgoraVideoPump::SourceRT` re-pin from `RT_InstructorStream` → `RT_InstructorView`, and the SceneCapture disable (3 unchecks: Auto Activate, Capture Every Frame, Capture On Movement).

**Tomorrow's pick-up checklist (in order):**

1. **Verify the drive came across with the .git folder intact.** `cd` to project root, run `git status` — should match the full uncommitted list above (modulo whatever BPs the user saves at end-of-day). If `.git` is missing, the working tree is fine but commit/push capability is gone — recover by re-cloning into a sibling dir + copying over the working-tree changes.
2. **Verify all BPs are saved.** Open `BP_InstructorViewLogic` first — confirm it compiles + verify save status. Then `BP_VRPawn` — same. Anything dirty in the editor that wasn't on-disk at unplug time is gone.
3. **Verify `AndroidPermission` plugin is enabled** in `VR_Project.uproject` Plugins list. If not, enable it (Edit → Plugins, search "Android Permission") OR ping me to add it to the .uproject the same way I added AndroidMedia. Without it, `Check Permission` BP nodes won't resolve and `StartCamera` will silently fail at runtime.
4. **Finish `BP_VRPawn` Phase 3 wiring** (whatever's left of these three):
   - `UAgoraVideoPump` component → Details → Source RT dropdown from `RT_InstructorStream` to `RT_InstructorView`.
   - `SceneCaptureComponent2D` → uncheck Auto Activate + Capture Every Frame + Capture On Movement (DO NOT delete — keeps revert path).
   - `On Headset Command` graph → finish the `set_mr_mode` cast chain if not done.
5. **Compile + Save BP_VRPawn.** Confirm green.
6. **Phase 4: Quest device test.** `.\Tools\Cook-VRApp.ps1 -Device quest`, install, grant camera perm on first launch, register, expand tile, verify VR stream renders through new path, click Enable MR overlay, verify passthrough composite appears.
7. **Phase 5: Pico device test.** `.\Tools\Cook-VRApp.ps1 -Device pico`, register, verify VR stream works (frame hijack is platform-agnostic), verify Enable MR button no-ops cleanly (no crash; expected behavior since `vidcap://rear` will fail to open).
8. **Phase 6: cleanup.** Only after both devices green: delete SceneCaptureComponent2D from BP_VRPawn, delete `RT_InstructorStream.uasset` + `M_RTStreamDebug.uasset`, then ping me to update `.cursorrules §1.3` + `HowToPort.md` + write the Devlog "(verified)" follow-up entry + commit + push.

**Known risk areas to watch tomorrow:**
- First C++ compile may fail on `Renderer` module include resolution — UE 5.5 sometimes wants additional include-path massaging beyond `PrivateIncludePathModuleNames.Add`. If it fails, paste the build log; the fix is usually one more line in Build.cs.
- The colleague's right-eye corner-flicker fix in `SceneColorCopyViewExtension.cpp` line 365 (`CroppedSourcePosition.X += SourceDesc.Extent.X - InputWidthOverride`) requires non-zero InputWidthOverride — that's exactly why `GetRecommendedInputResolution()` defaults to Quest dims on unknown runtimes (passing 0 would shift the crop entirely off the texture).
- ChildActorComponent has a "child not yet spawned" race during BeginPlay — `Get Child Actor` can return None. Cast Failed pin handles it gracefully but worth knowing if any "early" wiring is added later (the `set_mr_mode` handler isn't early — instructor commands arrive long after pawn spawn).

**Revert path if something goes catastrophically wrong:** `git checkout -- .` + `rm -rf VR_Project/Content/InstructorView/` + `rm VR_Project/Source/VR_Project/RenderHijack* SceneColorCopy*` returns the working tree to the `c39c161` (per-app control plane) baseline. Last-committed state is fully functional cross-vendor.

### 2026-06-18 (verified) — Phase 7 instructor-view rebuild: Quest end-to-end pass

Closed the Phase 7 integration loop on **Meta Quest 3** after porting the colleague's frame-hijacking stack and finishing the BP wiring on this repo. Instructor dashboard receives a live 1280×720 trainee POV over Agora; `set_mr_mode` toggles the Quest passthrough composite path.

**Verified pipeline (Quest 3, real hardware):**

```
Stereo HMD frame → FSceneColorCopyViewExtension (right-eye crop → 1280×720 internal RT)
                → BP_InstructorViewLogic per-tick composite (M_InstructorView + DrawMaterialToRenderTarget)
                → RT_InstructorView (RTF_RGBA8_SRGB)
                → UAgoraVideoPump::SourceRT
                → Agora → web dashboard focus view
```

Logcat signatures on a healthy session: `RenderHijacking: Started. Output=1280x720`, `SceneColorCapture: Right Eye copy OK ... ArraySize=2`, `StartVideoPump: pumping 1280x720 @ 30.0 Hz`, `Agora PEER JOINED`.

**Integration fixes that were required beyond dropping in the colleague's assets (not bugs in their BP logic — wiring + import context):**

1. **`PICOOOO` → `VR_Project` class remap** — colleague's subsystem nodes degraded to `self` on import; user re-added `Get Game Instance Subsystem (URenderHijackingSubsystem)` nodes manually. `[CoreRedirects]` block kept in `DefaultEngine.ini` as belt-and-braces.
2. **`UAgoraVideoPump::SourceRT`** — re-pinned from legacy `RT_InstructorStream` to `/Game/InstructorView/RT_InstructorView`. With SceneCapture disabled, pumping the old RT produced a uniform black stream (the RT's clear color).
3. **`DrawMaterialToRenderTarget` destination** — the `RT_InstructorView` pin must reference the asset explicitly; a null pin is a silent no-op (Output Log warning: `TextureRenderTarget must be non-null`). Black web video with a healthy hijack + Agora join is the tell.
4. **`BP_InstructorViewLogic` as `ChildActorComponent` on `BP_VRPawn`** — colleague's BP parents to `Actor`, not `ActorComponent`; ChildActor is the correct integration shape here.
5. **SceneCapture path disabled, not deleted** — `SceneCaptureStream` left in place but inactive for one-click revert during bring-up.

**Dashboard side (shipped with this milestone):** `set_mr_mode` validator + focus-view Enable MR / Disable MR buttons; documented in `commands.md` §5.

**C++ additions beyond colleague drop-in:** `GetRecommendedInputResolution()` static helper (Quest 1720×1760 / Pico 1500×1850 via active `IXRTrackingSystem` name, not enabled-plugin probe); `Renderer` module dep in `Build.cs`; `AgoraVideoPump` diagnostic logs (`SourceRT` path + first-frame BGRA sample on pump start).

**Still open (not blocking cross-vendor stream verification):**

- Phase 6 cleanup: delete disabled `SceneCaptureComponent2D`, `RT_InstructorStream`, `M_RTStreamDebug` once comfortable with the hijack path on both vendors.
- `AndroidPermission` plugin enablement in `.uproject` if `Check Permission` nodes need to resolve on a clean clone (Quest MR camera path).
- VRFT `BP_VRPawn` state-update JSON (`Format Text` → `EmitStateUpdateFromJson`) — malformed strings drop `data` on the dashboard; needs a targeted BP or C++ fix (do **not** reintroduce the reverted dashboard state-sync patch — it caused focus-view "connecting" hangs).

**Files in this milestone:** `RenderHijackingSubsystem.*`, `SceneColorCopyViewExtension.*`, `Content/InstructorView/*`, `BP_VRPawn` wiring, `AgoraVideoPump` diagnostics, `DefaultEngine.ini` (CAMERA perm + CoreRedirects), dashboard `set_mr_mode` plumbing, `.cursorrules` / `HowToPort.md` video-pipeline updates.

---

### 2026-06-22 (verified) — Phase 7 cross-vendor closeout: Pico 4 Enterprise + ops docs

Re-verified the Phase 7 hijack → composite → Agora pipeline on **Pico 4 Enterprise** (`PA8E50MGH1111100D`) via `Tools/Cook-VRApp.ps1 -Device pico`. Same UAT pipeline as Quest; only `[HMDPluginPriority]` differs for the cook (`OpenXR=0`, `PICOXRHMD=10`), restored to Quest baseline by the wrapper's `finally` block. APK archived as `VR_Project-Pico-arm64.apk` alongside the Quest build.

**Content tweaks in this submission:** hub/level map updates under `VRTemplate/Maps/` + new `M_Invisible` material (collision/visual pass for instructor-view child actor integration).

**Operational docs refresh:** root `README.md` build section now documents the full self-service cook workflow (close UE Editor first, `DefaultEngine.ini` must be git-clean, `-ExecutionPolicy Bypass` alternative, co-existing Quest/Pico APK names). `HowToPort.md` / `HowToDeploy.md` change logs updated. `Web_Dashboard/README.md` notes `node server.js` when stock PowerShell blocks `npm` scripts.

**Build gotchas reconfirmed on the bench:**
- UE Editor must be closed — Live Coding blocks Android compiles (`Unable to build while Live Coding is active`).
- `Cook-VRApp.ps1` refuses to run if `DefaultEngine.ini` has uncommitted edits (stash/commit first).
- Dashboard local dev: `node server.js` from `Web_Dashboard/` → `http://localhost:3000`.

---

### 2026-06-15 (verified + two fixes shipped along the way) — End-to-end PIE pass: load_level → state transition → UI re-render

Closed out the per-app control plane work with a working end-to-end test from the editor: instructor expands a VRFT tile, sees the level picker rendered from `available_levels` published by the headset, clicks "Level 02", VR app loads the requested map, headset publishes the new state, dashboard transitions from the hub view to the level-active view with a return-to-hub button. Round-trip confirmed both directions, with the headset as the source of truth for the level catalog (so adding maps in the VR app needs zero dashboard changes — per the design intent).

**VR-side wiring (user-side work that completed the loop):** added 4 new maps under `VRTemplate/Maps/` (a dedicated `HUB.umap` + `VRTemplateMap1/2/3.umap` as the three loadable levels), pointed `EditorStartupMap` + `GameDefaultMap` in `DefaultEngine.ini` at `HUB`, added a level-selection actor (`Content/UI/BP_LevelSelectionActor.uasset`) + its widget (`WBP_LevelSelection.uasset`) + a Data Table (`DT_Levels.uasset`) driven by a struct (`ST_Level.uasset`) so the catalog is editable from one place. `BP_VRPawn`'s `BeginPlay` publishes `hub` state with `available_levels` (built from `DT_Levels`) the moment the pawn spawns into the hub map. The `On Headset Command` graph parses `load_level` payloads via the two-step `Construct Json Object → Decode Json` pattern and calls `Open Level by Name`, with each level's `BeginPlay` republishing the new state so the dashboard's UI follows along automatically. Same handler path for `return_to_hub` calls `Open Level by Name HUB`.

**Fix #1: SocketIO `BindEventToFunction` signature trap — latent since Phase 4A, surfaced on the first real command send.** When the user clicked any command on the expanded view, the editor crashed in `USIOJsonValue::AsObject()` reading `0x00000000ffffffff` (textbook garbage-memory deref). Stack pointed at `USignalingSubsystem::HandleHeadsetCommandEvent`. Root cause: the SocketIOClient plugin's `USocketIOClientComponent::CallBPFunctionWithResponse` inspects ONLY the *first* UFUNCTION parameter to decide how to pack arguments into `ProcessEvent`. Our handler signature was `void HandleHeadsetCommandEvent(FString EventName, USIOJsonValue* EventData)` — because the first param was `FString`, the plugin packed a single stringified-JSON argument and called. The `USIOJsonValue*` second param got whatever uninitialised stack memory was at that offset; the very first attempt to dereference it crashed. The binding had been in the codebase since Phase 4A but never actually invoked, because no command had ever been sent through the dashboard until per-app UI shipped today. **Fix: drop the leading `FString EventName` param** — we know the event name from the binding, so it was dead weight. New signature: `void HandleHeadsetCommandEvent(USIOJsonValue* EventData)`. The plugin then correctly packs a wrapped `USIOJsonValue*` and calls. Added a **CRITICAL** warning comment on both the `.h` declaration and the `.cpp` body to prevent regression — anyone tempted to "make it consistent" with the other handlers (which legitimately take `FString` because they only listen to a single event) will see the comment and stop. Captured as **gotcha #13 in `HowToPort.md`**.

**Fix #2: `EmitStateUpdateFromJson` convenience overload.** The original `EmitStateUpdate(FString, USIOJsonObject*)` BP signature is fine for 1–2 scalar fields, but building `available_levels` (an array of 4 objects with 2 string fields each) via individual `Make Array` + `Construct Json Object` + `Set String Field` nodes turned out to be tedious — 30+ pin connections for one state publish, and prone to typos that would break the dashboard render. Added a second BP-callable overload: `void EmitStateUpdateFromJson(FString StateName, FString DataJsonString)`. The user can now build the entire payload as a JSON literal string (or pull it from a Data Table via `Format Text`) and ship it in a single node. Both overloads route through a shared `EmitStateUpdateInternal` private helper that handles `PairingCode` injection, JSON envelope construction, and the actual `emit`. If the JSON string fails to parse, we log a warning and ship the state transition with empty data — the headset still tells the dashboard which state it's in, just without the trimmings. A.4.3 in `HowToPort.md` documents both variants with a "pick whichever is simpler for your data shape" guidance line.

**Doc correction: "Construct Json Object From String" doesn't exist.** Initial guidance to BP authors said to parse `Command.PayloadJson` via a single "Construct Json Object From String" node. That node never existed in the SocketIOClient plugin — the correct pattern is **two nodes in sequence**: `Construct Json Object` (returns an empty `USIOJsonObject*`) → drag off that object → `Decode Json` (input the JSON string, returns bool on parse success, mutates the object in place). User caught this while wiring the `load_level` handler; updated `HowToPort.md` A.4.3 and the original 2026-06-15 Devlog entry's VR-side surface description in the same pass. The TL;DR row for `SignalingSubsystem.h/.cpp` likewise now reads "Construct Json Object + Decode Json" instead of the fictional node name.

**Session-isolation walk-through (user asked, important to document).** With multiple VR sessions running the same `appId` simultaneously, commands and state updates flow only to the intended session. Three layers of isolation, all keying off the 4-digit `code`:

1. **Web → server.** `instructor:command` carries the target `code`; `Web_Dashboard/src/commands.js`'s handler authorizes (instructor must own a registration for that code's tenant) then emits to that specific room only (`io.to(room.headsetSocketId).emit(...)`). Cross-session leakage is structurally impossible — the handler never broadcasts.
2. **Server → VR.** `headset:command` is a direct socket emit, not a broadcast. Each headset socket only receives commands explicitly addressed to it. `USignalingSubsystem` doesn't need to filter — by the time the event reaches the device, it's already known to be for that device.
3. **VR → server → web.** `EmitStateUpdate` injects the current `PairingCode` server-side; `Web_Dashboard/src/pairing.js`'s `headset:state-update` handler looks up the room by code, updates `room.currentState`, and broadcasts `session:state-changed` to (a) the tenant's instructor channel (so the grid view's session list updates) and (b) the legacy 1:1 instructor socket pinned to the code (so the focus view updates). The web client's `grid.js` `session:state-changed` listener updates `state.sessions[code]` unconditionally (since the grid renders all of them) but only re-mounts the per-app panel via `updateAppPanel` if `state.focusedCode === code`. Result: instructor A is focused on session 4242 looking at the level picker; instructor B is focused on session 7777 looking at the level picker; A clicks "Level 02" on 4242; only 4242's headset receives `load_level`; only 4242's UI transitions to `level_loading`; 7777's UI is untouched.

Additional defense: `APP_COMMAND_VALIDATORS[appId]` in `commands.js` ensures a `load_level` accidentally sent to a `VRForklift` session is rejected as "unknown command" rather than silently routed. Even if two different `appId`s share the same 4-digit code (the known pre-existing collision risk that predates this work), command vocabularies stay separate.

**Files modified after the original 2026-06-15 entry.** `SignalingSubsystem.h/.cpp` (signature fix + `EmitStateUpdateFromJson` + critical warning comments), `HowToPort.md` (A.4.3 corrected + gotcha #13 added), this Devlog. The original 2026-06-15 entry has been left in place as the architecture-level record; this follow-up is the "what actually happened when we tested it" record per the same pattern used for Phase 1 (2026-06-11 → 2026-06-11 (fix) → 2026-06-11 (verified)).

**What's not done yet.** Cross-vendor smoke (Quest 3 + Pico 4E APK build with the new BP graphs) — today's verification was PIE-only since the user wanted the milestone shipped. The protocol layer is identical across VR platforms, so no platform-specific failure modes are anticipated; the Quest/Pico-specific risks (HMD plugin priority, input mappings) are already settled per gotchas #11 + #12. To-do: when the user next has both devices on the bench, build the universal APK, register both to the same tenant, expand one tile, change its level, verify the other session is unaffected.

---

### 2026-06-15 — Per-app interactive control plane (bidirectional VR ↔ dashboard JSON protocol)

Stood up the abstraction that lets each VR application (VRFT today, future VRForklift / VRChemSafety / etc.) drive a fully custom instructor panel from inside the headset. End goal as articulated by the user: instructor clicks a tile, the dashboard recognises which VR app + what state the session is in, renders the matching UI (e.g. "user is in the hub" → level picker), instructor clicks a level button, headset receives the command + loads that level, headset publishes the new state, dashboard UI re-renders accordingly. All over JSON, all routed through the existing Socket.IO signaling plane.

**Three new contracts**, all additive (existing VR builds that don't opt in keep working):

1. **`headset:state-update` (headset → server → instructors).** New Socket.IO event. Payload: `{ code, state, data?, seq? }`. Server caches the latest state on the room (so newly-connecting instructors see current state in their `sessions:changed` snapshot), fans out a `session:state-changed` event to subscribed instructor sockets + the legacy 1:1 instructor pinned to the code. Server-side sliding-window rate limit (30 messages per 3-second window per code) catches misbehaving BP graphs that tick every frame. State data is size-capped at 8 KB serialised to bound `ROOMS`-map memory growth.

2. **App identity in `headset:register`.** Two new optional fields: `appId` (e.g. `"VRFT"`, must match `/^[A-Za-z][A-Za-z0-9_-]{0,31}$/` — also used to safely construct the dashboard's dynamic-import URL) and `appVersion` (free-form, truncated to 32 chars). Both flow into the room state + every `sessions:changed` broadcast so the dashboard knows which per-app UI module to load. Existing pre-2026-06-15 VR builds register without these fields and get the generic fallback panel — same backward-compat shape that `scenario` and `traineeName` had when those landed.

3. **App-aware command validation.** `Web_Dashboard/src/commands.js` grew an `APP_COMMAND_VALIDATORS` map keyed by `appId`. The instructor → headset command forwarder now looks up the room's `appId` and checks the app-scoped table first, falling back to the global `COMMAND_VALIDATORS` for the four app-agnostic commands. A `load_level` command sent to a `VRForklift` session would be rejected as unknown (defence against typos + future cross-app confusion). The forwarding handler also reordered: room-lookup BEFORE validation, since validation now needs to know the room's `appId`.

Full wire-protocol spec lives in two complementary docs: `Web_Dashboard/docs/state-updates.md` (new, headset → dashboard direction) and `Web_Dashboard/docs/commands.md` (extended, dashboard → headset direction, now with `App-specific commands` section + per-`appId` subsections). Both cross-link.

**VR-side surface (USignalingSubsystem extensions).** Three additions to the BP-callable / BP-readable surface:

- `EmitStateUpdate(FString StateName, USIOJsonObject* Data)` — BP-callable. Fire-and-forget. Auto-injects the current `PairingCode`; BP author only passes the state name + an optional USIOJsonObject built via the SocketIO plugin's `Construct Json Object` + setter nodes.
- `AppId` / `AppVersion` — new `BlueprintReadOnly` properties loaded from `Config/DefaultGame.ini`'s `[/Script/VR_Project.SignalingSubsystem]` section (`AppId=VRFT` + `AppVersion=1.0.0` added for the test build). Sent in `headset:register` only when non-empty, so legacy INI files without these keys still register cleanly.
- `FSignalingCommand::PayloadJson` — new field on the inbound-command struct, populated with the full JSON of every received command via `FJsonSerializer::Serialize` with a condensed print policy. BP for app-specific commands (e.g. VRFT's `load_level`) parses this with the SocketIO plugin's two-step `Construct Json Object` → `Decode Json` pattern (both under category `SIOJ | Json`) and reads `level_id` etc. directly. The legacy typed fields (`BoolValue`, `StringValue`) stay populated for the four app-agnostic commands so existing BP graphs keep working unchanged.

The whole VR side is opt-in: a target project that leaves `AppId` blank still streams video, still accepts the four legacy commands, just doesn't get app-specific dashboard UI. The portability story (per `HowToPort.md`) is unchanged — copy 2 C++ files, fill in the INI, optionally write a JS file for the dashboard.

**Web-side architecture — per-app modules under `Web_Dashboard/public/js/apps/`.** Each VR app that wants a custom instructor panel ships a single ES module named after its `appId` (e.g. `apps/VRFT.js`). A loader (`apps/_loader.js`) dynamic-imports the module based on the focused session's `appId`, mounts it into a new `#focus-app-panel` container that sits above the existing app-agnostic command deck in the focus view, forwards `session:state-changed` socket events to the module's `update()` hook, and tears down cleanly on focus exit. Modules with malformed `appId`, missing files, or `mount()` exceptions collapse cleanly to `apps/_fallback.js` (a static "no per-app UI module for this appId" notice) — a single broken module never breaks the dashboard. Module shape, lifecycle, and the per-app `sendCommand` callback convention are documented in `Web_Dashboard/public/js/apps/README.md`.

**First concrete module: `apps/VRFT.js`.** Implements the five-state machine documented in `state-updates.md` § VRFT (`boot` → `hub` → `level_loading` → `level_active` → `level_complete`). Hub state renders a level picker driven entirely by `data.available_levels` (so new levels added in the VR app don't require a dashboard redeploy — VR is the source of truth for "what content exists"). Level-active and level-complete states render a return-to-hub button + a generic metadata-chip helper that surfaces whatever extra fields the VR app publishes (elapsed time, current step, outcome, etc.) without the module needing to know their names ahead of time. Unknown-state path renders a developer-friendly diagnostic showing the raw `data` JSON. The module uses the existing CSS classes (`command-btn`, `chip`, etc.) so it visually matches the rest of the dashboard with zero new design language.

**The split between fixed vs. data-driven UI is deliberate.** The web module knows the *shape* of the VRFT state machine (which states exist, which commands map to which buttons, the JSON envelope for each command) — that's app logic the VR app should not have to push every frame. The *content* inside each state (the actual level list, current level name, elapsed time) flows from the VR app via `data` payloads, which means content updates (new scenarios, renamed levels, customer-specific DLC) ship via the VR build alone with no dashboard change required. This was the right call per the user's instinct: dashboard knows the menu structure, headset is the source of truth for what's on it.

**HowToPort.md updates.** TL;DR table row for `SignalingSubsystem.h/.cpp` rewritten to call out the new BP-callable surface + cross-link the wire-protocol docs. New TL;DR row for the per-app dashboard module convention. Recipe A.3 INI snippet now includes `AppId` + `AppVersion`. New sub-recipe **A.4.3** documents the BP wiring for any target project that wants per-app instructor UI (state-publish on every transition, command-handle via `PayloadJson` + SocketIO JSON parse nodes). Change-log row added.

**Files changed.** Server: `Web_Dashboard/src/pairing.js` (`headset:state-update` handler, room state cache, `appId`/`appVersion` on register, `broadcastStateChanged` helper, rate limiter, cleanup hooks); `Web_Dashboard/src/commands.js` (`APP_COMMAND_VALIDATORS` map + VRFT validators, app-aware `validateCommand(payload, appId)`, handler reordering). VR: `VR_Project/Source/VR_Project/SignalingSubsystem.h/.cpp` (3 new BP-visible surfaces as above); `VR_Project/Config/DefaultGame.ini` (`AppId=VRFT` + `AppVersion=1.0.0`). Web: `Web_Dashboard/public/index.html` (`#focus-app-panel` section); `Web_Dashboard/public/js/grid.js` (loader imports, `socketRef`, `session:state-changed` handler, `mountAppPanel` on focus enter, `unmountAppPanel` on exit, `makeFocusCommandSender` factory); `Web_Dashboard/public/js/apps/_loader.js`, `_fallback.js`, `VRFT.js`, `README.md` (new); `Web_Dashboard/public/css/style.css` (`focus-app-panel` block). Docs: `Web_Dashboard/docs/state-updates.md` (new); `Web_Dashboard/docs/commands.md` (extended app-specific section + cross-link); `HowToPort.md` (TL;DR + A.3 INI + new A.4.3 recipe + change-log row).

**What's not done yet.** The VR-side state-publish + command-handle BP graphs in `BP_VRPawn` (the user said they'll add the levels + selection UI in the VR app for testing — that work is in their lap). Once those land, end-to-end test: open the dashboard, expand a VRFT tile, see the level picker appear, click "Load Kitchen Fire", see VR load the level + dashboard transition to the active-level view. The protocol + plumbing + dashboard side are ready to receive.

### 2026-06-11 (verified) — Phase 1 cross-vendor pass on Quest 3 + Pico 4 Enterprise

Cook-and-sideload cycle on both vendors with the delegate-driven `UHeadsetPresenceMonitor` from the fix entry above. Both passed end-to-end against the server-side `headset:end` arrival check (the only ground-truth signal that the Agora bill actually stops accruing).

**Quest 3 — clean pass.** Logcat timeline for one full take-off / put-back-on cycle:

```
15:38:54.382  LogCore:                AppLifetime: Application will deactivate
15:38:54.434  LogBlueprintUserMessages: [VRPawn_C_2147482464] Agora LEFT channel       (+52 ms)
   ↳ server log:  [VRIP] headset:end code=0897 tenant=onebonsai
15:39:04.330  LogVRIPPresence:        ExitIdle (ApplicationHasReactivated) — firing OnHeadsetIdleEnded
15:39:04.330  LogVRIPSignaling:       RequestSessionResume: re-registering code=0897
15:39:04.482  LogVRIPSignaling:       /api/token 200: channel=t-onebonsai-0897         (+152 ms)
15:39:04.483  LogVRIPSignaling:       /api/token: subsequent credentials → firing OnAgoraChannelChanged(t-onebonsai-0897)
   ↳ existing Phase 6D channel-swap BP graph picks up and rejoins
```

The 52 ms gap from "OS told us we're deactivating" to "BP completed `Leave Channel`" is the delegate handler firing synchronously on the game thread, broadcasting `OnHeadsetIdleStarted`, and the BP wiring (`EmitHeadsetEnd → Leave Channel → Stop Video Pump`) completing — all before the OS suspended the game thread per the fix entry above. The 10-second pre-resume gap is just the time it took to put the headset back on; once `ApplicationHasReactivated` fired, the re-register + token-mint + channel-rejoin cascade took 152 ms.

**Pico 4 Enterprise — pass, with a first-boot stutter noted as a follow-up.** Server log for the Pico session (code `6747` on tenant `securitas`) shows four successive take-off / put-back-on cycles, each with a properly received `headset:end` followed by re-registration and fresh token issuance:

```
13:49:14  headset:register  → publisher + subscriber tokens
13:49:51  headset:end       → headset:register  → fresh tokens     (~30 s on, take-off, put-back-on)
13:55:05  headset:end       → headset:register  → fresh tokens     (~5 min on, take-off, put-back-on)
13:55:17  headset:end       → headset:register  → fresh tokens     (~12 s on, take-off, put-back-on)
13:55:17  headset:end                                                (final take-off, session ended)
```

The 30 s register-to-end cycle on the first iteration is well under the 120 s polling threshold, so this was the delegate path firing — not the polling fallback. `FCoreDelegates::ApplicationWillDeactivateDelegate` is wired by UE for any Android XR runtime, so Pico benefits from the same push-based detection Quest does. No vendor-specific code path was needed for the fix to work on Pico.

**The first-boot stutter (logged separately as a follow-up, not a P1 blocker).** First cold launch of the freshly-installed Pico APK got stuck on the Unreal splash screen indefinitely. The app process was alive and rendering at 90 FPS (per Pico's `PxrMetric` log: `FPS=90/90, GPU=99%/587Mhz, LayerCnt=1, Pkg=com.Thomas.VRProject, FrmId=7353+`), PICOXR runtime had loaded successfully (`PxrLoader: LoadRuntime succeeded` + `xrCreateInstance succeeded`), but **zero `UE:`-tagged log lines ever appeared**, suggesting Unreal's main-level load never completed. A clean `adb shell am force-stop` + `am start` on the same APK fixed it — second launch booted normally and ran the full take-off / put-back-on test cycles above. The diagnostic shape is similar to (but distinct from) the 2026-06-08 HMD-priority deadlock: native runtime up, foreground app rendering, but UE init somehow stalled. Symptom probably correlates with the rapid `ActivityResumed` / `ActivityPaused` cycles Pico's system shell triggers during initial app placement (logcat shows three resume/pause pairs in the first 0.5 s after launch). Backlogged below; doesn't block P1 closure because force-stop-then-restart is a reliable workaround and the bug is at app *launch*, not during the running session.

**Net state.** Phase 1 P1 code half is verified cross-vendor against the server-side `headset:end` ground truth. Only the 5-minute Agora console billing alert click-through remains for full P1 closure (manual step per `HowToDeploy.md` § D.9).

### Open Backlog Items

- **Phase 4 Phases C–D — final BP integration:** (1) `WBP_PairingHUD` UMG widget showing the pairing code + connection state, added to viewport from BeginPlay; (2) `OnHeadsetCommand` bound graph on `BP_VRPawn` that switches on `Command` and fires per-command BP events (`pause_simulation` toggles `Set Game Paused`; others log to HUD).
- **Phase 4 Phase E token refresh — BP wiring.** Bind Agora's `OnTokenPrivilegeWillExpire` → call `Get Signaling Subsystem → RefreshToken` → on the subsystem's `OnTokenRefreshed` delegate, call Agora's `renewToken` with the freshly-populated AgoraToken. C++ side is already wired; this is one BP graph edit.
- **Phase 5:** broader instructor-facing polish (per-tenant branding, real session metadata from the headset rather than the stub).
- **Phase 6 — Multi-tenant SaaS layer.** ~~Instructor authentication (Clerk/Auth0/Supabase Auth with `tenantId` JWT claim), customer admin page (Org dashboard + Organization Pairing Code generation), `POST /api/orgs/redeem` endpoint, persisted-tenantId storage on the headset side, server-side JWT-claim enforcement on all existing endpoints.~~ **Scope revised 2026-06-04; Phases A/B/C/D shipped 2026-06-04 through -05.** Server-side multi-tenant cookie auth + `tenant-codes.json` + login flow (A/B/C) and VR-side `UTenantRegistry` + persisted registration + mid-session channel-swap state machine (D + 2026-06-05 channel-swap fix) are all live and validated single-device. Remaining work: (1) swap `tenants.js::resolveByCode()` to call OneBonsai's existing portal endpoint when it's exposed (one-line `fetch()` change — the `tenant-codes.json` file *is* the contract spec for that integration); (2) pick + ship one of the 4 dashboard embedding patterns from the 2026-06-04 scope-revision entry (default trajectory: iframe first, subpath reverse-proxy when iframe auth quirks bite); (3) server hardening pre-prod (CORS lockdown, TLS, persistent DB for per-tenant Agora creds via the `getAgoraCredentials(tenantId)` seam that already exists); ~~(4) the 2-device validation test (Quest=Securitas, Pico=CustomerX, two browser instructors see fully separated grids) — mostly de-risked by single-device validation but worth doing once both devices are charged and to hand.~~ **(4) shipped 2026-06-08** — exhaustive 2-device cross-vendor matrix on real Quest 3 + Pico 4 Enterprise passes (same-tenant both devices, cross-tenant both devices, single-device, mid-session switch-org); see Devlog 2026-06-08.
- Rename `VRPawn` → `BP_VRPawn` to match `.cursorrules §4.2` naming convention (cosmetic refactor; not urgent).
- Re-color the four Phase 2 Print Strings (currently all yellow) — green/red/cyan/yellow for join/error/peer-join/leave readability.
- Tighten Socket.IO CORS before any LAN/internet-facing deploy (currently permissive for development).
- Implicit-room server fallback: if a peer publishes on `t-<tenant>-XXXX` with no matching room, auto-create one so real headsets can show up in the grid even without the stub. Eliminates stub-mode entirely.
- **Video pump heartbeat log.** Periodic `Display`-level log on `UAgoraVideoPump` ("pushed N frames in last 5s, ~M Hz") so a missing heartbeat on the receiver becomes a one-grep root-cause clue when the pump silently succeeds but no frames arrive (the failure mode that masked the 2026-06-05 channel-swap bug for a full repro cycle). Cheap to add; high diagnostic ROI.
- **Per-developer `ServerUrl` override** to avoid committing a specific LAN IP in `DefaultGame.ini`. Two options: (1) ship a documented `Saved/Config/Windows/Game.ini` template and `.gitignore` the real file; (2) switch the default to an mDNS `.local` hostname so the IP doesn't matter at all. Picking (2) also fixes the Quest-side cross-network case since libcurl on Quest 3 resolves `.local` via Bonjour out of the box.
- Meta-store-compliant build flavour: separate `Config/Android_Meta/AndroidEngine.ini` overlay that flips `MinSDKVersion=32`, disables PICOXR, restores Meta-only manifest entries — required if/when we publish to the official Meta store. Universal sideload APK remains the dev default.
- ~~**Proper universal-APK HMD selection fix (replaces today's Pico-only `[HMDPluginPriority]` workaround).** Three candidate approaches: (a) C++ runtime probe in a `UVRBootstrapSubsystem` (or similar early-init hook) that calls into Android's `Build.MANUFACTURER` via JNI, then uses `IModularFeatures::Get().UnregisterModularFeature(...)` to hard-disable the wrong HMD provider before `FEngineLoop::PreInit` reaches HMD selection; (b) per-device cook profile via `Config/Android_Pico/AndroidEngine.ini` overlay flipping `[HMDPluginPriority]`, paired with a UAT wrapper script that picks the overlay based on which device is on ADB (or an explicit `-targetdevice=quest|pico` arg); (c) submit a patch to PICOXR's `IsHMDConnected()` so it actually probes the PXR runtime (`Pxr_GetSystemId` or equivalent) rather than relying on the generic OpenXR loader — likely also needs the symmetric patch in Epic's OpenXR plugin to probe for Meta-specific extensions.~~ **Shipped 2026-06-08 (follow-up entry)** via approach (b): `Tools/Cook-VRApp.ps1` wrapper script + Quest baseline restored to `DefaultEngine.ini`. Universal-APK promise is now explicitly a per-device cook model; both vendors' APKs co-exist on disk as `VR_Project-Quest-arm64.apk` / `VR_Project-Pico-arm64.apk`. Approaches (a) and (c) remain available if the two-APK output ever becomes friction; (b) was picked as lowest-risk-today + most-portable to other UE projects.
- **Cross-vendor IMC audit for `IMC_Hands`, `IMC_Weapon_Right`, `IMC_Weapon_Left`.** Today's 2026-06-08 fix only extended `IMC_Menu` and `IMC_Default` with `PICOTouch_*` bindings; the remaining three IMCs are still OpenXR-only. Any feature that depends on those for input will work on Quest and silently no-op on Pico. The fix shape is identical to today's (add PICOTouch rows alongside existing OculusTouch ones, same IA); just hasn't been done because Phase 6's gate-widget happened to need only IMC_Menu + IMC_Default for the trigger-click path. Schedule when any of the three IMCs becomes load-bearing for a cross-vendor demo.
- **Agora cost-exposure mitigations (gate before any production rollout).** Full diagnosis in the 2026-06-08 audit entry above; Phase 1 closeout in the 2026-06-11 entry. TL;DR: clean-exit paths are solid but idle/forgotten/backgrounded cases burn billable minutes invisibly. Six sized line items, ordered by ROI:
  - **(P1, 5 min, manual)** Agora console billing alert at $X/month threshold. Doesn't prevent anything — turns "discovered from monthly invoice" into "alerted before damage compounds." Step-by-step walkthrough now lives in `HowToDeploy.md` § D.9; remains a manual click-through (Agora's console is not API-scriptable for billing alerts). Do this before deploying anywhere a real headset can reach.
  - ~~**(P1, ~3 hours)** Headset HMD-worn-state idle detection.~~ **Shipped 2026-06-11 + verified cross-vendor same day** as `UHeadsetPresenceMonitor` (new C++ component, ~120 LOC) + `USignalingSubsystem::EmitHeadsetEnd` exposed BP-callable + new `USignalingSubsystem::RequestSessionResume` BP-callable, with a delegate-driven primary detection path (`FCoreDelegates::ApplicationWillDeactivateDelegate` / `ApplicationHasReactivatedDelegate`) and the original timer-based polling kept as a fallback. Verified end-to-end on Quest 3 (~52 ms take-off latency) and Pico 4 Enterprise (delegate path fires on Pico too; four take-off cycles all delivered `headset:end` to the server). Full timeline + server logs in the 2026-06-11 (verified) Devlog entry. The Pico-fallback knob ended up as `bTreatUnknownAsWorn` (conservative default `true`, flip to `false` + raise `IdleThresholdSeconds` for Pico-dominant deployments). **API correction:** `GetHMDWornState()` is declared on `IHeadMountedDisplay`, not on `IXRTrackingSystem` as this audit originally cited — the component routes through `GEngine->XRSystem->GetHMDDevice()->GetHMDWornState()`. BP wiring on `BP_VRPawn` is the only ~~remaining~~ ~~step~~ — shipped + verified 2026-06-11.
  - ~~**(P1, ~1 hour)** Browser tab `visibilitychange` → unsubscribe from tiles.~~ **Shipped 2026-06-11** in `Web_Dashboard/public/js/grid.js`. Both grid mode (tiles) and focus mode (video + audio + mic) suspend on `visibilityState === 'hidden'` and resume on `'visible'`. Clients stay joined to the channel (resume latency ≈ one `subscribe()` round-trip, ~500 ms); only subscriptions go away. Mic auto-unmute on resume is intentionally NOT done — explicit toggle preserves "I tabbed away then came back" UX safety.
  - **(P2, ~2 hours)** Server-side max-session-duration safety net. Per-room timer in `pairing.js`; when a room hits N hours (default 8h = a workday), force-prune it and emit `session:status: 'ended'`. The headset reconnects under the same code if still alive (Agora already kicks it via token TTL anyway). Configurable per-tenant for customers who run long-form training. Bounds the worst-case cost of a bug-stuck or network-partitioned session.
  - **(P2, ~half day)** Per-tenant usage tracking endpoint. `/api/admin/usage` returning minutes published/subscribed per tenant per day, computed from Socket.IO room-presence durations. Doesn't query Agora directly (that would need their REST API + a polling job); approximates well enough for spending visibility + per-tenant chargeback if that's ever a billing model. Catches anomalies (e.g., a tenant whose minutes spike 10× one day) before the monthly Agora invoice does.
  - **(P3, ~4-6 hours, real UX decision)** "No subscribers → headset goes idle" optimization. Server tracks subscriber count per room. After N minutes of zero subscribers, server emits a `headset:command` telling the headset BP graph to `LeaveChannel` + display a "waiting for instructor" overlay. Headset re-joins when the server signals first subscriber arrives. Eliminates the per-session "headset publishing into an empty channel" waste (~10 min/session typical). The UX cost is added latency when an instructor joins mid-session (currently instant; would become ~3s for the headset to re-join Agora + start publishing). Worth it if Agora minutes become a meaningful line item; premature otherwise.

  Recommended phasing: P1 (~4-5h total) before any production rollout — code half shipped 2026-06-11, only BP wiring + console click remain. P2 (~6h total) before scaling beyond the first paying customer. P3 only if cost analysis justifies it.
- OpenXR localization warnings in the Output Log (low priority cosmetic).
- 10-bit swapchain fallback messages (low priority cosmetic).
- **Pico first-boot splash-stall (workaround: `adb shell am force-stop` + restart).** Observed 2026-06-11 during cross-vendor verification cook for the Phase 1 fix. Symptom: first cold launch of a freshly-installed APK on the Pico 4 Enterprise gets stuck on the Unreal splash indefinitely — process is alive and rendering at 90 FPS (PICOXR runtime loaded successfully, `xrCreateInstance` succeeded, frame counter incrementing), but no `UE:`-tagged log lines ever appear, indicating Unreal's main-level load never completes. A `force-stop → am start` cycle on the same APK boots normally and the app runs fine for arbitrary durations afterwards. Likely correlated with the rapid `ActivityResumed`/`ActivityPaused` cycles Pico's system shell triggers during initial placement (3 resume/pause pairs in the first 0.5 s). Not a Phase 1 blocker because (a) workaround is reliable and (b) the bug is at app *launch*, not during the running session — once running, take-off / put-back-on detection works correctly. Diagnostic shape differs from the 2026-06-08 HMD-priority deadlock (there, native runtime was the holdup; here, runtime is up and rendering, but UE init is stalled). Investigation paths if/when this becomes user-visible (it doesn't today — devs cook + sideload, then the script's `am start` works fine on the *second* launch UAT does): (a) instrument early-boot UE init around `FEngineLoop::PreInit` with Pico-side `__android_log_print` to find which init phase the stall actually sits in; (b) add a 500 ms delay between the cook script's `adb install` and `am start` to let the system shell settle; (c) check if UE 5.5 has a known issue with rapid Android lifecycle callbacks during init (worth a brief AnswerHub search before deeper instrumentation).
