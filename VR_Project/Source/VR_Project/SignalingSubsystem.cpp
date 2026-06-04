#include "SignalingSubsystem.h"

#include "TenantRegistry.h"

#include "SocketIOClientComponent.h"
#include "SIOJsonValue.h"
#include "SIOJsonObject.h"
#include "SocketIONative.h"

#include "Engine/GameInstance.h"
#include "TimerManager.h"

#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

DEFINE_LOG_CATEGORY_STATIC(LogVRIPSignaling, Log, All);

// Token-refresh safety net: re-mint at expiresAt - this many seconds. Sized
// well inside Agora's own OnTokenPrivilegeWillExpire window (~30 s) so we
// almost always refresh before Agora's event fires. If both fire we just
// double-emit, which the server happily handles.
namespace
{
    constexpr double kTokenRefreshLeadSeconds = 300.0;

    // Strip trailing slashes so "http://host:3000/" works the same as
    // "http://host:3000" — the SocketIO Connect helper appends its own.
    FString NormalizeUrl(const FString& In)
    {
        FString S = In;
        while (S.EndsWith(TEXT("/")))
        {
            S.LeftChopInline(1);
        }
        return S;
    }
}

// --- Lifecycle ---------------------------------------------------------------

void USignalingSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
    Super::Initialize(Collection);

    // GameInstanceSubsystem init order is non-deterministic. Force the
    // registry to finish its Initialize (which loads the persisted JSON
    // from disk) BEFORE we ask it for the tenantId below. Without this
    // we'd race: signaling might read an empty registry, fall through
    // to the INI fallback, and end up registering on the wrong tenant.
    Collection.InitializeDependency(UTenantRegistry::StaticClass());

    LoadConfig();
    GeneratePairingCode();
    RefreshTenantFromRegistry();

    // Subscribe to registration changes so:
    //   - Unregistered boots can pick up a freshly-redeemed code and
    //     open the socket on the spot, without an app restart.
    //   - "Switch organisation" (ClearRegistration + new RedeemCode)
    //     can re-register on a different tenant cleanly.
    if (UTenantRegistry* Registry = GetGameInstance()->GetSubsystem<UTenantRegistry>())
    {
        Registry->OnRegistrationChanged.AddDynamic(this, &USignalingSubsystem::HandleRegistrationChanged);
    }

    UE_LOG(LogVRIPSignaling, Log,
        TEXT("Initialize: code=%s tenant=%s server=%s scenario=\"%s\" trainee=\"%s\""),
        *PairingCode, *TenantId, *ServerUrl, *Scenario, *TraineeName);

    // Defer the socket boot if the device hasn't registered yet AND
    // the registry is in strict mode. The UMG gate (or any custom
    // host-app code-input panel) eventually calls
    // UTenantRegistry::RedeemCode → OnRegistrationChanged → we boot.
    if (UTenantRegistry* Registry = GetGameInstance()->GetSubsystem<UTenantRegistry>())
    {
        if (!Registry->IsRegistered())
        {
            // bAllowUnregisteredBoot=true (the dev default) means we
            // boot anyway with the INI tenant — keeps the existing
            // onebonsai-only flow working until the UMG gate is wired.
            bool bAllow = true;
            GConfig->GetBool(TEXT("/Script/VR_Project.TenantRegistry"),
                TEXT("bAllowUnregisteredBoot"), bAllow, GGameIni);
            if (!bAllow)
            {
                UE_LOG(LogVRIPSignaling, Log,
                    TEXT("Initialize: not registered + strict mode — deferring socket boot until OnRegistrationChanged"));
                SetState(ESignalingState::Disconnected);
                return;
            }
            UE_LOG(LogVRIPSignaling, Warning,
                TEXT("Initialize: not registered but bAllowUnregisteredBoot=true — booting with INI fallback tenant=%s"),
                *TenantId);
        }
    }

    OpenSocket();
}

void USignalingSubsystem::Deinitialize()
{
    UE_LOG(LogVRIPSignaling, Log, TEXT("Deinitialize: emitting headset:end + disconnecting"));

    if (UWorld* World = GetWorld())
    {
        World->GetTimerManager().ClearTimer(TokenRefreshTimer);
    }

    EmitHeadsetEnd();

    if (Socket)
    {
        // SyncDisconnect is the only safe option in Deinitialize — the async
        // Disconnect would still be running when GameInstance unwinds.
        Socket->SyncDisconnect();
        Socket = nullptr;
    }

    Super::Deinitialize();
}

// --- Config + pairing code generation ---------------------------------------

