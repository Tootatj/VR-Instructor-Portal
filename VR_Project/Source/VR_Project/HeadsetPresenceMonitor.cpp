#include "HeadsetPresenceMonitor.h"

#include "Engine/Engine.h"
#include "Engine/World.h"
#include "TimerManager.h"
#include "IXRTrackingSystem.h"
#include "IHeadMountedDisplay.h"
#include "Misc/CoreDelegates.h"

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

    // PRIMARY path: bind to UE's app-lifecycle delegates. On Quest these
    // fire on take-off (Deactivate) and put-back-on (Reactivate) BEFORE
    // the OS suspends the game thread — the only way to reliably emit
    // headset:end + LeaveChannel on Quest because FTimerManager stops
    // ticking shortly after take-off (diagnosed 2026-06-11 — Devlog
    // entry "Agora cost-exposure Phase 1 — fix").
    //
    // The delegates also fire on system overlays (Quest universal menu,
    // Guardian setup, etc.). We treat those the same as take-off — pause
    // publishing for the overlay's duration, auto-resume on close. This
    // is slightly more aggressive than strictly necessary but pushes the
    // cost arrow in the right direction (saves minutes during overlays)
    // and the UX impact is small (~1 s tile flicker in the dashboard on
    // brief overlays).
    DeactivateDelegateHandle = FCoreDelegates::ApplicationWillDeactivateDelegate.AddUObject(
        this, &UHeadsetPresenceMonitor::HandleApplicationWillDeactivate);
    ReactivateDelegateHandle = FCoreDelegates::ApplicationHasReactivatedDelegate.AddUObject(
        this, &UHeadsetPresenceMonitor::HandleApplicationHasReactivated);

    // FALLBACK path: pull-based worn-state polling on a timer. Useful for
    // desktop dev (PIE / non-VR Editor) where the deactivate delegates
    // don't fire on simple alt-tab, and as a defensive backstop on any
    // vendor whose OS doesn't fire the lifecycle delegates reliably.
    UWorld* World = GetWorld();
    if (!World)
    {
        UE_LOG(LogVRIPPresence, Warning,
            TEXT("BeginPlay: no UWorld — polling path disabled (delegates still bound)."));
        return;
    }

    World->GetTimerManager().SetTimer(
        PollTimer, this, &UHeadsetPresenceMonitor::Poll,
        PollIntervalSeconds, /*bLoop*/ true);

    UE_LOG(LogVRIPPresence, Log,
        TEXT("BeginPlay: poll=%.0fs idle-threshold=%.0fs unknown-as-worn=%d (delegates: deactivate+reactivate bound)"),
        PollIntervalSeconds, IdleThresholdSeconds, bTreatUnknownAsWorn ? 1 : 0);
}

void UHeadsetPresenceMonitor::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
    // Unbind via stored handles so we don't leave dangling subscriptions
    // on the global FCoreDelegates when this pawn tears down (e.g.,
    // travel to a different level or PIE stop). Handle::Reset for
    // self-zero is implicit on the Remove call.
    if (DeactivateDelegateHandle.IsValid())
    {
        FCoreDelegates::ApplicationWillDeactivateDelegate.Remove(DeactivateDelegateHandle);
        DeactivateDelegateHandle.Reset();
    }
    if (ReactivateDelegateHandle.IsValid())
    {
        FCoreDelegates::ApplicationHasReactivatedDelegate.Remove(ReactivateDelegateHandle);
        ReactivateDelegateHandle.Reset();
    }

    if (UWorld* World = GetWorld())
    {
        World->GetTimerManager().ClearTimer(PollTimer);
    }
    Super::EndPlay(EndPlayReason);
}

// --- Shared idle-edge helpers (single source of truth for bIsIdle) ---

void UHeadsetPresenceMonitor::EnterIdle(const TCHAR* Reason)
{
    if (bIsIdle)
    {
        return;
    }
    bIsIdle = true;
    UE_LOG(LogVRIPPresence, Log,
        TEXT("EnterIdle (%s) — firing OnHeadsetIdleStarted"), Reason);
    OnHeadsetIdleStarted.Broadcast();
}

void UHeadsetPresenceMonitor::ExitIdle(const TCHAR* Reason)
{
    if (!bIsIdle)
    {
        return;
    }
    bIsIdle = false;
    NotWornAccumulator = 0.0f;
    UE_LOG(LogVRIPPresence, Log,
        TEXT("ExitIdle (%s) — firing OnHeadsetIdleEnded"), Reason);
    OnHeadsetIdleEnded.Broadcast();
}

// --- Lifecycle delegate handlers (PRIMARY path) ----------------------

void UHeadsetPresenceMonitor::HandleApplicationWillDeactivate()
{
    // CRITICAL: this is our one synchronous opportunity to do work
    // before the OS suspends the game thread on Quest. Anything that
    // would queue work onto a future tick (FTimerManager, async
    // tasks, etc.) will NOT run. The BP-facing delegate broadcast
    // chain is synchronous, so the BP graph's EmitHeadsetEnd /
    // LeaveChannel / StopVideoPump nodes all execute before this
    // function returns. That's exactly what we need.
    EnterIdle(TEXT("ApplicationWillDeactivate"));
}

void UHeadsetPresenceMonitor::HandleApplicationHasReactivated()
{
    ExitIdle(TEXT("ApplicationHasReactivated"));
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
        // No HMD device — desktop / headless / AR-only. Bail to "worn"
        // semantics so the BP graph never sees a false idle.
        ExitIdle(TEXT("Poll: no HMD device"));
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
        ExitIdle(TEXT("Poll: Worn after idle"));
        return;
    }

    NotWornAccumulator += PollIntervalSeconds;
    UE_LOG(LogVRIPPresence, Verbose,
        TEXT("Poll: NotWorn accumulator=%.0fs / threshold=%.0fs (idle=%d)"),
        NotWornAccumulator, IdleThresholdSeconds, bIsIdle ? 1 : 0);

    if (NotWornAccumulator >= IdleThresholdSeconds)
    {
        EnterIdle(*FString::Printf(TEXT("Poll: NotWorn for %.0fs"), NotWornAccumulator));
    }
}
