// VR Instructor Portal — Phase 3 video pump.
// See Devlog.md (2026-06-01 entries) for design rationale.

#include "AgoraVideoPump.h"

#include "Engine/TextureRenderTarget2D.h"
#include "Engine/World.h"
#include "TimerManager.h"
#include "TextureResource.h"
#include "RHIGPUReadback.h"
#include "RenderingThread.h"

// Agora plugin's PublicIncludePaths register Public/AgoraCppPlugin and
// Public/AgoraCppPlugin/include, so these are short includes.
#include "AgoraHeaderBase.h"
#include "AgoraUERTCEngine.h"
#include "IAgoraMediaEngine.h"
#include "AgoraMediaBase.h"

DEFINE_LOG_CATEGORY_STATIC(LogAgoraVideoPump, Log, All);

namespace
{
    // Resolve the IMediaEngine from the plugin's UE singleton.
    // Returns nullptr if the engine hasn't been Initialize()'d yet.
    agora::media::IMediaEngine* ResolveMediaEngine()
    {
        auto* UEEngine = agora::rtc::ue::AgoraUERtcEngine::Get();
        if (!UEEngine)
        {
            return nullptr;
        }

        agora::media::IMediaEngine* MediaEngine = nullptr;
        const int Ret = UEEngine->queryInterface(
            agora::rtc::INTERFACE_ID_TYPE::AGORA_IID_MEDIA_ENGINE,
            reinterpret_cast<void**>(&MediaEngine));

        return (Ret == 0) ? MediaEngine : nullptr;
    }
}

UAgoraVideoPump::UAgoraVideoPump()
{
    // No Tick — we drive ourselves off an FTimerHandle in StartVideoPump.
    PrimaryComponentTick.bCanEverTick = false;
    bAutoActivate = true;
}

UAgoraVideoPump::~UAgoraVideoPump() = default;

void UAgoraVideoPump::StartVideoPump()
{
    if (PumpTimer.IsValid())
    {
        UE_LOG(LogAgoraVideoPump, Verbose, TEXT("StartVideoPump called while already running. No-op."));
        return;
    }

    if (!SourceRT)
    {
        UE_LOG(LogAgoraVideoPump, Error, TEXT("StartVideoPump: SourceRT is null. Aborting."));
        return;
    }

    agora::media::IMediaEngine* MediaEngine = ResolveMediaEngine();
    if (!MediaEngine)
    {
        UE_LOG(LogAgoraVideoPump, Error,
            TEXT("StartVideoPump: could not resolve IMediaEngine. Did the BP call Initialize before this?"));
        return;
    }

    // Tell Agora we'll push raw frames instead of using a camera capture.
    // useTexture=false → CPU buffer path. The third arg defaults to
    // agora::media::VIDEO_FRAME (uncompressed) which is what we want; we
    // omit it so we don't have to qualify the enum (it lives in agora::media,
    // NOT agora::media::base — easy mistake to make given the file name).
    const int SrcRes = MediaEngine->setExternalVideoSource(
        /*enabled*/   true,
        /*useTexture*/ false);

    if (SrcRes != 0)
    {
        UE_LOG(LogAgoraVideoPump, Error,
            TEXT("StartVideoPump: setExternalVideoSource(true) returned %d. Aborting."), SrcRes);
        return;
    }

    CachedMediaEngine = MediaEngine;
    bExternalSourceEnabled = true;

    // Allocate the GPU readback now (not per-tick); reused for every frame.
    Readback = MakeUnique<FRHIGPUTextureReadback>(TEXT("AgoraVideoPumpReadback"));
    bReadbackInFlight = false;
    PendingFrameTimestampMs = 0;

    // Game-thread timer; each tick is at most one ENQUEUE_RENDER_COMMAND
    // call and a cheap Lock/Unlock of an already-completed staging buffer,
    // so the game thread cost per tick is well under 100 µs.
    if (UWorld* World = GetWorld())
    {
        World->GetTimerManager().SetTimer(
            PumpTimer, this, &UAgoraVideoPump::PumpFrame,
            PumpIntervalSeconds, /*bLoop*/ true);
    }

    UE_LOG(LogAgoraVideoPump, Display,
        TEXT("StartVideoPump: pumping %dx%d @ %.1f Hz from %s (format=%d)"),
        SourceRT->SizeX, SourceRT->SizeY, 1.0f / PumpIntervalSeconds,
        *SourceRT->GetPathName(), static_cast<int32>(SourceRT->RenderTargetFormat));

    bLoggedFirstFrameSample = false;
}