void USignalingSubsystem::LoadConfig()
{
    // Reads section [/Script/VR_Project.SignalingSubsystem] from
    // Config/DefaultGame.ini. Falls back to sane defaults so a missing config
    // section never bricks the subsystem (it'll connect to localhost and
    // log enough that the dev knows to fix it).
    //
    // NOTE: TenantId is NOT read here anymore. It now comes from
    // UTenantRegistry::ResolveTenantIdForSignaling() — see
    // RefreshTenantFromRegistry() below. The INI TenantId is kept as a
    // dev fallback inside the registry's resolver.
    const TCHAR* Section = TEXT("/Script/VR_Project.SignalingSubsystem");

    if (!GConfig->GetString(Section, TEXT("ServerUrl"), ServerUrl, GGameIni) || ServerUrl.IsEmpty())
    {
        ServerUrl = TEXT("http://127.0.0.1:3000");
    }
    ServerUrl = NormalizeUrl(ServerUrl);

    if (!GConfig->GetString(Section, TEXT("Scenario"), Scenario, GGameIni))
    {
        Scenario = TEXT("Fire Training");
    }

    if (!GConfig->GetString(Section, TEXT("TraineeName"), TraineeName, GGameIni))
    {
        TraineeName = TEXT("Demo Trainee");
    }
}

void USignalingSubsystem::RefreshTenantFromRegistry()
{
    if (UTenantRegistry* Registry = GetGameInstance()->GetSubsystem<UTenantRegistry>())
    {
        TenantId = Registry->ResolveTenantIdForSignaling();
    }
    else
    {
        // Defensive fallback if for some reason the registry subsystem
        // didn't init (e.g. an unrelated load-order issue) — log loudly
        // so it's debuggable, then use the INI default.
        UE_LOG(LogVRIPSignaling, Error,
            TEXT("RefreshTenantFromRegistry: UTenantRegistry subsystem not found! Falling back to INI tenant"));
        GConfig->GetString(TEXT("/Script/VR_Project.SignalingSubsystem"),
            TEXT("TenantId"), TenantId, GGameIni);
        if (TenantId.IsEmpty())
        {
            TenantId = TEXT("onebonsai");
        }
    }
}

void USignalingSubsystem::HandleRegistrationChanged()
{
    UE_LOG(LogVRIPSignaling, Log, TEXT("HandleRegistrationChanged: registry changed, re-resolving tenant"));

    const FString OldTenant = TenantId;
    RefreshTenantFromRegistry();

    // First-time registration: socket isn't open yet (we were waiting
    // for this exact event). Open it now with the freshly resolved
    // tenant.
    if (!Socket)
    {
        UE_LOG(LogVRIPSignaling, Log,
            TEXT("HandleRegistrationChanged: socket not yet open, opening now with tenant=%s"),
            *TenantId);
        OpenSocket();
        return;
    }

    // Tenant actually changed at runtime (e.g. "Switch organisation"
    // pause-menu flow): tear down and reopen with the new tenant.
    // EmitHeadsetEnd cleans up the previous tenant's session; the
    // socket disconnect + reconnect will re-register cleanly under
    // the new tenant.
    if (OldTenant != TenantId)
    {
        UE_LOG(LogVRIPSignaling, Log,
            TEXT("HandleRegistrationChanged: tenant changed %s -> %s, reconnecting"),
            *OldTenant, *TenantId);
        EmitHeadsetEnd();
        Socket->SyncDisconnect();
        Socket = nullptr;
        OpenSocket();
    }
}

void USignalingSubsystem::GeneratePairingCode()
{
    // FMath::Rand is seeded by UE on engine init — fine for this purpose.
    // Collision risk on a 4-digit space across a typical fleet is acceptable
    // (~1 in 10k); explicit override via Config/DefaultGame.ini is the answer
    // for known-fleet pinning per the plan.
    FString ConfigCode;
    if (GConfig->GetString(TEXT("/Script/VR_Project.SignalingSubsystem"),
        TEXT("PairingCodeOverride"), ConfigCode, GGameIni) && ConfigCode.Len() == 4)
    {
        PairingCode = ConfigCode;
        return;
    }
    PairingCode = FString::Printf(TEXT("%04d"), FMath::RandRange(0, 9999));
}

// --- Socket lifecycle --------------------------------------------------------

