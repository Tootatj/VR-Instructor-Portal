# How to Port the VR Instructor Portal into Another Unreal Project

> **Last verified against:** UE 5.5.4 · PICOXR 3.4.1 · SocketIOClient v2.9.0 · Agora-Unreal-RTC-SDK v4.5.1 · `USignalingSubsystem` + `UTenantRegistry` + `UHeadsetPresenceMonitor` git rev `<this commit>` (per-app interactive control plane)
>
> **Maintainer rule:** every time `SignalingSubsystem.h/.cpp`, `TenantRegistry.h/.cpp`,
> `HeadsetPresenceMonitor.h/.cpp`, the BP integration shape on `BP_VRPawn`,
> the plugin set, the wire protocol docs (`Web_Dashboard/docs/commands.md`,
> `Web_Dashboard/docs/state-updates.md`), or the per-app module convention
> (`Web_Dashboard/public/js/apps/README.md`) changes, update the matching
> section below in the same commit. Add a row to the bottom of the
> *Change log* at the end of this file with the date + commit hash +
> one-line "what changed".

This guide tells you how to take the signaling + pairing + command-relay
layer from this project and reuse it in a **different Unreal Engine 5.5+
project** — typically a different VR training app that should also become
streamable into an instructor dashboard.

The web dashboard (`Web_Dashboard/`) is a separate Node process and is
inherently portable — point any number of UE apps at the same server. The
porting work below is entirely about the Unreal side.

---

## TL;DR — what's portable

| Component | Portability |
|---|---|
| `SignalingSubsystem.h/.cpp` | **Drop-in.** Zero dependency on this project's pawn, scene, or Agora. Pure UE + Socket.IO + HTTP. BP-callable surface (as of 2026-06-15): `RefreshToken`, `EmitHeadsetEnd`, `RequestSessionResume`, `EmitStateUpdate(StateName, Data)`, `EmitStateUpdateFromJson(StateName, DataJsonString)`. BP-readable: `AppId`, `AppVersion` (declared in `DefaultGame.ini`, see A.3). `OnHeadsetCommand` delegate now surfaces a full `PayloadJson` string alongside the legacy typed fields, so per-app commands parse in BP via the SocketIO plugin's `Construct Json Object` + `Decode Json` node pair (both under category `SIOJ \| Json`). Wire-protocol contract for both directions: `Web_Dashboard/docs/commands.md` (web → headset) and `Web_Dashboard/docs/state-updates.md` (headset → web). |
| `TenantRegistry.h/.cpp` | **Drop-in.** Pure UE + HTTP + `FFileHelper`. Owns the first-launch company-code redemption + persistence. **Replaces any prior hardcoded `TenantId` in INI.** Has no UMG dependency — host apps can use their existing in-VR code-input panel (see *BYO code-input UI* section below). |
| `HeadsetPresenceMonitor.h/.cpp` | **Drop-in.** `UActorComponent` that polls `IXRTrackingSystem::GetHMDWornState()` and fires `OnHeadsetIdleStarted` / `OnHeadsetIdleEnded` BP events for the Agora cost-exposure idle-detection path (Devlog 2026-06-11). Requires `HeadMountedDisplay` in the target module's `Build.cs`. No dependency on Agora or signaling — BP wires the events to whatever leave/rejoin path the host app exposes. |
| `Web_Dashboard/` server | **Already portable.** Runs once, serves any UE app that speaks the wire protocol. |
| BP integration on `BP_VRPawn` | **Pattern, not asset.** Reproduce the 5 graphs in the target project's pawn or game mode (first-boot init + signaling-ready gate + registration-gate spawn + `OnAgoraChannelChanged` swap handler + `OnJoinChannelSuccess` pump restart) plus the 2 `UHeadsetPresenceMonitor` event handlers if you're porting the idle-detection, plus the per-app state-publish + command-handle graphs from A.4.3 if you're wiring the per-app dashboard UI. Worked example included. |
| Per-app dashboard UI (`Web_Dashboard/public/js/apps/<AppId>.js`) | **One JS file per VR app.** Optional. Each VR app that wants a custom instructor panel (level picker, per-level controls, in-level metric display) ships an ES module in this directory matching its declared `AppId`. The dashboard's focus view dynamic-imports it based on the live session's `appId`. Sessions without an `appId` (or with no matching module) get the generic fallback panel and still work via the always-present app-agnostic command deck. Module shape + conventions: `Web_Dashboard/public/js/apps/README.md`. |
| Agora streaming pipeline (`AgoraVideoPump.h/.cpp` + Agora plugin) | **Optional / copyable.** Only needed if the target project has no streaming and you want this stack to provide it. |
| PICOXR + universal-VR config | **Drop-in via** [`VR_Project/Plugins/README.md`](VR_Project/Plugins/README.md). Same plugin install recipe regardless of target — but cook with the per-device wrapper (`.\Tools\Cook-VRApp.ps1 -Device quest|pico`) rather than invoking UAT directly, because `[HMDPluginPriority]` must differ between vendors. See gotcha #11 (per-vendor IMC bindings) and gotcha #12 (per-device cook model + Quest baseline). |

## Effort estimates

| Target project state | Estimated effort | What you actually do |
|---|---|---|
| **A. Already streams to Agora over a `t-*` channel** | ~2 hours | Copy 2 C++ files → install 1 plugin → BP wiring on the target's pawn → ini section header rename → cook. |
| **B. UE 5.5+ mobile VR but no streaming pipeline** | ~1 day | A. + port `AgoraVideoPump.cpp/h` + install Agora plugin + add SceneCapture+RT setup to the target's pawn. |
| **C. UE 5.3 / 5.4** | ~1-2 days | B. + pin alternate plugin versions (SocketIOClient has per-engine git tags, PICOXR has separate UE 5.3/5.4 downloads) + re-validate. |
| **D. PC-only / non-VR Unreal** | ~half day | A. minus the PICOXR + Pico config (just Quest desktop sim or actual desktop). |

