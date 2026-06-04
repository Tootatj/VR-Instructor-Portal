#include "TenantRegistry.h"

#include "Engine/GameInstance.h"
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "Misc/DateTime.h"
#include "HAL/PlatformFileManager.h"
#include "GenericPlatform/GenericPlatformFile.h"

#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

DEFINE_LOG_CATEGORY_STATIC(LogVRIPRegistry, Log, All);

namespace
{
    // Strip trailing slashes so "http://host:3000/" and "http://host:3000"
    // behave identically when concatenating "/api/...". Same helper lives
    // in SignalingSubsystem.cpp — left local here to keep the registry a
    // standalone unit (per HowToPort.md "single integration seam" goal).
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

void UTenantRegistry::Initialize(FSubsystemCollectionBase& Collection)
{
    Super::Initialize(Collection);

    LoadConfig();

    const bool bLoaded = LoadRegistrationFromDisk();
    UE_LOG(LogVRIPRegistry, Log,
        TEXT("Initialize: server=%s allowUnregisteredBoot=%d persisted=%s%s"),
        *ServerUrl,
        bAllowUnregisteredBoot ? 1 : 0,
        bLoaded ? TEXT("yes") : TEXT("no"),
        bLoaded ? *FString::Printf(TEXT(" tenant=%s display=\"%s\""), *TenantId, *DisplayName) : TEXT(""));

    // Intentionally NOT firing OnRegistrationChanged here — Initialize
    // runs before any BP has had a chance to bind. BP gates poll
    // IsRegistered() in BeginPlay instead; downstream subsystems read
    // ResolveTenantIdForSignaling() lazily.
}

void UTenantRegistry::Deinitialize()
{
    Super::Deinitialize();
}

// --- Config ------------------------------------------------------------------

void UTenantRegistry::LoadConfig()
{
    const TCHAR* Section = TEXT("/Script/VR_Project.TenantRegistry");

    if (!GConfig->GetString(Section, TEXT("ServerUrl"), ServerUrl, GGameIni) || ServerUrl.IsEmpty())
    {
        // Fall back to the signaling subsystem's ServerUrl — they always
        // point at the same Web_Dashboard instance and asking the
        // integrator to set the same URL twice is asking for drift.
        if (!GConfig->GetString(TEXT("/Script/VR_Project.SignalingSubsystem"),
                TEXT("ServerUrl"), ServerUrl, GGameIni) || ServerUrl.IsEmpty())
        {
            ServerUrl = TEXT("http://127.0.0.1:3000");
        }
    }
    ServerUrl = NormalizeUrl(ServerUrl);

    if (!GConfig->GetBool(Section, TEXT("bAllowUnregisteredBoot"), bAllowUnregisteredBoot, GGameIni))
    {
        // Default true during dev so the existing onebonsai-only flow
        // keeps working without an immediate BP gate. Flip to false in
        // production INI overlays once WBP_RegistrationGate is wired.
        bAllowUnregisteredBoot = true;
    }
}

// --- Persistence -------------------------------------------------------------

FString UTenantRegistry::GetRegistrationFilePath()
{
    // ProjectSavedDir() survives app updates and is independently
    // wipeable from the platform's "Clear app data" affordance. The
    // single canonical name keeps a future "factory reset" feature
    // trivial — one file delete.
    return FPaths::ProjectSavedDir() / TEXT("Config") / TEXT("OneBonsaiRegistration.json");
}

bool UTenantRegistry::LoadRegistrationFromDisk()
{
    const FString Path = GetRegistrationFilePath();

    FString Raw;
    if (!FFileHelper::LoadFileToString(Raw, *Path))
    {
        return false;
    }

    TSharedPtr<FJsonObject> Json;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
    if (!FJsonSerializer::Deserialize(Reader, Json) || !Json.IsValid())
    {
        UE_LOG(LogVRIPRegistry, Warning,
            TEXT("LoadRegistrationFromDisk: %s exists but is not valid JSON; ignoring"),
            *Path);
        return false;
    }

    FString LoadedTenantId, LoadedDisplayName, LoadedCode;
    if (!Json->TryGetStringField(TEXT("tenantId"), LoadedTenantId) || LoadedTenantId.IsEmpty())
    {
        UE_LOG(LogVRIPRegistry, Warning,
            TEXT("LoadRegistrationFromDisk: %s missing tenantId; ignoring"),
            *Path);
        return false;
    }
    Json->TryGetStringField(TEXT("displayName"), LoadedDisplayName);
    Json->TryGetStringField(TEXT("code"),        LoadedCode);

    int64 LoadedRegisteredAt = 0;
    if (Json->HasTypedField<EJson::Number>(TEXT("registeredAtUnix")))
    {
        LoadedRegisteredAt = static_cast<int64>(Json->GetNumberField(TEXT("registeredAtUnix")));
    }

    TenantId = LoadedTenantId;
    DisplayName = LoadedDisplayName;
    RegistrationCode = LoadedCode;
    RegisteredAtUnixSeconds = LoadedRegisteredAt;
    bIsRegistered = true;
    return true;
}

bool UTenantRegistry::SaveRegistrationToDisk() const
{
    TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
    Json->SetStringField(TEXT("tenantId"),         TenantId);
    Json->SetStringField(TEXT("displayName"),      DisplayName);
    Json->SetStringField(TEXT("code"),             RegistrationCode);
    Json->SetNumberField(TEXT("registeredAtUnix"), static_cast<double>(RegisteredAtUnixSeconds));
    Json->SetStringField(TEXT("schemaVersion"),    TEXT("1"));

    FString Out;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
    if (!FJsonSerializer::Serialize(Json, Writer))
    {
        UE_LOG(LogVRIPRegistry, Error, TEXT("SaveRegistrationToDisk: JSON serialize failed"));
        return false;
    }

    const FString Path = GetRegistrationFilePath();

    // Ensure parent directory exists — fresh installs don't have
    // Saved/Config/ on day 1.
    IPlatformFile& PF = FPlatformFileManager::Get().GetPlatformFile();
    const FString ParentDir = FPaths::GetPath(Path);
    if (!PF.DirectoryExists(*ParentDir))
    {
        PF.CreateDirectoryTree(*ParentDir);
    }

    if (!FFileHelper::SaveStringToFile(Out, *Path))
    {
        UE_LOG(LogVRIPRegistry, Error,
            TEXT("SaveRegistrationToDisk: failed to write %s"), *Path);
        return false;
    }
    UE_LOG(LogVRIPRegistry, Log,
        TEXT("SaveRegistrationToDisk: wrote %s (tenant=%s)"), *Path, *TenantId);
    return true;
}

void UTenantRegistry::DeleteRegistrationFromDisk() const
{
    const FString Path = GetRegistrationFilePath();
    IPlatformFile& PF = FPlatformFileManager::Get().GetPlatformFile();
    if (PF.FileExists(*Path))
    {
        PF.DeleteFile(*Path);
        UE_LOG(LogVRIPRegistry, Log, TEXT("DeleteRegistrationFromDisk: removed %s"), *Path);
    }
}

// --- BP-callable: RedeemCode -------------------------------------------------

void UTenantRegistry::RedeemCode(const FString& Code, const FOnRedeemCodeComplete& Callback)
{
    // Trim — instructor may have pasted the code with surrounding space.
    const FString Trimmed = Code.TrimStartAndEnd();

    if (Trimmed.IsEmpty())
    {
        UE_LOG(LogVRIPRegistry, Warning, TEXT("RedeemCode: empty code"));
        Callback.ExecuteIfBound(false, TEXT("Please enter your company code."));
        return;
    }
    if (bRedeemInFlight)
    {
        UE_LOG(LogVRIPRegistry, Warning, TEXT("RedeemCode: already in flight, rejecting double-submit"));
        Callback.ExecuteIfBound(false, TEXT("Registration already in progress."));
        return;
    }
    bRedeemInFlight = true;

    TSharedPtr<FJsonObject> Body = MakeShared<FJsonObject>();
    Body->SetStringField(TEXT("code"), Trimmed);

    FString BodyString;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&BodyString);
    FJsonSerializer::Serialize(Body.ToSharedRef(), Writer);

