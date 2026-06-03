# Developer Log: VR Instructor Portal

## Current Project Status

**Phase:** Agora streaming integration — **Phase 3 fully polished in PIE.** Video stream verified end-to-end (Quest scene → `RT_InstructorStream` → `UAgoraVideoPump` → `pushVideoFrame` → Agora SD-RTN → web demo video pane shows correctly-exposed scene content). All three deferred polish items from 2026-06-01 are now resolved: frame-rate spikes (SceneCapture timer 10× over-capture corrected + readback moved to async), dark receiver exposure (RT format flipped to sRGB-encoded), and diagnostic logging stripped. The only remaining Phase 3 item is a fresh Quest verification of the polished build before declaring Phase 3 closed.

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

### Open Backlog Items

- **BP polish (do before any fresh install scenario):** bump BeginPlay `Delay` 0.1s → 0.5s (or 1.0s) to eliminate the cold-launch permission race documented in the 2026-06-01 on-headset entry.
- **Phase 3 — Quest verification of the polished build:** deploy with the 2026-06-03 polish in place (async readback, 30 Hz timer, `RTF_RGBA8_SRGB` RT) and confirm the web demo on a phone-hotspot receiver shows correctly-exposed scene content at steady 30 fps with no game-thread spikes. The original 2026-06-01 in-flight build is obsolete — re-run UAT from scratch. If Quest exhibits any new symptom, previously-documented fallbacks still apply: `VIDEO_PIXEL_BGRA` → `VIDEO_PIXEL_RGBA` for red-blue swap; profile pump CPU cost if frame pacing degrades.
- **Phase 4:** scaffold `Web_Dashboard/` (Node.js + Express + Socket.IO) per `.cursorrules §3` and `§4.3`, with `agora.js` token minter per `§4.3.1` (single shared App ID / channel-naming-convention tenant isolation, 30–60 min token TTL, usage-row logging, **per-channel token binding — never reuse across channel names**).
- **Phase 5:** instructor SPA — 4-digit code gatekeep, two-column dashboard (stream view + control deck), JSON command dispatch per `§5.2`.
- Move the prototype App ID / Token out of BP into a non-source-controlled config asset once Phase 4 lands.
- Rename `VRPawn` → `BP_VRPawn` to match `.cursorrules §4.2` naming convention (cosmetic refactor; not urgent).
- Re-color the four Phase 2 Print Strings (currently all yellow) — green/red/cyan/yellow for join/error/peer-join/leave readability.
- OpenXR localization warnings in the Output Log (low priority cosmetic).
- 10-bit swapchain fallback messages (low priority cosmetic).
