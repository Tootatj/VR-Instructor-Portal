// VR Instructor Portal — Phase 7 instructor-view rebuild.
// Authored by external collaborator, integrated 2026-06-15. See header for context.

#include "RenderHijackingSubsystem.h"

#include "Engine/Engine.h"
#include "Engine/TextureRenderTarget2D.h"
#include "IXRTrackingSystem.h"
#include "SceneColorCopyViewExtension.h"
#include "SceneViewExtension.h"

bool URenderHijackingSubsystem::StartRenderHijacking(
	int32 Width,
	int32 Height,
	int32 InputWidthOverride,
	int32 InputHeightOverride,
	bool ShouldCopyLeftEye)
{
	check(IsInGameThread());

	if (Width <= 0 || Height <= 0)
	{
		UE_LOG(LogTemp,Error,
			TEXT("RenderHijacking: Invalid output size: %dx%d."),Width,Height);
		return false;
	}

	StopRenderHijacking();

	OutputRenderTarget = NewObject<UTextureRenderTarget2D>(this);

	if (!OutputRenderTarget)
	{
		UE_LOG(LogTemp,Error,
			TEXT("RenderHijacking: Failed to create output render target."));
		return false;
	}

	OutputRenderTarget->ClearColor = FLinearColor::Green;
	OutputRenderTarget->bAutoGenerateMips = false;

	OutputRenderTarget->RenderTargetFormat = RTF_RGBA8;

	OutputRenderTarget->InitAutoFormat(
		Width,
		Height
	);

	OutputRenderTarget->UpdateResourceImmediate(true);

	ViewExtension =
		FSceneViewExtensions::NewExtension<FSceneColorCopyViewExtension>();

	ViewExtension->InputHeightOverride = InputHeightOverride;
	ViewExtension->InputWidthOverride = InputWidthOverride;
	ViewExtension->IsCopyingLeftEye = ShouldCopyLeftEye;

	if (!ViewExtension.IsValid())
	{
		UE_LOG(
			LogTemp,
			Error,
			TEXT("RenderHijacking: Failed to create SceneViewExtension.")
		);

		OutputRenderTarget = nullptr;
		return false;
	}

	ViewExtension->SetOutputRenderTarget(OutputRenderTarget);

	UE_LOG(
		LogTemp,
		Warning,
		TEXT("RenderHijacking: Started. Output=%dx%d."),
		Width,
		Height
	);

	return true;
}

void URenderHijackingSubsystem::StopRenderHijacking()
{
	check(IsInGameThread());

	if (ViewExtension.IsValid())
	{
		ViewExtension->SetOutputRenderTarget(nullptr);
		ViewExtension.Reset();
	}

	OutputRenderTarget = nullptr;
}

FIntPoint URenderHijackingSubsystem::GetRecommendedInputResolution()
{
	// Defaults match the OpenXR/Meta-Quest 3 eye buffer. We default to these
	// (rather than (0,0)) because the FSceneColorCopyViewExtension's
	// right-eye corner-flicker fix subtracts InputWidthOverride from the
	// source X position — passing 0 there shifts the crop off the texture
	// entirely. Quest dims are the safer fallback for unrecognised runtimes.
	constexpr int32 QuestWidth = 1720;
	constexpr int32 QuestHeight = 1760;
	constexpr int32 PicoWidth = 1500;
	constexpr int32 PicoHeight = 1850;

	if (!GEngine || !GEngine->XRSystem.IsValid())
	{
		// Editor / no-HMD case. PostRenderView_RenderThread won't fire without
		// a stereo render path so the override is dead-code here, but we
		// still return a sane value rather than (0,0) for the right-eye fix.
		return FIntPoint(QuestWidth, QuestHeight);
	}

	const FString SystemName = GEngine->XRSystem->GetSystemName().ToString();

	// We match by substring rather than exact FName comparison because the
	// PICOXR plugin's IXRTrackingSystem registration name has varied across
	// plugin versions (FName("PicoXRHMD") in 3.x, FName("PicoXR") in older
	// builds). Either string contains "PicoXR".
	if (SystemName.Contains(TEXT("PicoXR"), ESearchCase::IgnoreCase))
	{
		return FIntPoint(PicoWidth, PicoHeight);
	}

	return FIntPoint(QuestWidth, QuestHeight);
}

void URenderHijackingSubsystem::Deinitialize()
{
	StopRenderHijacking();

	Super::Deinitialize();
}
