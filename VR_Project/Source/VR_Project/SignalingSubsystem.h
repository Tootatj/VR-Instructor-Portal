// USignalingSubsystem
//
// UGameInstanceSubsystem that owns the headset's relationship with the
// Web_Dashboard signaling server. Speaks the wire protocol documented in
// `.cursorrules §5.1`, `Web_Dashboard/README.md`,
// `Web_Dashboard/docs/commands.md`, and `Web_Dashboard/docs/state-updates.md`:
//
//   1. Socket.IO connect to ws://<ServerUrl>/socket.io
//   2. emit `headset:register` { code, tenantId, scenario, traineeName,
//      source:"headset", appId?, appVersion? } with ack callback
//      → expects { ok:true, tenantId }. Optional appId enables the
//      per-app interactive control plane (2026-06-15).
//   3. POST /api/token { code, role:"publisher", uid:0 }
//      → 200 { appId, token, channel, uid, expiresAt }
//   4. Fires OnCredentialsReady so BP_VRPawn can JoinChannel with the
//      server-minted values.
//   5. Listens for `headset:command` and re-broadcasts as OnHeadsetCommand.
//      Commands carry both the legacy typed fields AND a full PayloadJson
//      string so per-app commands (e.g. VRFT's load_level) parse cleanly.
//   6. Emits `headset:state-update` { code, state, data?, seq? } from BP
//      via EmitStateUpdate — the headset side of the per-app control plane.
//      Server fans these out to the dashboard's per-app UI module.
//   7. Refreshes the token at expiresAt - 300s (safety net well inside
//      Agora's own OnTokenPrivilegeWillExpire window).
//   8. On Deinitialize, emits `headset:end` so the server can prune the room
//      immediately rather than waiting for the disconnect-driven cleanup.
//
// Pairing code strategy: random per cold launch, retained across hot
// reconnects within the same boot. New cold launch → new code.
//
// App identity strategy: AppId + AppVersion read from
// Config/DefaultGame.ini's [/Script/VR_Project.SignalingSubsystem] section.
// Each target VR project sets its own values when porting (e.g. "VRFT" /
// "1.0.0" for VR Fire Training). An empty AppId is valid — the server
// treats the session as app-less and the dashboard falls back to a
// generic video-only panel.

#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"

// SocketIONative.h pulls in the ESIOConnectionCloseReason enum that UHT needs
// to see in this header (UFUNCTION signature below uses TEnumAsByte<...>).
// Forward-declare doesn't work here because UHT generates reflection code
// that references the enum by name.
#include "SocketIONative.h"

#include "SignalingSubsystem.generated.h"

class USocketIOClientComponent;
class USIOJsonValue;

UENUM(BlueprintType)
enum class ESignalingState : uint8
{
    Disconnected   UMETA(DisplayName = "Disconnected"),
    Connecting     UMETA(DisplayName = "Connecting"),
    Registering    UMETA(DisplayName = "Registering"),
    Live           UMETA(DisplayName = "Live"),
    Reconnecting   UMETA(DisplayName = "Reconnecting"),
};

USTRUCT(BlueprintType)
struct FSignalingCommand
{
    GENERATED_BODY()

    // Command identifier. The four canonical app-agnostic commands per
    // docs/commands.md are: "pause_simulation", "change_environment",
    // "trigger_event", "reset_user_position". App-specific commands
    // (e.g. VRFT's "load_level", "return_to_hub") flow through the same
    // struct with their payload in PayloadJson — BP parses it via the
    // SocketIO plugin's JSON nodes. BP should switch on Command and
    // ignore unknowns per .cursorrules §5.2.
    UPROPERTY(BlueprintReadOnly, Category = "Signaling")
    FString Command;

    // pause_simulation.value — set only for "pause_simulation" commands.
    UPROPERTY(BlueprintReadOnly, Category = "Signaling")
    bool BoolValue = false;

    // change_environment.map_name OR trigger_event.event_type — set only for
    // those two commands.
    UPROPERTY(BlueprintReadOnly, Category = "Signaling")
    FString StringValue;