void USignalingSubsystem::OpenSocket()
{
    Socket = NewObject<USocketIOClientComponent>(GetGameInstance());
    Socket->bVerboseConnectionLog = true;

    // The plugin's documented entry point for "use this component outside of
    // an actor/world". Internally: bStaticallyInitialized=true,
    // bLimitConnectionToGameWorld=false, bShouldAutoConnect=false, then
    // InitializeNative() to allocate the underlying FSocketIONative.
    // Skipping this and calling Connect() directly assert-fails on
    // NativeClient->... because InitializeComponent never fires for
    // unregistered components.
    Socket->StaticInitialization(GetGameInstance(), /*bValidOwnerWorld*/ false);

    Socket->OnConnected.AddDynamic(this, &USignalingSubsystem::HandleSocketConnected);
    Socket->OnDisconnected.AddDynamic(this, &USignalingSubsystem::HandleSocketDisconnected);
    Socket->OnConnectionProblems.AddDynamic(this, &USignalingSubsystem::HandleConnectionProblems);

    SetState(ESignalingState::Connecting);

    UE_LOG(LogVRIPSignaling, Log, TEXT("Connecting to %s ..."), *ServerUrl);
    Socket->Connect(ServerUrl);
}

void USignalingSubsystem::HandleSocketConnected(FString SocketId, FString SessionId, bool bIsReconnection)
{
    UE_LOG(LogVRIPSignaling, Log,
        TEXT("Socket connected sock=%s session=%s reconnect=%d"),
        *SocketId, *SessionId, bIsReconnection ? 1 : 0);

    // Subscribe to inbound headset:command BEFORE register so we never miss
    // an early dispatch. Idempotent on reconnect; getnamo handles duplicate
    // binds by replacing.
    Socket->BindEventToFunction(
        TEXT("headset:command"),
        TEXT("HandleHeadsetCommandEvent"),
        this,
        TEXT("/"));

    SetState(ESignalingState::Registering);
    EmitHeadsetRegister();
}

void USignalingSubsystem::HandleSocketDisconnected(TEnumAsByte<ESIOConnectionCloseReason> Reason)
{
    UE_LOG(LogVRIPSignaling, Warning,
        TEXT("Socket disconnected reason=%d — entering Reconnecting"),
        static_cast<int32>(Reason.GetValue()));
    SetState(ESignalingState::Reconnecting);
}

void USignalingSubsystem::HandleConnectionProblems(int32 Attempts, int32 NextAttemptInMs, float TimeSinceConnected)
{
    if (Attempts <= 3 || Attempts % 10 == 0)
    {
        UE_LOG(LogVRIPSignaling, Warning,
            TEXT("Connection problems: attempt=%d next-in-ms=%d disconnected-for=%.1fs"),
            Attempts, NextAttemptInMs, TimeSinceConnected);
    }
    SetState(ESignalingState::Reconnecting);
}

// --- headset:register --------------------------------------------------------

void USignalingSubsystem::EmitHeadsetRegister()
{
    if (bRegisterInFlight)
    {
        UE_LOG(LogVRIPSignaling, Verbose, TEXT("EmitHeadsetRegister: already in flight, skipping"));
        return;
    }
    bRegisterInFlight = true;

    TSharedPtr<FJsonObject> Payload = MakeShared<FJsonObject>();
    Payload->SetStringField(TEXT("code"),         PairingCode);
    Payload->SetStringField(TEXT("tenantId"),     TenantId);
    Payload->SetStringField(TEXT("scenario"),     Scenario);
    Payload->SetStringField(TEXT("traineeName"), TraineeName);
    Payload->SetStringField(TEXT("source"),       TEXT("headset"));

    TWeakObjectPtr<USignalingSubsystem> WeakThis(this);

    Socket->EmitNative(
        TEXT("headset:register"),
        Payload,
        [WeakThis](const TArray<TSharedPtr<FJsonValue>>& Ack)
        {
            USignalingSubsystem* Self = WeakThis.Get();
            if (!Self)
            {
                return;
            }
            Self->bRegisterInFlight = false;

            // Ack contract from pairing.js: { ok: true, tenantId } OR
            // { ok: false, error: "..." }.
            if (Ack.Num() == 0 || !Ack[0].IsValid())
            {
                UE_LOG(LogVRIPSignaling, Error,
                    TEXT("headset:register ack empty — server protocol drift?"));
                return;
            }
            const TSharedPtr<FJsonObject>* AckObj = nullptr;
            if (!Ack[0]->TryGetObject(AckObj) || !AckObj || !AckObj->IsValid())
            {
                UE_LOG(LogVRIPSignaling, Error,
                    TEXT("headset:register ack not an object"));
                return;
            }
            const bool bOk = (*AckObj)->GetBoolField(TEXT("ok"));
            if (!bOk)
            {
                const FString Err = (*AckObj)->GetStringField(TEXT("error"));
                UE_LOG(LogVRIPSignaling, Error,
                    TEXT("headset:register rejected: %s"), *Err);
                return;
            }
            // Server may have resolved tenantId differently (e.g. env default
            // wins if our payload omitted it). Take the canonical value.
            FString AckedTenant;
            if ((*AckObj)->TryGetStringField(TEXT("tenantId"), AckedTenant))
            {
                Self->TenantId = AckedTenant;
            }
            UE_LOG(LogVRIPSignaling, Log,
                TEXT("headset:register ack ok tenant=%s — fetching token"),
                *Self->TenantId);

            Self->FetchToken(/*bIsRefresh*/ false);
        });
}