---

## Recipe A — Target already has Agora streaming (~2 hours)

The most common case if you're extending another OneBonsai training app.

### A.1. Install the three plugins in the target project

Follow the recipes verbatim from [`VR_Project/Plugins/README.md`](VR_Project/Plugins/README.md):

- **SocketIOClient v2.9.0** (getnamo) — git clone + tag checkout
- **PICOXR v3.4.1 LTS** + the duplicate-`IsOculusMobileApplication` UPL patch (the patch is *mandatory* — without it the cook fails with `error: method ... is already defined`)
- **AgoraPlugin v4.5.1** — only if not already installed in target

Add the plugins to the target's `<TargetProject>.uproject`:

```json
"Plugins": [
    { "Name": "SocketIOClient", "Enabled": true, "SupportedTargetPlatforms": ["Win64", "Android"] },
    { "Name": "PICOXR",         "Enabled": true, "SupportedTargetPlatforms": ["Win64", "Android"] }
]
```

Append to `<TargetProject>/Source/<TargetModule>/<TargetModule>.Build.cs`:

```csharp
PrivateDependencyModuleNames.AddRange(new string[] { "SocketIOClient", "SIOJson", "HTTP", "Json" });
// Only if copying HeadsetPresenceMonitor (the idle-detection component):
PrivateDependencyModuleNames.Add("HeadMountedDisplay");
```

### A.2. Copy the C++ files

```powershell
copy VR_Project\Source\VR_Project\SignalingSubsystem.h        <Target>\Source\<TargetModule>\
copy VR_Project\Source\VR_Project\SignalingSubsystem.cpp      <Target>\Source\<TargetModule>\
copy VR_Project\Source\VR_Project\TenantRegistry.h            <Target>\Source\<TargetModule>\
copy VR_Project\Source\VR_Project\TenantRegistry.cpp          <Target>\Source\<TargetModule>\
copy VR_Project\Source\VR_Project\HeadsetPresenceMonitor.h    <Target>\Source\<TargetModule>\
copy VR_Project\Source\VR_Project\HeadsetPresenceMonitor.cpp  <Target>\Source\<TargetModule>\
```

The classes need **no edits** unless the target's module API macro differs:
in `SignalingSubsystem.h`, `TenantRegistry.h`, and `HeadsetPresenceMonitor.h`,
change `VR_PROJECT_API` to `<TARGETMODULE>_API` (the macro UBT generates
per module, all-caps + `_API`). The `#include "TenantRegistry.h"` in
`SignalingSubsystem.cpp` should not need editing — all three files end
up in the same module.

You can skip `HeadsetPresenceMonitor.h/.cpp` if the host app already
has its own idle-detection or doesn't care about the Agora cost-exposure
mitigation (e.g. a desktop-only consumer of the layer). The signaling +
registry pair are independent of it.

### A.3. Add the INI config block

In `<Target>/Config/DefaultGame.ini`, add:

```ini
; The section *names* must match the target module's reflected path:
; [/Script/<TargetModuleName>.SignalingSubsystem]
; [/Script/<TargetModuleName>.TenantRegistry]
[/Script/<TargetModule>.SignalingSubsystem]
ServerUrl="http://<dashboard-host>:3000"
TenantId=<dev-fallback-tenant-slug>   ; ONLY used when bAllowUnregisteredBoot=true below
Scenario=<default scenario name displayed on dashboard grid tile>
TraineeName=<default trainee name>
; Per-app interactive control plane (2026-06-15). Both optional, both
; should be set for any target project that wants per-app instructor UI.
; AppId is the dashboard's lookup key for the per-app module
; (Web_Dashboard/public/js/apps/<AppId>.js). Use the target project's
; identifier in PascalCase (e.g. "VRForklift", "VRChemSafety"). Leaving
; both blank yields a generic video-only dashboard panel.
AppId=<TargetAppId>
AppVersion=1.0.0

[/Script/<TargetModule>.TenantRegistry]
; ServerUrl falls back to the SignalingSubsystem URL above if omitted.
; bAllowUnregisteredBoot:
;   true  (dev/CI) — boot signaling with the INI TenantId above if no
;         registration file exists yet. Useful before the registration
;         UI is wired.
;   false (prod)   — block signaling until UTenantRegistry::RedeemCode
;         succeeds. This is the production setting.
bAllowUnregisteredBoot=False
```

