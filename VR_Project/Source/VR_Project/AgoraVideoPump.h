// VR Instructor Portal — Phase 3 video pump.
// See Devlog.md (2026-06-01 entries) for design rationale.

#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "AgoraVideoPump.generated.h"

class UTextureRenderTarget2D;
class FRHIGPUTextureReadback;

/**
 * Pumps frames from a UTextureRenderTarget2D into Agora's external video
 * source pipeline (`agora::media::IMediaEngine::pushVideoFrame`).
 *
 * Required because the Agora UE plugin v4.5.1 does NOT expose pushVideoFrame
 * or setExternalVideoSource on its Blueprint surface — only video frame
 * receive observers. Custom video source push is C++ only.
 *
 * Usage (Blueprint):
 *   1. Add this component to an actor (e.g., VRPawn).
 *   2. Set SourceRT to the RenderTarget the SceneCaptureComponent2D writes
 *      (RT_InstructorStream, 1280x720 RTF_RGBA8 per .cursorrules §1.3).
 *   3. Add an `Enable Video` BP node to BeginPlay before `Join Channel`.
 *   4. After `Join Channel` (or on `OnJoinChannelSuccess`), call StartVideoPump.
 *   5. StopVideoPump runs automatically on EndPlay; the user can also call
 *      it explicitly before `Release` if finer control is needed.
 *
 * Threading: PumpFrame is the only periodic work and runs on the game thread,
 * but does NO CPU readback or RHI work itself — it only enqueues a render-
 * thread `FRHIGPUTextureReadback::EnqueueCopy` and harvests last tick's
 * already-completed readback via Lock/Unlock (cheap memory map). The actual
 * GPU→CPU copy and pushVideoFrame happen on the render thread asynchronously.
 * Trade-off: ~1 pump tick of latency (~33 ms) for zero game-thread stall.
 * The previous synchronous ReadPixels path stalled the game thread ~2-3 ms
 * per tick because it internally calls FlushRenderingCommands.
 */
UCLASS(ClassGroup = (Agora), meta = (BlueprintSpawnableComponent),
       HideCategories = (Activation, Collision, ComponentTick, Cooking, LOD, Physics, Sockets, Tags, Variable))
class VR_PROJECT_API UAgoraVideoPump : public UActorComponent
{
    GENERATED_BODY()

public:
    UAgoraVideoPump();

    // Out-of-line dtor so TUniquePtr<FRHIGPUTextureReadback> (forward-declared
    // above) only needs the full type at the .cpp definition site, not in
    // every translation unit that includes this header.
    virtual ~UAgoraVideoPump() override;

    /** Source RT to read each pump tick. Must be 1280x720 RTF_RGBA8. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Agora|VideoPump")
    TObjectPtr<UTextureRenderTarget2D> SourceRT = nullptr;

    /**
     * Pump period in seconds. Default 1/30 s = 33.33 ms (= 30 fps), matching
     * the §1.3 hard-locked streaming spec. Do not lower below the SceneCapture
     * cadence (also 30 Hz) or successive pushed frames will be identical.
     */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Agora|VideoPump",
              meta = (ClampMin = "0.01", ClampMax = "1.0"))
    float PumpIntervalSeconds = 0.0333f;

    /** Begin pushing frames. Safe to call multiple times (subsequent calls no-op). */
    UFUNCTION(BlueprintCallable, Category = "Agora|VideoPump")
    void StartVideoPump();

    /** Stop pushing frames and disable the external video source. Idempotent. */
    UFUNCTION(BlueprintCallable, Category = "Agora|VideoPump")
    void StopVideoPump();

    /**
     * Tear down + re-establish the external-video-source binding and the
     * pump timer. Required after Agora's local video track lifecycle is
     * reset — which happens whenever the BP graph does LeaveChannel +
     * JoinChannel (e.g. mid-session tenant swap driven by
     * USignalingSubsystem::OnAgoraChannelChanged).
     *
     * Why a wrapper instead of asking BP to call Stop+Start back-to-back:
     *   - Single semantically clear BP node ("the channel changed,
     *     restart the pump") that's hard to misuse.
     *   - Internally calls StopVideoPump (drains in-flight readback +
     *     calls setExternalVideoSource(false)) then StartVideoPump
     *     (re-fetches IMediaEngine, re-calls setExternalVideoSource(true),
     *     re-arms the 30 Hz timer). The setExternalVideoSource(false→true)
     *     toggle is what actually re-binds the external source to the
     *     newly-created local video track of the new channel; calling only
     *     StartVideoPump when already running is a no-op and would NOT fix
     *     the binding.
     *
     * Idempotent and safe to call from any BP point; just runs Stop+Start
     * even if the pump wasn't running (Start handles missing SourceRT etc.
     * with a logged error and an early return).
     */
    UFUNCTION(BlueprintCallable, Category = "Agora|VideoPump")
    void RestartForNewChannel();

protected:
    virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;

private:
    /** Game-thread timer callback: harvests last tick's readback and enqueues a new one. */
    void PumpFrame();

    /** Game-thread timer driving PumpFrame. */
    FTimerHandle PumpTimer;

    /**
     * Async GPU→CPU readback. Single-buffered: at 30 Hz pump rate and ~1-2 ms
     * GPU readback cost, IsReady() will essentially always be true on the
     * next tick. The bReadbackInFlight guard handles the rare "not ready
     * yet" case by skipping that tick (no frame overwrite while in flight).
     */
    TUniquePtr<FRHIGPUTextureReadback> Readback;

    /** True iff EnqueueCopy has been issued and IsReady has not yet returned true. */
    bool bReadbackInFlight = false;

    /**
     * Wall-clock timestamp captured at EnqueueCopy time. Used as the
     * ExternalVideoFrame.timestamp at push time so the receiver sees the
     * "frame happened then" timestamp, not "we got around to pushing it now".
     */
    int64 PendingFrameTimestampMs = 0;

    /**
     * Cached IMediaEngine pointer, fetched once in StartVideoPump and reused
     * for every push. Owned by the Agora plugin's singleton (AutoPtr field on
     * AgoraUERtcEngine); valid for the engine's lifetime.
     *
     * `void*` here so this header has no transitive Agora SDK include
     * dependency — the .cpp resolves it via reinterpret_cast.
     */
    void* CachedMediaEngine = nullptr;

    /** True iff setExternalVideoSource(true,...) has been called and not yet undone. */
    bool bExternalSourceEnabled = false;
};