// --- POST /api/token ---------------------------------------------------------

void USignalingSubsystem::FetchToken(bool bIsRefresh)
{
    if (bIsRefresh && bRefreshInFlight)
    {
        UE_LOG(LogVRIPSignaling, Verbose,
            TEXT("FetchToken(refresh): already in flight, skipping"));
        return;
    }
    if (bIsRefresh)
    {
        bRefreshInFlight = true;
    }

    TSharedPtr<FJsonObject> Body = MakeShared<FJsonObject>();
    Body->SetStringField(TEXT("code"), PairingCode);
    Body->SetStringField(TEXT("role"), TEXT("publisher"));
    Body->SetNumberField(TEXT("uid"),  AgoraUid);

    FString BodyString;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&BodyString);
    FJsonSerializer::Serialize(Body.ToSharedRef(), Writer);

    const FString Url = ServerUrl + TEXT("/api/token");

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Req = FHttpModule::Get().CreateRequest();
    Req->SetVerb(TEXT("POST"));
    Req->SetURL(Url);
    Req->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    Req->SetContentAsString(BodyString);

    TWeakObjectPtr<USignalingSubsystem> WeakThis(this);
    const bool bWasRefresh = bIsRefresh;

    Req->OnProcessRequestComplete().BindLambda(
        [WeakThis, bWasRefresh](FHttpRequestPtr Request, FHttpResponsePtr Response, bool bSuccess)
        {
            USignalingSubsystem* Self = WeakThis.Get();
            if (!Self)
            {
                return;
            }
            Self->bRefreshInFlight = false;

            if (!bSuccess || !Response.IsValid())
            {
                UE_LOG(LogVRIPSignaling, Error,
                    TEXT("/api/token request failed (no response)"));
                return;
            }
            const int32 Code = Response->GetResponseCode();
            const FString Body = Response->GetContentAsString();
            if (Code != 200)
            {
                UE_LOG(LogVRIPSignaling, Error,
                    TEXT("/api/token %d: %s"), Code, *Body);
                return;
            }

            TSharedPtr<FJsonObject> Json;
            const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Body);
            if (!FJsonSerializer::Deserialize(Reader, Json) || !Json.IsValid())
            {
                UE_LOG(LogVRIPSignaling, Error,
                    TEXT("/api/token: response not JSON: %s"), *Body);
                return;
            }

            Self->AgoraAppId   = Json->GetStringField(TEXT("appId"));
            Self->AgoraToken   = Json->GetStringField(TEXT("token"));
            Self->AgoraChannel = Json->GetStringField(TEXT("channel"));
            const int32 ServerUid = Json->HasTypedField<EJson::Number>(TEXT("uid"))
                ? static_cast<int32>(Json->GetNumberField(TEXT("uid"))) : 0;
            Self->AgoraUid = ServerUid;
            const double ExpiresAt = Json->HasTypedField<EJson::Number>(TEXT("expiresAt"))
                ? Json->GetNumberField(TEXT("expiresAt")) : 0.0;

            UE_LOG(LogVRIPSignaling, Log,
                TEXT("/api/token 200: channel=%s uid=%d expiresAt=%.0f (refresh=%d)"),
                *Self->AgoraChannel, Self->AgoraUid, ExpiresAt, bWasRefresh ? 1 : 0);

            Self->ScheduleTokenRefresh(ExpiresAt);

            Self->SetState(ESignalingState::Live);

            if (bWasRefresh)
            {
                Self->OnTokenRefreshed.Broadcast();
            }
            else
            {
                Self->OnCredentialsReady.Broadcast();
            }
        });

    UE_LOG(LogVRIPSignaling, Log,
        TEXT("POST %s body=%s (refresh=%d)"), *Url, *BodyString, bIsRefresh ? 1 : 0);
    Req->ProcessRequest();
}

// --- Public RefreshToken (BP-callable) --------------------------------------

void USignalingSubsystem::RefreshToken()
{
    FetchToken(/*bIsRefresh*/ true);
}

