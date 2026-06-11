// UHeadsetPresenceMonitor — Phase 1 Agora cost-exposure mitigation.
// See Devlog.md 2026-06-08 (audit) entry + 2026-06-11 entry for the full
// rationale. TL;DR: Quest's proximity sleep stops the renderer but the
// app + Agora SDK keep publishing — one forgotten overnight headset is
// ≈ $0.72, a forgotten classroom over a weekend is ≈ $58. This component
// is the per-headset half of the fix; the dashboard half is the
// visibilitychange handler in Web_Dashboard/public/js/grid.js.
//
// Worn-state API note: in UE 5.5 GetHMDWornState() is declared on
// IHeadMountedDisplay (the vendor-specific HMD interface), not on
// IXRTrackingSystem (the parent abstraction). We route through
// GEngine->XRSystem->GetHMDDevice()->GetHMDWornState() at poll time.
// See HeadsetPresenceMonitor.cpp::Poll for the resolution.

#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "HeadsetPresenceMonitor.generated.h"

DECLARE_DYNAMIC_MULTICAST_DELEGATE(FOnHeadsetIdleStarted);
DECLARE_DYNAMIC_MULTICAST_DELEGATE(FOnHeadsetIdleEnded);

/**
 * Polls IXRTrackingSystem::GetHMDWornState() on a timer and fires BP
 * events when the headset crosses the "left on the desk" idle threshold.
 *
 * Intended to live on BP_VRPawn alongside UAgoraVideoPump. The BP graph
 * wires the events to the existing Agora LeaveChannel / JoinChannel paths
 * + the USignalingSubsystem helpers below; this component does NOT
 * directly touch the Agora SDK or signaling layer — same architectural
 * boundary as UAgoraVideoPump (C++ owns things BP can't reach; BP owns
 * the engine lifecycle).
 *
 * BP wiring on VRPawn (verbatim from Devlog 2026-06-11 entry):
 *   1. Add this component to VRPawn.
 *   2. OnHeadsetIdleStarted →
 *        a. SignalingSubsystem → EmitHeadsetEnd  (server prunes the room)
 *        b. Agora → Leave Channel                 (stops publishing, kills the bill)
 *        c. UAgoraVideoPump → Stop Video Pump     (drains the readback)
 *   3. OnHeadsetIdleEnded →
 *        a. SignalingSubsystem → RequestSessionResume
 *           (re-register + fresh token → fires OnAgoraChannelChanged →
 *            existing channel-swap BP graph handles the re-join + pump
 *            restart with no new wiring needed)
 *
 * Polling cadence (default 30 s) is a battery-friendly compromise: UE's
 * HMD-worn-state event is push-based on Quest (via OVRPlugin) but not
 * uniformly available across vendors, so we poll instead. At 30 s
 * intervals the worst-case Agora-minute waste before idle-detection
 * fires is `IdleThresholdSeconds + PollIntervalSeconds` = 150 s by
 * default. Tweak IdleThresholdSeconds down to be more aggressive on
 * tighter-budget deployments; never set PollIntervalSeconds below ~5 s
 * (the OS-level worn-state sensors don't update faster than that).
 *
 * Pico note: PICOXR's worn-state reporting through the generic OpenXR
 * + IXRTrackingSystem path is less reliable than Quest's (often returns
 * Unknown when the headset is off). bTreatUnknownAsWorn = true is the
 * conservative default — "better to keep publishing into an empty
 * channel than to cut off an active session because of a vendor sensor
 * quirk." On a deployment where Pico is dominant and false-negatives
 * are common, prefer flipping to false + raising IdleThresholdSeconds
 * to ~300 s so a single false-positive Unknown doesn't trip idle on
 * its own.
 */
UCLASS(ClassGroup = (VR), meta = (BlueprintSpawnableComponent),
       HideCategories = (Activation, Collision, ComponentTick, Cooking, LOD, Physics, Sockets, Tags, Variable))
class VR_PROJECT_API UHeadsetPresenceMonitor : public UActorComponent
{
    GENERATED_BODY()

public:
    UHeadsetPresenceMonitor();

    /** How often to sample GetHMDWornState() (seconds). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "VR|Presence",
              meta = (ClampMin = "5.0", ClampMax = "300.0"))
    float PollIntervalSeconds = 30.0f;

    /**
     * Consecutive NotWorn duration before OnHeadsetIdleStarted fires.
     * Default 120 s (2 minutes) per the Devlog 2026-06-08 audit spec.
     * Setting below ~60 s gets noisy with the proximity sensor's
     * occasional sub-second false-negatives during normal wear.
     */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "VR|Presence",
              meta = (ClampMin = "10.0", ClampMax = "1800.0"))
    float IdleThresholdSeconds = 120.0f;

    /**
     * What to do with EHMDWornState::Unknown.
     * true  — treat as "worn" (conservative: never falsely idle).
     * false — treat as "not worn" (aggressive: catches Pico's "Unknown
     *         when off" case but risks idling during normal use if the
     *         vendor sensor is flaky).
     * Default true; see Pico note in the class comment.
     */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "VR|Presence")
    bool bTreatUnknownAsWorn = true;

    /** True iff IdleThresholdSeconds has elapsed since the last Worn sample. */
    UPROPERTY(BlueprintReadOnly, Category = "VR|Presence")
    bool bIsIdle = false;

    /**
     * Fires once when the headset has been NotWorn for IdleThresholdSeconds.
     * BP should call SignalingSubsystem::EmitHeadsetEnd + Agora LeaveChannel
     * + UAgoraVideoPump::StopVideoPump in response.
     */
    UPROPERTY(BlueprintAssignable, Category = "VR|Presence")
    FOnHeadsetIdleStarted OnHeadsetIdleStarted;

    /**
     * Fires once when the headset returns to Worn after having been idle.
     * BP should call SignalingSubsystem::RequestSessionResume in response;
     * the existing OnAgoraChannelChanged BP graph handles the rejoin.
     */
    UPROPERTY(BlueprintAssignable, Category = "VR|Presence")
    FOnHeadsetIdleEnded OnHeadsetIdleEnded;

protected:
    virtual void BeginPlay() override;
    virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;

private:
    void Poll();

    FTimerHandle PollTimer;

    /**
     * Seconds of NotWorn observed since the last Worn sample. Reset to 0
     * whenever a Worn sample arrives; once it crosses IdleThresholdSeconds
     * we fire OnHeadsetIdleStarted and keep accumulating (harmless — the
     * Idle event won't re-fire until the state has resolved through Worn
     * and back to NotWorn again).
     */
    float NotWornAccumulator = 0.0f;
};