**The `ServerUrl` value MUST be quoted.** UE's INI parser truncates
unquoted values at the first `:` outside the `Key=Value` separator —
without quotes `http://host:3000` becomes `http:`. Tested and bled
over in our Phase A cook cycle (see Devlog 2026-06-03 "Phase 4 Phase A"
lesson #2).

In `<Target>/Config/DefaultEngine.ini`, add the cross-vendor Android
block (copy verbatim from this project's `[/Script/AndroidRuntimeSettings.AndroidRuntimeSettings]`
+ `[/Script/PICOXRHMD.PICOXRSettings]` sections). Critical settings:

```ini
[/Script/AndroidRuntimeSettings.AndroidRuntimeSettings]
MinSDKVersion=29
TargetSDKVersion=34
bPackageForMetaQuest=True
ExtraApplicationSettings=<meta-data android:name="com.oculus.supportedDevices" android:value="quest|quest2|questpro|quest3" />

[/Script/PICOXRHMD.PICOXRSettings]
HandTrackingSupport=ControllersOnly
bEnablePSensor=True
; ... (full list in this project's DefaultEngine.ini — copy as-is)
```

### A.4. Wire the target's pawn (or wherever Agora joins the channel)

Four graph edits, all on the BP that owns the `Initialize` → `Make RtcEngineContext`
→ `Join Channel` chain:

1. **Add `OnSignalingReady` custom event.** Drag the existing Agora init
   chain off this custom event's exec pin (i.e. *move*, not copy).
2. **Rewrite `BeginPlay` to gate on credentials.** After the standard
   permission-grant delay (0.5 s on Quest cold launch), do:
   - `Get Game Instance → Get Subsystem (USignalingSubsystem)` → check
     `State == ESignalingState::Live` (use the BP-exposed enum)
   - If `Live`: call `OnSignalingReady` directly (subsystem already
     finished before the pawn spawned — common after a hot reconnect)
   - If not `Live`: bind `OnSignalingReady` to the subsystem's
     `OnCredentialsReady` multicast delegate
3. **Replace the three literal pins.** On `Make RtcEngineContext`, drag
   `Get Signaling Subsystem → AgoraAppId` into the `AppId` pin. On
   `Join Channel`, drag `AgoraChannel` into `ChannelId` and `AgoraToken`
   into `Token`. Delete the literal strings.
4. **Handle mid-session tenant swap.** Bind a separate handler to the
   subsystem's `OnAgoraChannelChanged(NewChannel)` delegate. This fires
   on `ClearRegistration` (with `NewChannel=""`) and on every subsequent
   `RedeemCode` (with the new channel name). The handler tears down the
   current Agora channel and rejoins the new one, restarting the video
   pump in between. See *A.4.1* below for the exact graph shape and
   the design rationale.

Reference implementation: `VR_Project/Content/VRTemplate/Blueprints/VRPawn.uasset`
(open the asset; relevant graphs are `BeginPlay`, the `OnSignalingReady`
custom event, and the `On Agora Channel Changed` handler).

### A.4.2. Optional: idle-detection auto-leave (Agora cost mitigation)

If you copied `HeadsetPresenceMonitor.h/.cpp` (recommended for any
production deployment where Agora minutes are billed), add two more
event bindings on the pawn:

1. Add the `Headset Presence Monitor` component (drag-and-drop in the
   Components panel). Defaults are correct for Quest-dominant deployments
   (`PollIntervalSeconds=30`, `IdleThresholdSeconds=120`,
   `bTreatUnknownAsWorn=true`). For Pico-dominant deployments only: flip
   `bTreatUnknownAsWorn` to `false` and raise `IdleThresholdSeconds` to
   ~300 s — PICOXR's worn-state through the generic OpenXR +
   `IXRTrackingSystem` path returns `Unknown` more often than Quest, and
   the conservative default would never trip idle on a Pico-only fleet.
2. Bind `OnHeadsetIdleStarted` to a 3-node chain (run in this order):
   `Signaling Subsystem → Emit Headset End` (server prunes the room),
   then Agora `Leave Channel` (kills the publish bill — this is the
   critical node), then `Agora Video Pump → Stop Video Pump` (drains
   the readback).
3. Bind `OnHeadsetIdleEnded` to a single
   `Signaling Subsystem → Request Session Resume` node. That's it —
   `RequestSessionResume` re-registers on the existing socket and
   re-fetches a fresh Agora token, which because
   `bHasFiredInitialCredentials` is already true fires
   `OnAgoraChannelChanged`, which the A.4.1 handler above already
   handles. **No new graph branches required for the rejoin cascade.**

Full design rationale + cost impact numbers in Devlog 2026-06-11
"Agora cost-exposure Phase 1 shipped". Component is a no-op outside VR
contexts (non-VR PIE, dedicated server, headless CI) — `Poll` early-
returns if `GEngine->XRSystem.IsValid()` is false, so you can leave it
on a pawn that's also used in non-VR test maps without false-idling.

### A.4.3. Optional: per-app interactive control plane (instructor dashboard UI)

If the target project wants instructor-side UI beyond the four legacy
app-agnostic commands (`pause_simulation`, `change_environment`,
`trigger_event`, `reset_user_position`) — for example: a level picker, a
scenario state display, custom in-level controls — wire the per-app
control plane. This is what enables the dashboard's focus view to switch
from a generic command deck to a fully-bespoke UI per VR app.

**One-time setup, shared by every per-app integration:**

1. Set `AppId=<YourAppId>` in `DefaultGame.ini`'s `[/Script/<TargetModule>.SignalingSubsystem]`
   section (added in A.3 above). The headset declares this in
   `headset:register` so the dashboard knows which UI module to load.
2. Ship a dashboard module at `Web_Dashboard/public/js/apps/<YourAppId>.js`.
   Convention + shape: `Web_Dashboard/public/js/apps/README.md`. Use
   `VRFT.js` in the same directory as the reference implementation.
3. Register the app's command vocabulary in
   `Web_Dashboard/src/commands.js`'s `APP_COMMAND_VALIDATORS[<YourAppId>]`
   block. Server rejects unknown commands per `.cursorrules §5.2`.
4. Document the app's state machine + command list in
   `Web_Dashboard/docs/state-updates.md` and `Web_Dashboard/docs/commands.md`
   under matching `### appId: "<YourAppId>"` subsections.

**Per state transition the VR app makes**, BP wires — pick whichever
`EmitStateUpdate` variant is simpler for your data shape:

1. **For complex data shapes (arrays of objects, nested structures):**
   build a JSON string (`Format Text` from a Data Table, or
   `Make Literal String` for a fixed catalog) and call
   `Get Signaling Subsystem → Emit State Update (From JSON String)`
   with the state name + the string. Parse failures log a warning
   server-side but still deliver the state transition (with empty
   data) — preferable to a dropped transition.
2. **For simple data shapes (1-3 scalar fields):** build a
   `USIOJsonObject` via the SocketIO plugin's `Construct Json Object`
   node + `Set String Field` / `Set Number Field` setters (all under
   category `SIOJ \| Json`), then call `Get Signaling Subsystem →
   Emit State Update` with the state name + object reference. Pass
   `None` for stateless transitions.

Server caps serialised data at 8 KB and rate-limits at 30 updates per
3-second window per code. Both BP variants are fire-and-forget — no ack
handling needed.

**Per command the dashboard sends**, BP wires:

1. **Bind `OnHeadsetCommand` on the signaling subsystem.** Switch on
   `Command.Command` (the string). For the four legacy app-agnostic
   commands the typed fields (`BoolValue`, `StringValue`) stay populated
   for back-compat. For app-specific commands, parse `Command.PayloadJson`.
2. **Parse `PayloadJson` via the SocketIO plugin's two-step pattern:**
   `Construct Json Object` (returns an empty USIOJsonObject*) → drag off
   that object → `Decode Json` (input the `PayloadJson` string, returns
   bool on parse success). Both nodes live under category `SIOJ \| Json`.
   Then read fields off the now-populated object with `Get String Field` /
   `Get Number Field` / `Try Get String Field` (safer variant that
   returns bool + out-string when a field might be absent).
3. **Publish the resulting state transition** via `EmitStateUpdate` so
   the dashboard's UI reflects what the command achieved (or didn't).