void UAgoraVideoPump::StopVideoPump()
{
    // Clear the timer first so no new PumpFrame ticks fire while we're tearing down.
    if (UWorld* World = GetWorld())
    {
        World->GetTimerManager().ClearTimer(PumpTimer);
    }
    PumpTimer.Invalidate();

    // Drain in-flight render-thread work (any pending EnqueueCopy lambda)
    // BEFORE we destroy the readback object. Without this flush the lambda
    // would dereference a freed Readback pointer if it's still queued.
    if (Readback.IsValid())
    {
        FlushRenderingCommands();
        Readback.Reset();
        bReadbackInFlight = false;
    }

    if (bExternalSourceEnabled)
    {
        if (auto* MediaEngine = static_cast<agora::media::IMediaEngine*>(CachedMediaEngine))
        {
            MediaEngine->setExternalVideoSource(false, false);
        }
        bExternalSourceEnabled = false;
    }

    CachedMediaEngine = nullptr;

    UE_LOG(LogAgoraVideoPump, Display, TEXT("StopVideoPump: stopped."));
}

void UAgoraVideoPump::RestartForNewChannel()
{
    UE_LOG(LogAgoraVideoPump, Display,
        TEXT("RestartForNewChannel: cycling pump (wasRunning=%d, externalSourceEnabled=%d)"),
        PumpTimer.IsValid() ? 1 : 0,
        bExternalSourceEnabled ? 1 : 0);

    StopVideoPump();
    StartVideoPump();
}

void UAgoraVideoPump::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
    StopVideoPump();
    Super::EndPlay(EndPlayReason);
}

void UAgoraVideoPump::PumpFrame()
{
    if (!SourceRT || !CachedMediaEngine || !Readback.IsValid())
    {
        return;
    }

    FTextureRenderTargetResource* RTResource = SourceRT->GameThread_GetRenderTargetResource();
    if (!RTResource)
    {
        return;
    }

    const int32 H = SourceRT->SizeY;
    FRHIGPUTextureReadback* ReadbackPtr = Readback.Get();

    // Step 1 — Harvest the previous tick's readback if it's now ready.
    //
    // Why we MUST guard with bReadbackInFlight + IsReady before re-enqueue:
    // FRHIGPUTextureReadback is single-buffered. EnqueueCopy'ing twice
    // before the GPU has finished the first copy silently overwrites the
    // staging buffer, so we'd push half-completed pixels. At 30 Hz on
    // Quest (Adreno 740) the GPU finishes the copy in well under one tick;
    // IsReady() returning false here is rare and harmless (we just skip
    // that tick — receiver sees the frame on the *next* tick instead).
    if (bReadbackInFlight)
    {
        if (!ReadbackPtr->IsReady())
        {
            return;
        }

        int32 RowPitchInPixels = 0;
        int32 BufferHeight = 0;
        void* Data = ReadbackPtr->Lock(RowPitchInPixels, &BufferHeight);
        if (Data)
        {
            // UE's FColor stores bytes as B,G,R,A in memory on both Windows DX
            // and Vulkan B8G8R8A8 (the default for our mobile-forward Quest path),
            // so VIDEO_PIXEL_BGRA matches the buffer without any byte swap. If
            // colors look wrong on Quest, swap to VIDEO_PIXEL_RGBA — empirical only.
            //
            // RowPitchInPixels (NOT SourceRT->SizeX) goes into Frame.stride:
            // the GPU may pad rows for alignment (e.g., 1280 → 1408 on some RHIs).
            // Agora's stride field is documented in pixels; passing the actual
            // pitch lets Agora skip the padding bytes per row correctly.
            agora::media::base::ExternalVideoFrame Frame;
            Frame.type      = agora::media::base::ExternalVideoFrame::VIDEO_BUFFER_RAW_DATA;
            Frame.format    = agora::media::base::VIDEO_PIXEL_BGRA;
            Frame.buffer    = Data;
            Frame.stride    = RowPitchInPixels;
            Frame.height    = H;
            Frame.timestamp = PendingFrameTimestampMs;

            if (!bLoggedFirstFrameSample)
            {
                const FColor Sample = static_cast<const FColor*>(Data)[0];
                UE_LOG(LogAgoraVideoPump, Display,
                    TEXT("First pumped frame: top-left BGRA=(%d,%d,%d,%d) stride=%d height=%d"),
                    Sample.B, Sample.G, Sample.R, Sample.A,
                    RowPitchInPixels, BufferHeight);
                bLoggedFirstFrameSample = true;
            }

            auto* MediaEngine = static_cast<agora::media::IMediaEngine*>(CachedMediaEngine);
            MediaEngine->pushVideoFrame(&Frame);

            ReadbackPtr->Unlock();
        }
        bReadbackInFlight = false;
    }

    // Step 2 — Enqueue a new readback for the next pump tick to harvest.
    // EnqueueCopy is render-thread-only; we capture the readback pointer and
    // RT resource by value (both are render-thread-safe references that
    // outlive the lambda by virtue of StopVideoPump's FlushRenderingCommands).
    PendingFrameTimestampMs = static_cast<int64>(FPlatformTime::Seconds() * 1000.0);
    ENQUEUE_RENDER_COMMAND(AgoraVideoPumpEnqueueReadback)(
        [ReadbackPtr, RTResource](FRHICommandListImmediate& RHICmdList)
        {
            if (FRHITexture* Tex = RTResource->GetRenderTargetTexture())
            {
                ReadbackPtr->EnqueueCopy(RHICmdList, Tex);
            }
        });
    bReadbackInFlight = true;
}