    // 2026-06-15 — per-app interactive control plane. The full JSON of the
    // command (including the "command" field itself), so BP can parse
    // app-specific fields without needing a new typed field per new
    // command shape. For the four legacy app-agnostic commands above the
    // typed fields stay populated for back-compat; new app-specific
    // commands (e.g. VRFT's "load_level": { level_id: "kitchen_fire" })
    // only populate PayloadJson and the BP author parses it with the
    // SocketIO plugin's two-step "Construct Json Object" → "Decode Json"
    // pattern (both under category SIOJ | Json).
    UPROPERTY(BlueprintReadOnly, Category = "Signaling")
    FString PayloadJson;
};

DECLARE_DYNAMIC_MULTICAST_DELEGATE(FOnCredentialsReady);
DECLARE_DYNAMIC_MULTICAST_DELEGATE(FOnTokenRefreshed);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnSignalingStateChanged, ESignalingState, NewState);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnHeadsetCommand, const FSignalingCommand&, Command);

// Fired when the Agora channel the headset is supposed to be publishing on
// changes AFTER the first successful credentials fetch — i.e. mid-session
// tenant swaps via UTenantRegistry (`ClearRegistration` and/or `RedeemCode`).
//
// First-boot credentials never fire this; they fire OnCredentialsReady as
// before, so existing BP graphs that initialise + JoinChannel on first
// credentials keep working untouched.
//
// `NewChannel.IsEmpty()` means "leave the current channel, no rejoin coming"
// (e.g. user called ClearRegistration without a follow-up RedeemCode — device
// is in limbo until a new code is redeemed). BP should LeaveChannel and stop
// the video pump but NOT attempt to JoinChannel on an empty string.
//
// Non-empty `NewChannel` means "swap channels": BP should
//   1. UAgoraVideoPump::StopVideoPump (or RestartForNewChannel after JoinChannel succeeds)
//   2. Agora LeaveChannel
//   3. Agora JoinChannel(NewChannel, subsystem.AgoraToken, subsystem.AgoraUid)
//   4. On OnJoinChannelSuccess: UAgoraVideoPump::StartVideoPump
// See Devlog "Phase 6D channel-swap fix" entry for the why.
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnAgoraChannelChanged, const FString&, NewChannel);

UCLASS()
class VR_PROJECT_API USignalingSubsystem : public UGameInstanceSubsystem
{
    GENERATED_BODY()

public:
    virtual void Initialize(FSubsystemCollectionBase& Collection) override;
    virtual void Deinitialize() override;

    // --- BP-readable runtime state (Phase B's BP graph reads from these) ---

    UPROPERTY(BlueprintReadOnly, Category = "Signaling")
    FString PairingCode;

    UPROPERTY(BlueprintReadOnly, Category = "Signaling")
    FString TenantId;

    UPROPERTY(BlueprintReadOnly, Category = "Signaling")
    FString AgoraAppId;

    UPROPERTY(BlueprintReadOnly, Category = "Signaling")
    FString AgoraToken;

    UPROPERTY(BlueprintReadOnly, Category = "Signaling")
    FString AgoraChannel;

    UPROPERTY(BlueprintReadOnly, Category = "Signaling")
    int32 AgoraUid = 0;

    UPROPERTY(BlueprintReadOnly, Category = "Signaling")
    ESignalingState State = ESignalingState::Disconnected;

    // 2026-06-15 — per-app interactive control plane. Identifier the headset
    // declares in `headset:register` so the dashboard's focus view knows
    // which per-app UI module to load (e.g. "VRFT" → apps/VRFT.js).
    // Loaded from Config/DefaultGame.ini section
    // [/Script/VR_Project.SignalingSubsystem] key `AppId`. Empty means
    // "no app declared" — server treats the session as app-less and the
    // dashboard renders a generic video-only panel.
    UPROPERTY(BlueprintReadOnly, Category = "Signaling")
    FString AppId;

    // Free-form version label. Useful when one VR app evolves its state
    // machine + commands across releases. Loaded from the same INI key
    // `AppVersion`. Empty when unset.
    UPROPERTY(BlueprintReadOnly, Category = "Signaling")
    FString AppVersion;

