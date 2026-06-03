# VR_Project / Plugins

Unreal Engine plugins required by the project live here.

Plugins distributed as pre-built SDK binaries are **not** committed to the
repository (see [`.gitignore`](../../.gitignore)). Each developer and CI
runner installs them manually before opening the project.

## Required plugins

### Agora-Unreal-RTC-SDK — v4.5.1

Used for the bidirectional voice + custom video source pipeline between the
headset and the instructor browser.

- **Upstream:** <https://github.com/AgoraIO-Extensions/Agora-Unreal-RTC-SDK>
- **Pinned release:** <https://github.com/AgoraIO-Extensions/Agora-Unreal-RTC-SDK/releases/tag/v4.5.1>
- **Install instructions:** see the
  [root `README.md` → Setup → step 2](../../README.md#2-install-the-agora-ue-plugin-manual--required).
- **Final installed path:**

  ```
  VR_Project/Plugins/AgoraPlugin/
  ```

That folder is gitignored and will not appear in `git status` once correctly
placed.

### SocketIOClient-Unreal — v2.9.0 (UE 5.5)

Used by `USignalingSubsystem` to speak the dashboard's Socket.IO wire
protocol (`headset:register`, `headset:command`, ack callbacks). Free
MIT-licensed plugin from getnamo, source-built from GitHub. Version
v2.9.0 is pinned because its `.uplugin` declares `EngineVersion: 5.5`
(later v2.10.0 → 5.6, v2.11.0 → 5.7 — both will compile against 5.5 but
v2.9.0 is the no-warning baseline).

- **Upstream:** <https://github.com/getnamo/SocketIOClient-Unreal>
- **Pinned tag:** [`v2.9.0`](https://github.com/getnamo/SocketIOClient-Unreal/releases/tag/v2.9.0)
- **Install (one shot):**

  ```powershell
  git clone --recurse-submodules --depth 1 https://github.com/getnamo/SocketIOClient-Unreal.git VR_Project/Plugins/SocketIOClient
  git -C VR_Project/Plugins/SocketIOClient fetch origin tag v2.9.0 --depth 1
  git -C VR_Project/Plugins/SocketIOClient checkout v2.9.0
  git -C VR_Project/Plugins/SocketIOClient submodule update --recursive --init --depth 1
  ```

- **Final installed path:**

  ```
  VR_Project/Plugins/SocketIOClient/
  ```

- **First-build cost:** the plugin's `SocketIOLib` module compiles three
  bundled C++ libs (asio, rapidjson, websocketpp) — adds ~2 minutes to
  the first cold cook after install. Subsequent cooks reuse the built
  artifacts.

Also gitignored. The project's [`VR_Project.uproject`](../VR_Project.uproject)
enables `SocketIOClient` for Win64 + Android, and
[`VR_Project.Build.cs`](../Source/VR_Project/VR_Project.Build.cs)
adds `SocketIOClient` + `SIOJson` to `PrivateDependencyModuleNames`.

### PICOXR — Integration SDK v3.4.1 (LTS, UE 5.5)

Pico's proprietary HMD / Input / Eye Tracker / MR runtime plugin. Required to
ship a single APK that boots into stereo VR on **both** Quest and Pico (the
2026-06-03 *Pico VR Phase A* devlog entry has the full architectural
rationale). Without this plugin, Pico devices fall back to a 2D Android panel
in PICO Home.

- **Upstream:** <https://developer-global.pico-interactive.com/> →
  *Resources → SDK → Unreal → PICO Unreal Integration SDK (LTS)*.
  Requires a free Pico developer account.
- **Pinned version:** **v3.4.1** (the LTS release listed as v3.4.0 on the
  download page; the bundled `PICOXR.uplugin` self-identifies as `3.4.1`).
- **Supported devices:** PICO Neo3, PICO 4 series (Neo / Enterprise / Ultra).
- **Final installed path:**

  ```
  VR_Project/Plugins/PICOXR/
  ```

- **DO NOT** also install the sibling plugins from the same download page
  (`PICOOpenXR`, `PICOSpatialAudio`, `OnlineSubsystemPICO`, `PICOEnterprise`).
  They are either alternative paths (PICOOpenXR vs PICOXR — pick one) or
  irrelevant to this project (Agora handles audio; we don't use Pico's
  store/leaderboards; enterprise MDM is a later concern).

#### Required patch — duplicate Java method

PICOXR's `Source/PICOXRHMD/PICOXR_UPL.xml` injects
`AndroidThunkJava_IsOculusMobileApplication() { return true; }` into the
generated `GameActivity.java`. UE 5.5 with `bPackageForMetaQuest=True`
(which we **need** for Quest VR manifest entries) *also* injects the same
method. The duplicate definition fails the cook with:

```
error: method AndroidThunkJava_IsOculusMobileApplication() is already defined in class GameActivity
```

After every fresh PICOXR install / upgrade, **comment out PICOXR's copy**
by wrapping the method in an XML comment block. The intended state is:

```xml
<gameActivityClassAdditions>
    <insert>
        <!-- PATCH (OneBonsai/VR-Instructor-Portal): commented out duplicate
             AndroidThunkJava_IsOculusMobileApplication() definition. UE 5.5
             already injects this method into GameActivity.java when
             bPackageForMetaQuest=True (which we need on for Quest VR
             manifest entries). Keeping PICOXR's copy here triggers
             'method already defined' javac error during cook. UE's
             version returns true on both Quest and Pico (Pico is
             binary-compatible at this layer), so removing PICOXR's
             copy is functionally identical.
        public boolean AndroidThunkJava_IsOculusMobileApplication()
        {
            return true;
        }
        -->

        <!--Override dispatchKeyEvent-->
        @Override
        public boolean dispatchKeyEvent(KeyEvent event)
        ...
```

The patch is local to this project and cannot be upstreamed (PICOXR
*intentionally* injects the method for non-Meta-Quest UE projects).
The Devlog 2026-06-03 *Pico VR Phase A* entry has the full diagnosis
and rationale.

#### Project wiring

- [`VR_Project.uproject`](../VR_Project.uproject) enables `PICOXR` for
  `Win64` + `Android`.
- [`DefaultEngine.ini`](../Config/DefaultEngine.ini) declares a
  `[/Script/PICOXRHMD.PICOXRSettings]` section with the feature flags
  minimal (controllers only). `MinSDKVersion=29` and
  `bPackageForMetaQuest=True` are the two cross-vendor settings that
  make the same APK boot stereo on both Quest and Pico.
- No `Build.cs` change needed — PICOXR is a runtime/content plugin only.

Also gitignored.
