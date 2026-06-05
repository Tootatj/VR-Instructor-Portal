// USignalingSubsystem
//
// UGameInstanceSubsystem that owns the headset's relationship with the
// Web_Dashboard signaling server. Speaks the wire protocol documented in
// `.cursorrules §5.1` and `Web_Dashboard/README.md`:
//
//   1. Socket.IO connect to ws://<ServerUrl>/socket.io
//   2. emit `headset:register` { code, tenantId, scenario, traineeName,
//      source:"headset" } with ack callback → expects { ok:true, tenantId }
//   3. POST /api/token { code, role:"publisher", uid:0 }
//      → 200 { appId, token, channel, uid, expiresAt }
//   4. Fires OnCredentialsReady so BP_VRPawn can JoinChannel with the
//      server-minted values.
//   5. Listens for `headset:command` and re-broadcasts as OnHeadsetCommand.
//   6. Refreshes the token at expiresAt - 300s (safety net well inside
//      Agora's own OnTokenPrivilegeWillExpire window).
//   7. On Deinitialize, emits `headset:end` so the server can prune the room
//      immediately rather than waiting for the disconnect-driven cleanup.
//
// Pairing code strategy: random per cold launch, retained across hot
// reconnects within the same boot. New cold launch → new code.

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

    // One of: "pause_simulation", "change_environment", "trigger_event",
    // "reset_user_position". BP should switch on this and ignore unknowns
    // per .cursorrules §5.2.
    UPROPERTY(BlueprintReadOnly, Category = "Signaling")
    FString Command;

    // pause_simulation.value — set only for "pause_simulation" commands.
    UPROPERTY(BlueprintReadOnly, Category = "Signaling")
    bool BoolValue = false;

    // change_environment.map_name OR trigger_event.event_type — set only for
    // those two commands.
    UPROPERTY(BlueprintReadOnly, Category = "Signaling")
    FString StringValue;
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

private:
    void LoadConfig();
    void GeneratePairingCode();
    void OpenSocket();
    void EmitHeadsetRegister();
    void FetchToken(bool bIsRefresh);
    void EmitHeadsetEnd();

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
    UFUNCTION()
    void HandleHeadsetCommandEvent(FString EventName, USIOJsonValue* EventData);

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
