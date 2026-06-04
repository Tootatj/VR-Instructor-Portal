# How to Port the VR Instructor Portal into Another Unreal Project

> **Last verified against:** UE 5.5.4 · PICOXR 3.4.1 · SocketIOClient v2.9.0 · Agora-Unreal-RTC-SDK v4.5.1 · `USignalingSubsystem` + `UTenantRegistry` git rev `8e1c8b6`
>
> **Maintainer rule:** every time `SignalingSubsystem.h/.cpp`, `TenantRegistry.h/.cpp`,
> the BP integration shape on `BP_VRPawn`, or the plugin set changes, update
> the matching section below in the same commit. Add a row to the bottom of
> the *Change log* at the end of this file with the date + commit hash +
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
| `SignalingSubsystem.h/.cpp` | **Drop-in.** Zero dependency on this project's pawn, scene, or Agora. Pure UE + Socket.IO + HTTP. |
| `TenantRegistry.h/.cpp` | **Drop-in.** Pure UE + HTTP + `FFileHelper`. Owns the first-launch company-code redemption + persistence. **Replaces any prior hardcoded `TenantId` in INI.** Has no UMG dependency — host apps can use their existing in-VR code-input panel (see *BYO code-input UI* section below). |
| `Web_Dashboard/` server | **Already portable.** Runs once, serves any UE app that speaks the wire protocol. |
| BP integration on `BP_VRPawn` | **Pattern, not asset.** Reproduce the 3 (now 4 — registration gate) graphs in the target project's pawn or game mode. Worked example included. |
| Agora streaming pipeline (`AgoraVideoPump.h/.cpp` + Agora plugin) | **Optional / copyable.** Only needed if the target project has no streaming and you want this stack to provide it. |
| PICOXR + universal-VR config | **Drop-in via** [`VR_Project/Plugins/README.md`](VR_Project/Plugins/README.md). Same recipe regardless of target. |

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
```

### A.2. Copy the C++ files

```powershell
copy VR_Project\Source\VR_Project\SignalingSubsystem.h  <Target>\Source\<TargetModule>\
copy VR_Project\Source\VR_Project\SignalingSubsystem.cpp <Target>\Source\<TargetModule>\
copy VR_Project\Source\VR_Project\TenantRegistry.h      <Target>\Source\<TargetModule>\
copy VR_Project\Source\VR_Project\TenantRegistry.cpp    <Target>\Source\<TargetModule>\
```

The classes need **no edits** unless the target's module API macro differs:
in `SignalingSubsystem.h` and `TenantRegistry.h`, change `VR_PROJECT_API`
to `<TARGETMODULE>_API` (the macro UBT generates per module, all-caps +
`_API`). The `#include "TenantRegistry.h"` in `SignalingSubsystem.cpp`
should not need editing — both files end up in the same module.

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

Three graph edits, all on the BP that owns the `Initialize` → `Make RtcEngineContext`
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

Reference implementation: `VR_Project/Content/VRTemplate/Blueprints/VRPawn.uasset`
(open the asset, look at `BeginPlay` and the `OnSignalingReady` custom event).

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
2. **In your existing panel's submit handler BP graph:**

   ```
   [On Submit Clicked]
       → Get Game Instance → Get Subsystem (UTenantRegistry)
       → Redeem Code:
            Code = <your text-input widget's text>
            Callback = bind a Custom Event with signature (bool bSuccess, FString ErrorMessage)
                On bSuccess=true  → hide your panel + unblock the app start flow
                On bSuccess=false → display ErrorMessage in your existing error label
   ```

3. **Bind `OnRegistrationChanged` once at panel-construct time** to handle the case where the registration is wiped at runtime (e.g. via your existing "switch organization" / "log out" affordance):

   ```
   [Construct]
       → Get Game Instance → Get Subsystem (UTenantRegistry)
       → Assign OnRegistrationChanged:
            On fire → if IsRegistered() == false: show your panel again
   ```

4. **No other panel changes needed.** The host app's existing scene start
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
- [`Devlog.md`](Devlog.md) — session-by-session decisions and lessons. Search for "Phase 4 Phase A" / "Phase B" / "Pico VR Phase A" entries for the deepest detail on every line of the signaling layer.
- [`.cursorrules`](.cursorrules) — master technical contract: wire protocol, performance bars, build commands.
- [`VR_Project/Plugins/README.md`](VR_Project/Plugins/README.md) — plugin install recipes (Agora / SocketIOClient / PICOXR).
- [`Web_Dashboard/README.md`](Web_Dashboard/README.md) — server API surface table.

---

## Change log

Append a row when this guide's prescriptions change (new plugin, BP shape change, new gotcha learned, etc.). Most-recent first.

| Date | Commit | What changed |
|---|---|---|
| 2026-06-04 | `<this commit>` | Phase 6D: added `UTenantRegistry` (first-launch code-redemption subsystem with persisted tenant binding); new INI block `[/Script/<Module>.TenantRegistry]`; new *BYO code-input UI* section for host apps that already have a registration panel; new gotcha #8 about `InitializeDependency` ordering between signaling and registry. |
| 2026-06-04 | `d65bc98` | Initial guide. Covers `USignalingSubsystem` (rev `d65bc98`), PICOXR 3.4.1 + duplicate-method patch, AgoraVideoPump (Recipe B), 7 common gotchas, future-plugin proposal. |