    // --- BP-assignable delegates ---

    UPROPERTY(BlueprintAssignable, Category = "Signaling")
    FOnCredentialsReady OnCredentialsReady;

    UPROPERTY(BlueprintAssignable, Category = "Signaling")
    FOnTokenRefreshed OnTokenRefreshed;

    UPROPERTY(BlueprintAssignable, Category = "Signaling")
    FOnSignalingStateChanged OnStateChanged;

    UPROPERTY(BlueprintAssignable, Category = "Signaling")
    FOnHeadsetCommand OnHeadsetCommand;

    UPROPERTY(BlueprintAssignable, Category = "Signaling")
    FOnAgoraChannelChanged OnAgoraChannelChanged;

    // --- BP-callable ---

    // Mint a fresh Agora token for the current code. Fires OnTokenRefreshed
    // with the new value populated in AgoraToken. BP_VRPawn should call this
    // from the Agora OnTokenPrivilegeWillExpire event and feed AgoraToken
    // into the plugin's renewToken node when OnTokenRefreshed fires.
    UFUNCTION(BlueprintCallable, Category = "Signaling")
    void RefreshToken();

    // Phase 1 Agora cost-exposure (Devlog 2026-06-11). Tell the server to
    // prune our session now (instead of waiting for the disconnect-driven
    // cleanup). Fire-and-forget — safe to call when not connected or
    // already-disconnected (no-op in both cases).
    //
    // Pairs with RequestSessionResume below for the "headset taken off
    // -> server prunes -> headset put back on -> server re-creates"
    // round-trip driven by UHeadsetPresenceMonitor. The socket stays
    // open throughout (the underlying TCP/WebSocket connection is the
    // cheap part); only the room state on the server is torn down.
    UFUNCTION(BlueprintCallable, Category = "Signaling")
    void EmitHeadsetEnd();

    // Phase 1 Agora cost-exposure. Resume from an idle-detected pause:
    // re-emits headset:register on the existing socket (the server
    // re-creates the room) and re-fetches a fresh Agora token (the
    // previous one was scoped to the now-pruned channel). The fresh
    // /api/token response fires OnAgoraChannelChanged (because
    // bHasFiredInitialCredentials is already true from the original
    // boot), which the existing BP graph handles — no new BP wiring
    // required for the re-join cascade itself.
    //
    // Safe to call multiple times; the bRegisterInFlight guard inside
    // EmitHeadsetRegister coalesces concurrent calls.
    UFUNCTION(BlueprintCallable, Category = "Signaling")
    void RequestSessionResume();

    // 2026-06-15 — per-app interactive control plane. Publish a state
    // transition to the dashboard. The server fans it out to every
    // instructor currently subscribed to this headset's tenant, plus the
    // legacy 1:1 instructor pinned to this code (if any).
    //
    // StateName: lowercase snake_case label (≤64 chars, matches
    //   /^[a-z][a-z0-9_]{0,63}$/). Free-form per app; the per-app
    //   dashboard module knows which state names to expect.
    //
    // Data: optional USIOJsonObject (construct via SocketIO plugin's
    //   "Construct Json Object" BP node + setters, or pass nullptr/None
    //   for stateless transitions). Server caps the serialised payload
    //   at 8 KB; oversize payloads are dropped server-side with a
    //   diagnostic log.
    //
    // Fire-and-forget — no ack-handling needed in BP. Server-side rate
    // limit is 30 updates per 3-second sliding window per code, so the
    // BP author should emit once per real state transition, not once
    // per tick.
    UFUNCTION(BlueprintCallable, Category = "Signaling", meta = (DisplayName = "Emit State Update"))
    void EmitStateUpdate(const FString& StateName, USIOJsonObject* Data);