// --- Token refresh safety net -----------------------------------------------

void USignalingSubsystem::ScheduleTokenRefresh(double ExpiresAtUnixSeconds)
{
    LastExpiresAtUnixSeconds = ExpiresAtUnixSeconds;

    UWorld* World = GetWorld();
    if (!World)
    {
        return;
    }
    World->GetTimerManager().ClearTimer(TokenRefreshTimer);

    const double NowUnix = FDateTime::UtcNow().ToUnixTimestamp();
    const double SecondsUntilRefresh = ExpiresAtUnixSeconds - kTokenRefreshLeadSeconds - NowUnix;

    // Guardrails: never refresh sooner than 30 s from now (avoids tight loops
    // if the server returns a misconfigured TTL), never later than 1 hour
    // (clamp accidental long TTLs to a sane interval).
    const float Delay = static_cast<float>(FMath::Clamp(SecondsUntilRefresh, 30.0, 3600.0));

    UE_LOG(LogVRIPSignaling, Log,
        TEXT("Scheduled token refresh in %.0fs (expiresAt=%.0f, lead=%.0fs)"),
        Delay, ExpiresAtUnixSeconds, kTokenRefreshLeadSeconds);

    TWeakObjectPtr<USignalingSubsystem> WeakThis(this);
    World->GetTimerManager().SetTimer(TokenRefreshTimer,
        FTimerDelegate::CreateLambda([WeakThis]()
        {
            if (USignalingSubsystem* Self = WeakThis.Get())
            {
                Self->FetchToken(/*bIsRefresh*/ true);
            }
        }),
        Delay, /*bLoop*/ false);
}

// --- headset:command inbound -------------------------------------------------

void USignalingSubsystem::HandleHeadsetCommandEvent(FString EventName, USIOJsonValue* EventData)
{
    if (!EventData)
    {
        UE_LOG(LogVRIPSignaling, Warning, TEXT("headset:command with null EventData"));
        return;
    }
    USIOJsonObject* AsObject = EventData->AsObject();
    if (!AsObject)
    {
        UE_LOG(LogVRIPSignaling, Warning, TEXT("headset:command not an object"));
        return;
    }
    TSharedPtr<FJsonObject> Obj = AsObject->GetRootObject();
    if (!Obj.IsValid())
    {
        return;
    }

    FSignalingCommand Cmd;
    if (!Obj->TryGetStringField(TEXT("command"), Cmd.Command))
    {
        UE_LOG(LogVRIPSignaling, Warning, TEXT("headset:command missing 'command' field"));
        return;
    }

    // Cherry-pick only the schema-relevant fields per docs/commands.md.
    // Unknown commands still flow through — BP is the canonical place to
    // ignore unknowns per .cursorrules §5.2.
    if (Cmd.Command == TEXT("pause_simulation"))
    {
        Obj->TryGetBoolField(TEXT("value"), Cmd.BoolValue);
    }
    else if (Cmd.Command == TEXT("change_environment"))
    {
        Obj->TryGetStringField(TEXT("map_name"), Cmd.StringValue);
    }
    else if (Cmd.Command == TEXT("trigger_event"))
    {
        Obj->TryGetStringField(TEXT("event_type"), Cmd.StringValue);
    }

    UE_LOG(LogVRIPSignaling, Log,
        TEXT("headset:command %s bool=%d str=\"%s\""),
        *Cmd.Command, Cmd.BoolValue ? 1 : 0, *Cmd.StringValue);

    OnHeadsetCommand.Broadcast(Cmd);
}

// --- headset:end (graceful shutdown) ----------------------------------------

void USignalingSubsystem::EmitHeadsetEnd()
{
    if (!Socket || State == ESignalingState::Disconnected)
    {
        return;
    }
    TSharedPtr<FJsonObject> Payload = MakeShared<FJsonObject>();
    Payload->SetStringField(TEXT("code"), PairingCode);

    // Fire-and-forget — we're shutting down, don't wait for ack.
    Socket->EmitNative(TEXT("headset:end"), Payload, nullptr);
    UE_LOG(LogVRIPSignaling, Log, TEXT("Emitted headset:end for code=%s"), *PairingCode);
}

// --- State helper ------------------------------------------------------------

void USignalingSubsystem::SetState(ESignalingState NewState)
{
    if (State == NewState)
    {
        return;
    }
    State = NewState;
    UE_LOG(LogVRIPSignaling, Log, TEXT("state -> %s"),
        *UEnum::GetValueAsString(NewState));
    OnStateChanged.Broadcast(NewState);
}