    const FString Url = ServerUrl + TEXT("/api/tenant/resolve");

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Req = FHttpModule::Get().CreateRequest();
    Req->SetVerb(TEXT("POST"));
    Req->SetURL(Url);
    Req->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    Req->SetContentAsString(BodyString);

    UE_LOG(LogVRIPRegistry, Log,
        TEXT("RedeemCode: POST %s code=%s"), *Url, *Trimmed);

    TWeakObjectPtr<UTenantRegistry> WeakThis(this);
    const FString CodeCopy = Trimmed;

    // Capture the callback by value — FOnRedeemCodeComplete is a UE
    // dynamic delegate, so it's small / cheap / safe to copy.
    Req->OnProcessRequestComplete().BindLambda(
        [WeakThis, CodeCopy, Callback]
        (FHttpRequestPtr Request, FHttpResponsePtr Response, bool bSuccess)
        {
            UTenantRegistry* Self = WeakThis.Get();
            if (!Self)
            {
                return;
            }
            Self->bRedeemInFlight = false;

            if (!bSuccess || !Response.IsValid())
            {
                UE_LOG(LogVRIPRegistry, Error, TEXT("RedeemCode: no response from server"));
                Callback.ExecuteIfBound(false,
                    TEXT("Couldn't reach the OneBonsai server. Check your network and try again."));
                return;
            }

            const int32 HttpCode = Response->GetResponseCode();
            const FString RespBody = Response->GetContentAsString();

            if (HttpCode == 401)
            {
                UE_LOG(LogVRIPRegistry, Warning,
                    TEXT("RedeemCode: 401 (code not recognised). body=%s"), *RespBody);
                Callback.ExecuteIfBound(false,
                    TEXT("That code wasn't recognised. Check with your OneBonsai contact."));
                return;
            }
            if (HttpCode != 200)
            {
                UE_LOG(LogVRIPRegistry, Error,
                    TEXT("RedeemCode: HTTP %d. body=%s"), HttpCode, *RespBody);
                Callback.ExecuteIfBound(false,
                    FString::Printf(TEXT("Registration failed (server returned %d)."), HttpCode));
                return;
            }

            TSharedPtr<FJsonObject> Json;
            const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(RespBody);
            if (!FJsonSerializer::Deserialize(Reader, Json) || !Json.IsValid())
            {
                UE_LOG(LogVRIPRegistry, Error,
                    TEXT("RedeemCode: response not JSON: %s"), *RespBody);
                Callback.ExecuteIfBound(false, TEXT("Unexpected server response. Try again."));
                return;
            }

            FString RespTenantId, RespDisplayName;
            if (!Json->TryGetStringField(TEXT("tenantId"), RespTenantId) || RespTenantId.IsEmpty())
            {
                UE_LOG(LogVRIPRegistry, Error,
                    TEXT("RedeemCode: response missing tenantId: %s"), *RespBody);
                Callback.ExecuteIfBound(false, TEXT("Unexpected server response. Try again."));
                return;
            }
            Json->TryGetStringField(TEXT("displayName"), RespDisplayName);

            Self->TenantId = RespTenantId;
            Self->DisplayName = RespDisplayName.IsEmpty() ? RespTenantId : RespDisplayName;
            Self->RegistrationCode = CodeCopy;
            Self->RegisteredAtUnixSeconds = FDateTime::UtcNow().ToUnixTimestamp();
            Self->bIsRegistered = true;

            const bool bPersisted = Self->SaveRegistrationToDisk();
            if (!bPersisted)
            {
                // We *could* fail the call here, but the in-memory
                // registration is already good — the user can still use
                // the app this session; only the persistence-across-
                // reboot promise is broken. Surface a warning instead.
                UE_LOG(LogVRIPRegistry, Warning,
                    TEXT("RedeemCode: succeeded but persistence failed — user will need to re-register after reboot"));
            }

            UE_LOG(LogVRIPRegistry, Log,
                TEXT("RedeemCode: registered tenant=%s display=\"%s\" (persisted=%d)"),
                *Self->TenantId, *Self->DisplayName, bPersisted ? 1 : 0);

            Self->OnRegistrationChanged.Broadcast();
            Callback.ExecuteIfBound(true, FString());
        });