    // Convenience overload that takes the data as a JSON string instead
    // of a USIOJsonObject. Useful when the data shape is complex (e.g.
    // VRFT's hub state with its available_levels array) — building 10+
    // nested Construct Json Object nodes in BP gets unwieldy fast;
    // `Format Text` or string concat from a Data Table is often cleaner.
    //
    // DataJsonString must parse as a JSON OBJECT (top-level `{...}`).
    // Parse failures log a warning and emit with no data rather than
    // dropping the transition entirely — losing the transition is
    // strictly worse than losing the payload fields.
    //
    // Pass an empty string for stateless transitions (equivalent to
    // calling EmitStateUpdate with Data=None).
    UFUNCTION(BlueprintCallable, Category = "Signaling", meta = (DisplayName = "Emit State Update (From JSON String)"))
    void EmitStateUpdateFromJson(const FString& StateName, const FString& DataJsonString);

private:
    // Shared backend for both BP-callable EmitStateUpdate overloads.
    // Data may be null for stateless transitions.
    void EmitStateUpdateInternal(const FString& StateName, TSharedPtr<FJsonObject> Data);

    void LoadConfig();
    void GeneratePairingCode();
    void OpenSocket();
    void EmitHeadsetRegister();
    void FetchToken(bool bIsRefresh);

    void SetState(ESignalingState NewState);

    // Phase 6D: tenantId comes from UTenantRegistry (the persisted
    // first-launch redemption), with the INI value as a dev fallback.
    // If the user hasn't registered and bAllowUnregisteredBoot is false
    // on the registry side, we listen for OnRegistrationChanged and
    // defer the socket boot until registration lands.
    UFUNCTION()
    void HandleRegistrationChanged();
    void RefreshTenantFromRegistry();

    // Bound to USocketIOClientComponent's BlueprintAssignable delegates.
    UFUNCTION()
    void HandleSocketConnected(FString SocketId, FString SessionId, bool bIsReconnection);

    UFUNCTION()
    void HandleSocketDisconnected(TEnumAsByte<ESIOConnectionCloseReason> Reason);

    UFUNCTION()
    void HandleConnectionProblems(int32 Attempts, int32 NextAttemptInMs, float TimeSinceConnected);

    // Bound to the `headset:command` event via BindEventToFunction.
    //
    // CRITICAL: the SocketIO plugin's BindEventToFunction inspects ONLY the
    // FIRST UFUNCTION parameter to decide how to pack the call args (see
    // USocketIOClientComponent::CallBPFunctionWithResponse). If the first
    // param is anything other than the inbound JSON type (USIOJsonValue*
    // here), the plugin packs the wrong shape into ProcessEvent and any
    // additional params receive UNINITIALISED stack memory. We learned
    // this with an access-violation crash on the first inbound command
    // ever sent through this binding (2026-06-15). Do NOT add a leading
    // FString EventName parameter — the event name is implicit from the
    // binding, and the plugin will silently miscall.
    UFUNCTION()
    void HandleHeadsetCommandEvent(USIOJsonValue* EventData);

    void ScheduleTokenRefresh(double ExpiresAtUnixSeconds);

    // Owned socket client. Created on GameInstance outer (USocketIOClientComponent
    // is a UActorComponent but works fine as a non-attached helper here).
    UPROPERTY()
    TObjectPtr<USocketIOClientComponent> Socket;

    // Config (read from Config/DefaultGame.ini section
    // [/Script/VR_Project.SignalingSubsystem], with safe fallbacks).
    FString ServerUrl;
    FString Scenario;
    FString TraineeName;

    // Lifecycle bookkeeping.
    FTimerHandle TokenRefreshTimer;
    double LastExpiresAtUnixSeconds = 0.0;
    bool bRefreshInFlight = false;
    bool bRegisterInFlight = false;

    // True after the first non-refresh /api/token response has fired
    // OnCredentialsReady. Subsequent non-refresh token fetches (caused by a
    // re-registration or tenant swap) fire OnAgoraChannelChanged instead, so
    // the first-boot BP graph that does Initialize+JoinChannel only ever runs
    // once and the second/third/Nth credentials cycle goes through the
    // channel-swap path (LeaveChannel + JoinChannel + pump restart).
    bool bHasFiredInitialCredentials = false;
};