Worked example: `Web_Dashboard/public/js/apps/VRFT.js` is the dashboard
side; the VR side wiring lives in `BP_VRPawn`'s `BeginPlay` (initial
state publish) + the new `On Headset Command` handler graph (covered in
the dashboard's PROTOCOL docs). The headset is the source of truth for
"what content exists" — the dashboard renders whatever the headset
publishes, never assumes a hardcoded catalog.

This component is opt-in: a target project that leaves `AppId` blank
still streams video to the grid view, still accepts the four legacy
commands, just doesn't get app-specific instructor UI. The four legacy
commands stay app-agnostic and always work.

### A.4.1. The channel-swap handler (required even if you never use switch-org today)

`OnCredentialsReady` is one-shot in the BP-author mental model: it fires
when the headset *first* has Agora credentials, and your graph reacts by
calling `RtcEngine.Initialize` + `JoinChannel`. **`OnCredentialsReady` does
NOT fire again on subsequent registrations** — that path goes through
`OnAgoraChannelChanged` instead. If you skip wiring `OnAgoraChannelChanged`
and a user ever triggers a re-registration (switch-org from a pause menu,
or even a server-side re-issue of credentials during a long session), the
old Agora channel stays joined, the new channel gets no published local
video, and the instructor sees a black tile. Found and fixed 2026-06-05
— full diagnosis in Devlog "channel-swap fix" entry.

The minimum-viable handler:

```
On Agora Channel Changed (NewChannel : String)
  ├─ Branch [NewChannel == ""]
  │    True  → VideoPump.StopVideoPump → Agora.LeaveChannel
  │    False → VideoPump.StopVideoPump
  │             └─ Agora.LeaveChannel
  │                └─ Agora.JoinChannel(
  │                      NewChannel,
  │                      Signaling.AgoraToken,
  │                      Signaling.AgoraUid)

Agora OnJoinChannelSuccess (existing event, add one node)
  └─ VideoPump.RestartForNewChannel
       (idempotent; safe to also call on the first-boot join — Stop
        early-exits if nothing's running)
```

The `RestartForNewChannel` call after `JoinChannel` is what cures the
silent failure: it cycles `setExternalVideoSource(false)` → `(true)`
inside the pump, rebinding the external frame source to the *new*
channel's freshly-created local video track. `setExternalVideoSource` is
engine-scope in Agora 4.x but its effective binding to a local track
resets on `LeaveChannel`, so a plain `StartVideoPump` (which is a no-op
when already running) won't fix it. Always go through `RestartForNewChannel`.

### A.5. Cook + sideload + verify

Same UAT command as this project (see [`.cursorrules` §8.2](.cursorrules)).
First cook compiles the SocketIO + PICOXR plugin libs (~2 min extra),
subsequent cooks reuse them.

Verify with logcat: `adb logcat -d --pid=$(adb shell pidof <target.package.name>) | rg "VRIPSignaling|Agora.*Joined"`. Expected sequence:

```
LogVRIPSignaling: Initialize: code=XXXX tenant=<your-tenant> server=http://...
LogVRIPSignaling: state -> ESignalingState::Connecting
LogVRIPSignaling: Socket connected ...
LogVRIPSignaling: state -> ESignalingState::Registering
LogVRIPSignaling: headset:register ack ok ...
LogVRIPSignaling: /api/token 200: channel=t-<tenant>-XXXX ...
LogVRIPSignaling: state -> ESignalingState::Live
LogBlueprintUserMessages: Agora Joined channel=t-<tenant>-XXXX ...
```

The grid view at `http://<dashboard>:3000/?tenantId=<your-tenant>` should
show the headset as a tile with the matching pairing code.

---

## Recipe B — Target has no streaming, needs the full stack (~1 day)

Recipe A + the following:

### B.1. Install the Agora plugin in the target

Follow [`README.md`](README.md) §2 verbatim. The plugin is a manual
~800 MB drop — same instructions, just in a different `<Target>/Plugins/`
folder.

### B.2. Port the video pump

Copy `VR_Project/Source/VR_Project/AgoraVideoPump.cpp` and `.h` into
`<Target>/Source/<TargetModule>/`. Update the API macro if needed
(see A.2).

The pump is a `UObject` you spawn once and tell to pump a specific
`UTextureRenderTarget2D` to Agora. The pattern in `VRPawn`'s BP after
`Join Channel`:

```
[Construct UAgoraVideoPump]
    → InstructorRT (UTextureRenderTarget2D ref)
    → 1280, 720    (width, height)
    → 30.0         (target Hz)
[Start Video Pump]
```

### B.3. Set up SceneCapture → RT in the target's pawn/scene

- Add a `USceneCaptureComponent2D` to the pawn (or wherever you want
  the trainee POV captured from — usually the camera).
- Create a `UTextureRenderTarget2D` asset, set format to **`RTF_RGBA8_SRGB`**
  (this is non-negotiable — `RTF_RGBA8` produces 2.4× too-dark output in
  the browser because of a linear/sRGB mismatch on the readback path;
  full diagnosis in Devlog 2026-06-03 "Phase 3 polish (perf + color)
  consolidated", section B).
- Wire the SceneCapture's `TextureTarget` to the RT.
- On a `0.0333` s timer, call `CaptureScene()`. Don't go faster — 30 Hz
  is the spec'd cap.

### B.4. Verify

In addition to the Recipe A logcat checks, look for:

```
LogAgoraVideoPump: Display: StartVideoPump: pumping 1280x720 @ 30.0 Hz (async readback)
```

Open the dashboard's focus view of the headset's tile — the video pane
should show the trainee POV with correct exposure (not 2× too dark).

---

## Recipe C — UE 5.3 / 5.4 (~1-2 days)

Recipe A/B + version pinning. Each plugin has per-engine variants:

- **SocketIOClient** — the [getnamo repo](https://github.com/getnamo/SocketIOClient-Unreal/releases)
  has separate tags per engine. v2.7.0 → UE 5.3, v2.8.0 → UE 5.4, v2.9.0 → UE 5.5.
- **PICOXR** — Pico ships separate `PICOXR_v3.4.x_UE5.3.zip` / `_UE5.4.zip` /
  `_UE5.5.zip` archives. Pick the matching one. The duplicate-method patch
  applies identically across all engine versions (Pico has not changed
  that UPL block).
- **Agora-Unreal-RTC-SDK** — v4.5.1 was empirically validated against UE 5.5.4
  by this project. Older Agora versions may work on UE 5.3 / 5.4 but you'll
  re-run the Phase 2 PIE audio round-trip + Phase 3 video pump validations
  to confirm. Budget half a day for plugin compat re-validation.

The `SignalingSubsystem` C++ itself compiles unchanged against UE 5.3+
— it uses only `Subsystems/`, `HTTP/`, `Json/`, and the public Socket.IO
plugin API, none of which has had breaking changes in 5.3 → 5.5.

---

## Recipe D — PC-only / non-VR Unreal (~half day)

Recipe A, minus the PICOXR install and minus the
`[/Script/PICOXRHMD.PICOXRSettings]` block. Also set `bPackageForMetaQuest=False`
since the target is not deploying to Meta hardware. Everything else
(subsystem, BP wiring, optional Agora) is identical.

---

## Reference: files you'll touch in the target project

| File | Change |
|---|---|
| `<Target>.uproject` | Add `SocketIOClient` + `PICOXR` (if VR) plugin entries. |
| `Source/<Module>/<Module>.Build.cs` | Add `SocketIOClient`, `SIOJson`, `HTTP`, `Json` to `PrivateDependencyModuleNames`. |
| `Source/<Module>/SignalingSubsystem.h/.cpp` | New files (copied from this project). Update `VR_PROJECT_API` → `<MODULE>_API` if needed. |
| `Source/<Module>/TenantRegistry.h/.cpp` | New files (copied from this project). Update `VR_PROJECT_API` → `<MODULE>_API` if needed. |
| `Source/<Module>/HeadsetPresenceMonitor.h/.cpp` | New files, **recommended for production** (Agora cost mitigation per A.4.2). Skip for desktop-only or non-billing-sensitive deployments. Update API macro if needed. |
| `Source/<Module>/AgoraVideoPump.h/.cpp` | New files, **only if Recipe B**. |
| `Config/DefaultGame.ini` | New `[/Script/<Module>.SignalingSubsystem]` and `[/Script/<Module>.TenantRegistry]` blocks. |
| `Config/DefaultEngine.ini` | Update `[/Script/AndroidRuntimeSettings.AndroidRuntimeSettings]` + add `[/Script/PICOXRHMD.PICOXRSettings]` (if VR). |
| `<Pawn or game mode>.uasset` | The BP graph edits — `OnSignalingReady` event, `BeginPlay` gate, three literal-to-variable-read pin replacements, plus showing the registration panel if `!IsRegistered()`. |
| Existing code-input panel BP (or new `WBP_RegistrationGate`) | Wire Submit → `RedeemCode` + callback; bind `OnRegistrationChanged` to re-show on clear. See *BYO code-input UI* section. |
| `.gitignore` | Add the three plugin folders (they're not source-controlled). |
| `Plugins/README.md` (or equivalent) | Document the install recipes + the PICOXR patch. |

---

## BYO code-input UI — porting into an app that already has a registration panel

If the target VR app already has its own in-VR code-input panel (e.g.
one of the apps already plugged into OneBonsai's existing company-
management system), you do **not** need to ship `WBP_RegistrationGate`.
The `UTenantRegistry` subsystem is the only integration seam — by
design.

The minimum wiring on the host app side:

1. **Drop in the C++ files** (Recipes A.2 + A.3 above).
2. **Follow Recipe A.4 + A.4.1 verbatim** on whichever BP owns your Agora `JoinChannel` call (pawn, game mode, controller — wherever you have it today). The pawn-side wiring is *universal* — your own code-input panel only replaces the `WBP_RegistrationGate` widget, not the channel-lifecycle BP graphs. In particular, if your host app supports any "switch organization" affordance mid-session, the *A.4.1* channel-swap handler is mandatory; without it you'll silently lose video on the new tenant.
3. **In your existing panel's submit handler BP graph:**

   ```
   [On Submit Clicked]
       → Get Game Instance → Get Subsystem (UTenantRegistry)
       → Redeem Code:
            Code = <your text-input widget's text>
            Callback = bind a Custom Event with signature (bool bSuccess, FString ErrorMessage)
                On bSuccess=true  → hide your panel + unblock the app start flow
                On bSuccess=false → display ErrorMessage in your existing error label
   ```

4. **Bind `OnRegistrationChanged` once at panel-construct time** to handle the case where the registration is wiped at runtime (e.g. via your existing "switch organization" / "log out" affordance):

   ```
   [Construct]
       → Get Game Instance → Get Subsystem (UTenantRegistry)
       → Assign OnRegistrationChanged:
            On fire → if IsRegistered() == false: show your panel again
   ```

5. **No other panel changes needed.** The host app's existing scene start
   logic should already be gated on "have we got a tenant?" somewhere
   if the existing system worked at all — just route that gate through
   `UTenantRegistry::IsRegistered()` instead of whatever local flag it
   used before.

The BP-callable surface area on `UTenantRegistry` is intentionally
minimal:

| BP function | Purpose |
|---|---|
| `Is Registered` (pure) | UI shows / hides the input panel based on this. |
| `Get Tenant Id` (pure) | For display ("you're registered with: securitas"). |
| `Get Display Name` (pure) | For display ("Securitas Training"). |
| `Get Registration Code` (pure) | For display in a "Switch organization" confirmation screen. |
| `Redeem Code` (callable) | Called by your panel's Submit handler. |
| `Clear Registration` (callable) | Wire to a "Switch organization" / "Log out" button. Triggers re-show of your panel via `OnRegistrationChanged`. |

Once you've wired your existing panel to `RedeemCode`, set
`bAllowUnregisteredBoot=False` in `DefaultGame.ini` (Recipe A.3) so the
signaling subsystem refuses to boot until your panel completes — this
guarantees a fresh-install device can never accidentally connect under
the dev-fallback tenant.

---

## Common gotchas (we paid the tax, you don't have to)

These all hit us during initial Phase 4 / Phase 6D build-out — every one
is captured in the Devlog but worth surfacing here so a porter doesn't
have to dig:

1. **`ServerUrl` must be quoted in the INI.** Otherwise `:` truncates the value.
2. **PICOXR's `AndroidThunkJava_IsOculusMobileApplication()` Java injection conflicts with UE's.** Patch out PICOXR's copy. See [`VR_Project/Plugins/README.md` § PICOXR](VR_Project/Plugins/README.md#required-patch--duplicate-java-method) for the exact patch and rationale.
3. **`USocketIOClientComponent` lives on a Subsystem (no actor outer), but its `Connect` deref-crashes if you don't call `StaticInitialization` first.** The subsystem already does this correctly — when porting, don't simplify it to `NewObject + Connect`.
4. **`UFUNCTION` signatures that reference plugin types need the plugin header in `.h`, not a forward declaration.** We `#include "SocketIONative.h"` in `SignalingSubsystem.h` for `ESIOConnectionCloseReason`. UHT can't see forward-declared enums.
5. **RT format `RTF_RGBA8_SRGB` is non-negotiable for the video pump.** `RTF_RGBA8` produces correct-looking output in-engine but 2.4× too dark in the browser. Full diagnosis in Devlog 2026-06-03 "Phase 3 polish, section B".
6. **`MinSDKVersion=29`** for any APK targeting both Quest and Pico 4 Enterprise. Pico 4E runs PICO OS on Android 10 = API 29. Meta's API 32 floor is a *store* check only, not an install-time check; sideloaded universal APKs install fine on Quest with MinSDK=29.
7. **First cold cook with these plugins takes ~2 extra minutes** (compiling Socket.IO's bundled C++ libs: asio, rapidjson, websocketpp). Subsequent cooks reuse the built artifacts. Don't panic on the first build.
8. **`UGameInstanceSubsystem` init order is non-deterministic.** `USignalingSubsystem::Initialize` calls `Collection.InitializeDependency(UTenantRegistry::StaticClass())` to guarantee the registry has loaded its persisted JSON before the resolved tenantId is read. Don't remove that call. Without it, a fresh boot races: half the time signaling reads an empty registry, falls through to the INI tenant, and the device ends up wrong-tenant-bound for the session.
9. **`OnCredentialsReady` fires once per app lifetime; subsequent registrations fire `OnAgoraChannelChanged` instead.** If your BP `OnCredentialsReady` graph calls `RtcEngine.Initialize` + `JoinChannel`, do NOT also bind it for the mid-session swap case — Agora 4.x doesn't auto-leave the old channel, the local video track from the first channel persists, and the new channel ends up with no published video (instructor sees a black tile, your pump logs success). Wire a separate handler for `OnAgoraChannelChanged` per *A.4.1* above. Full diagnosis in Devlog 2026-06-05 "channel-swap fix".
10. **UE's `GConfig` is load-once-at-editor-startup.** Editing source INI files on disk does NOT hot-reload into the in-memory `GConfig` even across PIE sessions — your changes only take effect after an editor restart. `ReloadConfig <Class>` exists but only re-applies in-memory config to live instances; it doesn't re-parse the source files. If a `ServerUrl` / `bAllowUnregisteredBoot` / etc. change appears to be ignored, restart the editor before assuming the code is broken. (Commonly bites when the dev's LAN IP changes — see the Devlog 2026-06-05 "side discovery" note.)
11. **PICOXR controllers fire `PICOTouch_*` EKeys — not `OculusTouch_*` or generic `MotionController_*`.** UE's stock Input Mapping Contexts shipped with the VR Template (and anything copy-pasted from a Quest-first project) bind only OpenXR / Meta key codes. With no `PICOTouch_*` rows, Pico controllers track and render correctly but every *button* is silently inert — trigger doesn't click, grip doesn't grab, thumbstick is dead. The fix is to add additional rows to every relevant `IA_*` in your project IMCs, alongside the existing OpenXR bindings: same `IA`, additional `Key` column = `PICOTouch_<Hand>_<Button>_<Action>`. Both vendors then fire the same actions; existing BP event graphs need no changes (Quest never fires `PICOTouch_*` so the extra rows are harmless on Quest). Authoritative key list (36 keys: trigger/grip/A/B/X/Y/thumbstick/thumbrest/home/menu/volume/system × left/right × click/touch/axis) lives in the strings table of the editor-side PICOXR input binary at `<your-target>/Plugins/PICOXR/Binaries/Win64/UnrealEditor-PICOXRInput.dll`. Extract with a PowerShell one-liner if UE's key-picker dropdown isn't enough: `[regex]::Matches([System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes("<path>")), 'PICOTouch_[A-Za-z0-9_]+') | Sort-Object {$_.Value} -Unique`. Discovery + minimum mapping table for menu-interact + locomotion in Devlog 2026-06-08 "Pico controller input gap". *In **this** project, `IMC_Menu` and `IMC_Default` are now Pico-aware as of that entry; `IMC_Hands` / `IMC_Weapon_Right` / `IMC_Weapon_Left` are still OpenXR-only and need the same audit before any feature that depends on them ships cross-vendor.*
12. **Quest and Pico need different `[HMDPluginPriority]` blocks — neither value works universally on PICO OS 5+.** The original Phase 6D claim ("`OpenXR=10, PICOXRHMD=0` is universal because OpenXR self-fails on Pico") doesn't hold: Pico ships a generic OpenXR runtime layer alongside the proprietary PICO runtime, so UE's OpenXR plugin's `IsHMDConnected()` returns true on Pico too. `OpenXR=10` makes OpenXR win HMD selection on Pico, half-initialize against the wrong runtime, never produce a VR frame, and trigger an ANR after ~8s (`pre_display_error: has lasted for 7.5s` + `clientPid=<vrshell-pid>` — full diagnosis in Devlog 2026-06-08). The inverse — `OpenXR=0, PICOXRHMD=10` — works on Pico but hits the original `CalculateRenderTargetSize` assertion on Quest. **Resolution: a per-device cook wrapper script.** This project ships `Tools/Cook-VRApp.ps1` (PowerShell), which mutates `[HMDPluginPriority]` for the duration of one UAT invocation and restores it via a guaranteed `try/finally`. Use as the canonical cook entry point: `.\Tools\Cook-VRApp.ps1 -Device quest|pico|auto` (auto detects from `adb devices` + `getprop ro.product.manufacturer`). The script also renames the produced APK to `VR_Project-Quest-arm64.apk` / `VR_Project-Pico-arm64.apk` so both vendors' APKs co-exist on disk. **The baseline in `DefaultEngine.ini` is Quest** (`OpenXR=10, PICOXRHMD=0`) — matches what the in-editor VR Preview / PIE wants for Quest+Link dev workflow. **When porting into a target project**, copy `Tools/Cook-VRApp.ps1` alongside the C++ files and adjust its `$priorityValues` hashtable + `$repoRoot/$uprojPath` constants. The same per-device cook model applies to any project that ships both PICOXR and Meta-OpenXR plugins from one source tree.

13. **SocketIO `BindEventToFunction` inspects ONLY the first UFUNCTION parameter to decide how to pack `ProcessEvent` args.** Plugin source: `USocketIOClientComponent::CallBPFunctionWithResponse` (`Plugins/SocketIOClient/Source/SocketIOClient/Private/SocketIOClientComponent.cpp` ~line 284) switches on `Properties[0]->GetCPPType()` — if it's `USIOJsonValue*` it packs a wrapped JSON value into Arg01; if it's `FString` it packs a stringified JSON into the single arg; etc. **There is no fallback for "first param is FString, second param is USIOJsonValue*"** — the plugin packs an FString and calls. The second param gets whatever uninitialised stack memory was at that offset. Symptom is an access-violation crash deep inside `USIOJsonValue::AsObject()` reading `0xffffffff` (or another garbage address) on the FIRST inbound event the binding ever receives. Diagnosed 2026-06-15 on the first end-to-end command test (the binding had been in the codebase since Phase 4A but never actually invoked because no command had ever been sent through the dashboard before per-app UI shipped). **Fix: any UFUNCTION bound via `BindEventToFunction` MUST have `USIOJsonValue*` (or one of the other supported single types — see the if/else chain in `CallBPFunctionWithResponse`) as its sole or first parameter.** A leading `FString EventName` parameter — natural for handlers that listen to multiple events — will silently miscall. We dropped `EventName` from `HandleHeadsetCommandEvent` since we know the event name from the binding; a multi-event handler should use a separate UFUNCTION per event instead. There's a CRITICAL comment on both the .h declaration and .cpp body of `HandleHeadsetCommandEvent` warning against re-introducing the bug — preserve it when porting.

---

## Future: extract to a real Unreal plugin

If OneBonsai ships a second app that should plug into the dashboard,
the highest-leverage refactor is packaging the signaling layer as a
proper `OneBonsaiSignaling.uplugin`:

- Module containing `USignalingSubsystem` + `UOneBonsaiBP` (static BP
  function library: "Bind Pawn to Subsystem", "Get Current Pairing Code",
  "Wait For Credentials Ready")
- Pre-built `WBP_PairingHUD` widget (once Phase C lands)
- `Plugins/OneBonsaiSignaling/Config/DefaultOneBonsaiSignaling.ini`
  with canonical settings
- The plugin's own README mirroring this guide

That turns the recipe into: *"drop the plugin folder in, enable it in
`.uproject`, fill in three INI values."* Half-day refactor, premature
to do now while the API surface is still settling but worth doing
once we have a second consumer.

When that refactor lands, the porting workflow simplifies dramatically
and this `HowToPort.md` collapses to a one-screen plugin install guide.

---

## Related project docs

- [`README.md`](README.md) — top-level project overview + per-host setup.
- [`HowToDeploy.md`](HowToDeploy.md) — counterpart of this guide: how to deploy the web dashboard to a public domain. The web developer's handoff doc. Together this and `HowToDeploy.md` form the full UE-app + web-stack handoff package.
- [`Devlog.md`](Devlog.md) — session-by-session decisions and lessons. Search for "Phase 4 Phase A" / "Phase B" / "Pico VR Phase A" entries for the deepest detail on every line of the signaling layer.
- [`.cursorrules`](.cursorrules) — master technical contract: wire protocol, performance bars, build commands.
- [`VR_Project/Plugins/README.md`](VR_Project/Plugins/README.md) — plugin install recipes (Agora / SocketIOClient / PICOXR).
- [`Web_Dashboard/README.md`](Web_Dashboard/README.md) — server API surface table + local-dev setup.

---

## Change log

Append a row when this guide's prescriptions change (new plugin, BP shape change, new gotcha learned, etc.). Most-recent first.

| Date | Commit | What changed |
|---|---|---|
| 2026-06-15 (follow-up) | `<this commit>` | End-to-end PIE verification of per-app control plane caught two issues, both now fixed and documented. (1) **Gotcha #13 added** — the SocketIOClient plugin's `BindEventToFunction` inspects only the first UFUNCTION parameter to decide arg-packing; a leading `FString EventName` param with a trailing `USIOJsonValue*` silently miscalls and crashes in `AsObject()` on first inbound event. Fix: drop the `FString` and bind one UFUNCTION per event. CRITICAL warning comments now live on the .h declaration + .cpp body of `HandleHeadsetCommandEvent`. (2) **New BP overload `EmitStateUpdateFromJson(StateName, DataJsonString)`** — the original `USIOJsonObject*` variant is verbose for array-of-objects payloads (e.g. `available_levels`); the JSON-string variant lets BPs ship the entire payload as a single literal or `Format Text` result. A.4.3 now documents both with "pick whichever is simpler for your data shape" guidance. TL;DR row for `SignalingSubsystem.h/.cpp` lists both variants. Also corrected an incorrect node name reference: parsing `Command.PayloadJson` uses `Construct Json Object` + `Decode Json` (two nodes, both under `SIOJ \| Json`), NOT the fictional "Construct Json Object From String" node. |
| 2026-06-15 | `<this commit>` | Per-app interactive control plane landed. `USignalingSubsystem` BP surface grew `EmitStateUpdate(StateName, Data)` (BP-callable), `AppId` + `AppVersion` (BP-readable, loaded from `DefaultGame.ini`), and `FSignalingCommand::PayloadJson` (full JSON of any inbound command, so per-app commands parse cleanly in BP without new C++ struct fields per command shape). New TL;DR row for the per-app dashboard module convention (`Web_Dashboard/public/js/apps/<AppId>.js`). New sub-recipe **A.4.3** documents the wiring for any target project that wants instructor-side UI beyond the four app-agnostic commands. New cross-reference to the wire-protocol docs (`Web_Dashboard/docs/commands.md` for web → headset, `Web_Dashboard/docs/state-updates.md` for headset → web). INI snippet in A.3 now includes `AppId` + `AppVersion`. The full control plane is **opt-in**: target projects that leave `AppId` blank still stream video + accept legacy commands, they just don't get app-specific dashboard UI. |
| 2026-06-11 | `<this commit>` | Phase 1 Agora cost-exposure shipped (Devlog 2026-06-11). New `HeadsetPresenceMonitor.h/.cpp` added to TL;DR portability table + A.2 copy step + A.4.2 BP wiring sub-recipe + reference-table row. `Build.cs` snippet now mentions the `HeadMountedDisplay` dep needed for it. SignalingSubsystem TL;DR row updated to list the new BP-callable surface (`EmitHeadsetEnd` made public, new `RequestSessionResume`). The component is presented as "recommended for production, skippable for desktop-only" — host apps with their own idle-detection can leave it out. |
| 2026-06-08 | `2a98aea` | Per-device cook wrapper landed (`Tools/Cook-VRApp.ps1`) — replaces yesterday's manual-flip workaround for the universal-APK HMD-priority regression. Gotcha #12 fully rewritten to describe the script-based model + Quest baseline. TL;DR "PICOXR + universal-VR config" row updated to recommend the wrapper as the cook entry point. The script is portable to any project that ships PICOXR + Meta-OpenXR side-by-side. |
| 2026-06-08 | `1d2872f` | Phase 6 closeout (2-device test passes on real cross-vendor hardware). Added two new gotchas: #11 (`PICOTouch_*` EKeys are not bound by stock Quest-first IMCs — Pico controllers silently inert without an IMC audit) with the authoritative key-list extraction recipe, and #12 (the universal-APK promise from the 2026-06-03 Pico-A entry is broken on PICO OS 5+, documenting the manual workaround pending a proper fix). |
| 2026-06-05 | `afe08c6` | Phase 6D channel-swap fix: new `USignalingSubsystem::OnAgoraChannelChanged(NewChannel)` delegate + `UAgoraVideoPump::RestartForNewChannel()` BP-callable. Recipe A.4 grew a 4th BP wiring step + new *A.4.1* subsection documenting the swap handler graph and the underlying Agora-channel-binding rationale. New gotcha #9 (`OnCredentialsReady` is first-boot only) and #10 (`GConfig` is load-once-at-editor-startup). TL;DR table updated from "4 graphs" to "5 graphs". |
| 2026-06-04 | `26fefa1` | Phase 6D: added `UTenantRegistry` (first-launch code-redemption subsystem with persisted tenant binding); new INI block `[/Script/<Module>.TenantRegistry]`; new *BYO code-input UI* section for host apps that already have a registration panel; new gotcha #8 about `InitializeDependency` ordering between signaling and registry. |
| 2026-06-04 | `d65bc98` | Initial guide. Covers `USignalingSubsystem` (rev `d65bc98`), PICOXR 3.4.1 + duplicate-method patch, AgoraVideoPump (Recipe B), 7 common gotchas, future-plugin proposal. |