    Req->ProcessRequest();
}

void UTenantRegistry::ClearRegistration()
{
    if (!bIsRegistered)
    {
        UE_LOG(LogVRIPRegistry, Log, TEXT("ClearRegistration: already unregistered, noop"));
        return;
    }
    DeleteRegistrationFromDisk();
    TenantId.Reset();
    DisplayName.Reset();
    RegistrationCode.Reset();
    RegisteredAtUnixSeconds = 0;
    bIsRegistered = false;
    UE_LOG(LogVRIPRegistry, Log, TEXT("ClearRegistration: wiped in-memory + disk"));
    OnRegistrationChanged.Broadcast();
}

// --- Signaling integration ---------------------------------------------------

FString UTenantRegistry::ResolveTenantIdForSignaling() const
{
    if (bIsRegistered && !TenantId.IsEmpty())
    {
        return TenantId;
    }
    // Pre-registration fallback: read the dev / CI default from the
    // signaling subsystem's own config section so we don't end up with
    // two different "default tenant" strings.
    FString IniTenantId;
    GConfig->GetString(TEXT("/Script/VR_Project.SignalingSubsystem"),
        TEXT("TenantId"), IniTenantId, GGameIni);
    if (IniTenantId.IsEmpty())
    {
        IniTenantId = TEXT("onebonsai");
    }
    UE_LOG(LogVRIPRegistry, Log,
        TEXT("ResolveTenantIdForSignaling: not registered, falling back to INI tenant=%s"),
        *IniTenantId);
    return IniTenantId;
}
