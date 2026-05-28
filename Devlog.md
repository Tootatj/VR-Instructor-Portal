# Developer Log: VR Instructor Portal

## Current Project Status

**Phase:** Capture pipeline groundwork — Agora streaming path (Phase 1 in progress)

Build & deployment pipeline is fully validated end-to-end on Quest 3. Project is currently pure Blueprint + OpenXR (no user-authored C++). Last verified APK on device: commit `f7011de`, deployed 2026-05-28, total wall-clock ~85 seconds with warm `DerivedDataCache/`.

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

**Phase 2+ (deferred to next sessions):**

- Agora developer account signup and project creation (no account yet)
- Agora UE plugin selection (UE 5.5 + Android Quest compatibility critical — official vs. community wrapper to be evaluated)
- `JoinChannel` connectivity sanity check (mic only, no custom video source yet)
- Custom video frame push (RT → Agora `PushExternalVideoFrame` equivalent, includes RGBA→YUV420 conversion)
- Server-side token minting (`Web_Dashboard/agora.js` per `.cursorrules §4.3.1`)

### Open Backlog Items

- Scaffold `Web_Dashboard/` (Node.js + Express + Socket.IO server skeleton, static SPA frontend) per `.cursorrules §3` and `§4.3`
- OpenXR localization warnings in the Output Log (low priority cosmetic)
- 10-bit swapchain fallback messages (low priority cosmetic)
