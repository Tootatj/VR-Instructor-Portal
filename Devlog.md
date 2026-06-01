# Developer Log: VR Instructor Portal

## Current Project Status

**Phase:** Agora streaming integration — Phase 2 in progress (plugin installed, BP join flow being wired). Project is now Blueprint + minimal C++ scaffolding (required by the Agora plugin's compile chain — see 2026-06-01 entry).

Build & deployment pipeline is fully validated end-to-end on Quest 3. Phase 1 (SceneCapture → RT → debug material) is complete; the RT samples correctly on the in-level debug plane in non-VR PIE, VR Preview, and on-headset.

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

### Open Backlog Items

- **Phase 2 finalization:** bind `OnJoinChannelSuccess` / `OnError` / `OnUserJoined` / `OnLeaveChannel` off `Get Event Handler`, then PIE→web-demo sanity test.
- **Phase 3:** push `RT_InstructorStream` as a custom Agora video source (BP if available, else minimal C++ wrapper for `IVideoFrameSource::onFrame`). Includes RGBA → YUV420 conversion at 1280×720 / 30 fps.
- **Phase 4:** scaffold `Web_Dashboard/` (Node.js + Express + Socket.IO) per `.cursorrules §3` and `§4.3`, with `agora.js` token minter per `§4.3.1` (single shared App ID / channel-naming-convention tenant isolation, 30–60 min token TTL, usage-row logging).
- **Phase 5:** instructor SPA — 4-digit code gatekeep, two-column dashboard (stream view + control deck), JSON command dispatch per `§5.2`.
- Move the prototype App ID / Token out of BP into a non-source-controlled config asset once Phase 4 lands.
- OpenXR localization warnings in the Output Log (low priority cosmetic).
- 10-bit swapchain fallback messages (low priority cosmetic).
