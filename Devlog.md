# Developer Log: VR Instructor Portal

## Current Project Status

**Phase:** Agora streaming integration — **Phase 3 closed; first piece of Phase 4 (Web_Dashboard) scaffolded.** End-to-end Quest 3 verification passed on Vulkan/arm64: correct sRGB exposure, stable 30 fps under head movement, bidirectional audio intact. The trainee POV streams cleanly into a self-hosted receiver page (no longer dependent on Agora's hosted demo URL). Bidirectional voice now works in both directions (Step 1.5 polish on the MVP added the instructor mic publish + mute/speaker/volume controls). The Phase 4 server (Express + Socket.IO + token minter + pairing + command relay) is scaffolded per `.cursorrules §3 / §4.3 / §4.3.1 / §5` but not yet wired into the SPA — that's the next discrete unit of work.

Build & deployment pipeline validated end-to-end on Quest 3. Phase 1 (SceneCapture → RT → debug material) and Phase 2 (Agora audio join + event handlers + lifecycle + on-device round-trip) are both complete. Project is Blueprint + minimal C++ scaffolding (required by the Agora plugin's compile chain — see 2026-06-01 first entry). Pinned plugin version is **v4.5.1** (revised up from v4.5.0 after empirical UE 5.5.4 validation).

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

### Open Backlog Items

- **Phase 4 Phases C–D — final BP integration:** (1) `WBP_PairingHUD` UMG widget showing the pairing code + connection state, added to viewport from BeginPlay; (2) `OnHeadsetCommand` bound graph on `BP_VRPawn` that switches on `Command` and fires per-command BP events (`pause_simulation` toggles `Set Game Paused`; others log to HUD).
- **Phase 4 Phase E token refresh — BP wiring.** Bind Agora's `OnTokenPrivilegeWillExpire` → call `Get Signaling Subsystem → RefreshToken` → on the subsystem's `OnTokenRefreshed` delegate, call Agora's `renewToken` with the freshly-populated AgoraToken. C++ side is already wired; this is one BP graph edit.
- **Phase 5:** broader instructor-facing polish (per-tenant branding, real session metadata from the headset rather than the stub).
- **Phase 6 — Multi-tenant SaaS layer.** ~~Instructor authentication (Clerk/Auth0/Supabase Auth with `tenantId` JWT claim), customer admin page (Org dashboard + Organization Pairing Code generation), `POST /api/orgs/redeem` endpoint, persisted-tenantId storage on the headset side, server-side JWT-claim enforcement on all existing endpoints.~~ **Scope revised 2026-06-04** — OneBonsai already operates an internal app-management portal that mints + redeems organization registration codes for other in-house apps. Phase 6 becomes "hook into that portal" instead of "build a parallel customer admin page": persisted-tenantId on the headset side + first-launch UMG that calls the portal's `POST /api/register/redeem` + server-side JWT enforcement using the portal's auth tokens. The 4 instructor-overview embedding patterns (iframe / reverse-proxy / JS SDK / native port) are pre-architected in the 2026-06-04 Phase 6 scope-revision entry — current recommendation is "iframe first, reverse-proxy when iframe auth quirks bite."
- Rename `VRPawn` → `BP_VRPawn` to match `.cursorrules §4.2` naming convention (cosmetic refactor; not urgent).
- Re-color the four Phase 2 Print Strings (currently all yellow) — green/red/cyan/yellow for join/error/peer-join/leave readability.
- Tighten Socket.IO CORS before any LAN/internet-facing deploy (currently permissive for development).
- Implicit-room server fallback: if a peer publishes on `t-<tenant>-XXXX` with no matching room, auto-create one so real headsets can show up in the grid even without the stub. Eliminates stub-mode entirely.
- Meta-store-compliant build flavour: separate `Config/Android_Meta/AndroidEngine.ini` overlay that flips `MinSDKVersion=32`, disables PICOXR, restores Meta-only manifest entries — required if/when we publish to the official Meta store. Universal sideload APK remains the dev default.
- OpenXR localization warnings in the Output Log (low priority cosmetic).
- 10-bit swapchain fallback messages (low priority cosmetic).
