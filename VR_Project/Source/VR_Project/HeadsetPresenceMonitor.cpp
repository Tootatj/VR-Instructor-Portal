#include "HeadsetPresenceMonitor.h"

#include "Engine/Engine.h"
#include "Engine/World.h"
#include "TimerManager.h"
#include "IXRTrackingSystem.h"
#include "IHeadMountedDisplay.h"

DEFINE_LOG_CATEGORY_STATIC(LogVRIPPresence, Log, All);

UHeadsetPresenceMonitor::UHeadsetPresenceMonitor()
{
    // No game-thread tick needed — we drive everything off a low-frequency
    // FTimerManager timer (default 1/30 Hz). Tick was overkill and would
    // show up in the per-frame component pass even when idle.
    PrimaryComponentTick.bCanEverTick = false;
}

void UHeadsetPresenceMonitor::BeginPlay()
{
    Super::BeginPlay();

    UWorld* World = GetWorld();
    if (!World)
    {
        UE_LOG(LogVRIPPresence, Warning,
            TEXT("BeginPlay: no UWorld — presence monitoring disabled."));
        return;
    }

    World->GetTimerManager().SetTimer(
        PollTimer, this, &UHeadsetPresenceMonitor::Poll,
        PollIntervalSeconds, /*bLoop*/ true);

    UE_LOG(LogVRIPPresence, Log,
        TEXT("BeginPlay: poll=%.0fs idle-threshold=%.0fs unknown-as-worn=%d"),
        PollIntervalSeconds, IdleThresholdSeconds, bTreatUnknownAsWorn ? 1 : 0);
}

void UHeadsetPresenceMonitor::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
    if (UWorld* World = GetWorld())
    {
        World->GetTimerManager().ClearTimer(PollTimer);
    }
    Super::EndPlay(EndPlayReason);
}

void UHeadsetPresenceMonitor::Poll()
{
    // No XR system at all (e.g. non-VR PIE, dedicated server, headless
    // CI) means we cannot meaningfully say whether the headset is on a
    // user's head. Treat as worn — the cost path doesn't apply in those
    // contexts (no real headset is publishing), and false-idling would
    // break iteration on the BP graph during desktop dev.
    //
    // GetHMDWornState() lives on IHeadMountedDisplay (the vendor-specific
    // HMD device interface), not on IXRTrackingSystem. The tracking system
    // is the parent abstraction; we route through it to reach the device.
    // GetHMDDevice() returns null for non-HMD XR systems (e.g. AR-only) —
    // treat that the same as "no XR system" for the same reason.
    IHeadMountedDisplay* HMD = (GEngine && GEngine->XRSystem.IsValid())
        ? GEngine->XRSystem->GetHMDDevice()
        : nullptr;
    if (!HMD)
    {
        if (bIsIdle)
        {
            bIsIdle = false;
            NotWornAccumulator = 0.0f;
            OnHeadsetIdleEnded.Broadcast();
        }
        return;
    }

    const EHMDWornState::Type WornState = HMD->GetHMDWornState();

    bool bWorn;
    switch (WornState)
    {
    case EHMDWornState::Worn:
        bWorn = true;
        break;
    case EHMDWornState::NotWorn:
        bWorn = false;
        break;
    case EHMDWornState::Unknown:
    default:
        bWorn = bTreatUnknownAsWorn;
        break;
    }

    if (bWorn)
    {
        NotWornAccumulator = 0.0f;
        if (bIsIdle)
        {
            bIsIdle = false;
            UE_LOG(LogVRIPPresence, Log,
                TEXT("Poll: Worn after idle — firing OnHeadsetIdleEnded"));
            OnHeadsetIdleEnded.Broadcast();
        }
        return;
    }

    NotWornAccumulator += PollIntervalSeconds;
    UE_LOG(LogVRIPPresence, Verbose,
        TEXT("Poll: NotWorn accumulator=%.0fs / threshold=%.0fs (idle=%d)"),
        NotWornAccumulator, IdleThresholdSeconds, bIsIdle ? 1 : 0);

    if (!bIsIdle && NotWornAccumulator >= IdleThresholdSeconds)
    {
        bIsIdle = true;
        UE_LOG(LogVRIPPresence, Log,
            TEXT("Poll: NotWorn for %.0fs (>= %.0fs threshold) — firing OnHeadsetIdleStarted"),
            NotWornAccumulator, IdleThresholdSeconds);
        OnHeadsetIdleStarted.Broadcast();
    }
}
