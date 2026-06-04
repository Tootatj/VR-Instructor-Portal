// UTenantRegistry
//
// UGameInstanceSubsystem that owns the headset's tenant identity ("which
// customer's app installation is this device?"). Persists across cold
// launches so the user only types their company code once at first
// install.
//
// Wire protocol (Devlog 2026-06-04 Phase 6 A/B/C entry):
//
//   1. On Initialize: try to load Saved/Config/OneBonsaiRegistration.json.
//      If present + valid → mark registered, fire OnRegistrationChanged,
//      and we're done.
//   2. If absent: stay unregistered. UI (typically a UMG modal gate on
//      first launch — `WBP_RegistrationGate` is the reference one we
//      ship, but ANY UI can drive this) calls RedeemCode(TypedCode,
//      Callback).
//   3. RedeemCode → POST <ServerUrl>/api/tenant/resolve { code }.
//      200 returns { tenantId, displayName }. We persist a normalised
//      JSON blob to disk, fire OnRegistrationChanged, and invoke the
//      callback with bSuccess=true. 401/network-failure → callback with
//      bSuccess=false + a human-readable error.
//
// Portability: this subsystem is the *only* integration seam for porting
// to another UE project. Host apps that already have a code-input panel
// in VR (e.g. apps wired into OneBonsai's existing company-management
// system) just wire their existing Submit button to RedeemCode and bind
// OnRegistrationChanged to hide the panel on success. No UMG dependency
// in this subsystem on purpose. See HowToPort.md "BYO code-input UI".
//
// Note on ordering with USignalingSubsystem: signaling reads the
// resolved tenantId via ResolveTenantIdForSignaling() on this subsystem,
// so signaling's boot is deferred until either (a) registration is
// already on disk or (b) the OnRegistrationChanged delegate fires after
// a successful RedeemCode. The bAllowUnregisteredBoot INI flag exists
// purely so the existing dev / CI flow (which hardcodes
// TenantId=onebonsai) keeps working until a proper registration UI is
// wired in the editor.

#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "TenantRegistry.generated.h"

// BP-binding delegate handed to RedeemCode. Fires exactly once per call,
// on the game thread. On bSuccess=false, ErrorMessage is user-displayable
// (e.g. "That code wasn't recognised", "Server unreachable").
DECLARE_DYNAMIC_DELEGATE_TwoParams(FOnRedeemCodeComplete,
    bool, bSuccess,
    const FString&, ErrorMessage);

// Fires whenever the persisted registration changes — after a successful
// RedeemCode (transition to registered) or after ClearRegistration
// (transition back to unregistered). Use to refresh UI + trigger
// downstream subsystems (USignalingSubsystem listens to this to defer
// its socket boot until registration is in place).
DECLARE_DYNAMIC_MULTICAST_DELEGATE(FOnRegistrationChanged);

UCLASS()
class VR_PROJECT_API UTenantRegistry : public UGameInstanceSubsystem
{
    GENERATED_BODY()

public:
    virtual void Initialize(FSubsystemCollectionBase& Collection) override;
    virtual void Deinitialize() override;

    // --- BP-readable runtime state ---

    // True once a valid registration JSON has been loaded from disk OR a
    // RedeemCode call has succeeded. False after ClearRegistration.
    UFUNCTION(BlueprintPure, Category = "OneBonsai|Registration")
    bool IsRegistered() const { return bIsRegistered; }

    UFUNCTION(BlueprintPure, Category = "OneBonsai|Registration")
    FString GetTenantId() const { return TenantId; }

    UFUNCTION(BlueprintPure, Category = "OneBonsai|Registration")
    FString GetDisplayName() const { return DisplayName; }

    // The raw code the user typed (e.g. "5555555555"). Surfaced so a
    // "Switch organisation" screen can show the user what code they're
    // currently registered with before they wipe + re-register.
    UFUNCTION(BlueprintPure, Category = "OneBonsai|Registration")
    FString GetRegistrationCode() const { return RegistrationCode; }

    // --- BP-callable ---

    // Async. Submits Code to the server; on 200 persists the response
    // to disk + fires both OnRegistrationChanged and the per-call
    // Callback (with bSuccess=true). On any failure, only Callback is
    // invoked (with bSuccess=false + a user-displayable error).
    //
    // Safe to call from any BP context (game thread). The HTTP response
    // is marshalled back to the game thread before the callback fires.
    // Calls while a previous RedeemCode is in flight are rejected with
    // a "registration already in progress" error so a user double-tap
    // doesn't double-submit.
    UFUNCTION(BlueprintCallable, Category = "OneBonsai|Registration",
        meta = (AutoCreateRefTerm = "Callback"))
    void RedeemCode(const FString& Code, const FOnRedeemCodeComplete& Callback);

    // Wipes the persisted registration file + clears in-memory state.
    // Fires OnRegistrationChanged. UI gate should re-appear on next BP
    // BeginPlay check. Intended for a "Switch organisation" pause-menu
    // button on shared / demo headsets.
    UFUNCTION(BlueprintCallable, Category = "OneBonsai|Registration")
    void ClearRegistration();

    // --- BP-assignable delegate ---

    UPROPERTY(BlueprintAssignable, Category = "OneBonsai|Registration")
    FOnRegistrationChanged OnRegistrationChanged;

    // --- Used by USignalingSubsystem (not BP-relevant) ---

    // Returns the tenantId signaling should use, with the following
    // precedence: persisted registration > INI fallback > "onebonsai"
    // hard default. Logs which source was used.
    FString ResolveTenantIdForSignaling() const;

private:
    void LoadConfig();
    bool LoadRegistrationFromDisk();
    bool SaveRegistrationToDisk() const;
    void DeleteRegistrationFromDisk() const;

    static FString GetRegistrationFilePath();

    // Persisted state.
    bool bIsRegistered = false;
    FString TenantId;
    FString DisplayName;
    FString RegistrationCode;
    int64 RegisteredAtUnixSeconds = 0;

    // From DefaultGame.ini [/Script/VR_Project.TenantRegistry].
    FString ServerUrl;
    bool bAllowUnregisteredBoot = true;   // dev-friendly default; flip to false for prod-style strict mode

    // Concurrency guard.
    bool bRedeemInFlight = false;
};
