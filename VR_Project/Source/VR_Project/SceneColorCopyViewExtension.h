// Render-thread scene-color copy extension. Authored by external collaborator,
// integrated 2026-06-15. Pairs with URenderHijackingSubsystem to hijack an
// already-rendered VR/desktop frame into a UTextureRenderTarget2D WITHOUT
// re-rendering the scene (replaces the Phase 1/2 SceneCaptureComponent2D
// approach that was paying the per-frame scene-render cost twice).
//
// See HowToPort.md "Frame hijacking" section + Devlog 2026-06-15
// (instructor-view-rebuild entry) for design rationale.

#pragma once

#include "CoreMinimal.h"
#include "SceneViewExtension.h"

class UTextureRenderTarget2D;
class FTextureRenderTargetResource;
class FRHICommandList;
struct FMobilePostProcessingInputs;

class FSceneColorCopyViewExtension final : public FSceneViewExtensionBase
{
public:
	FSceneColorCopyViewExtension(const FAutoRegister& AutoRegister);

	void SetOutputRenderTarget(UTextureRenderTarget2D* InRenderTarget);

	virtual void SetupViewFamily(FSceneViewFamily& InViewFamily) override {}
	virtual void SetupView(FSceneViewFamily& InViewFamily, FSceneView& InView) override {}
	virtual void BeginRenderViewFamily(FSceneViewFamily& InViewFamily) override {}

	virtual void SubscribeToPostProcessingPass(
	EPostProcessingPass Pass,
	const FSceneView& InView,
	FAfterPassCallbackDelegateArray& InOutPassCallbacks,
	bool bIsPassEnabled) override;
	int32 InputWidthOverride{};
	int32 InputHeightOverride{};
	bool IsCopyingLeftEye{};

	virtual void PostRenderView_RenderThread(
		FRDGBuilder& GraphBuilder,
		FSceneView& InView
	) override;
	
private:
	
	FScreenPassTexture CopySceneColor_RenderThread(
		FRDGBuilder& GraphBuilder,
		const FSceneView& View,
		const FPostProcessMaterialInputs& Inputs
	);
	
	TWeakObjectPtr<UTextureRenderTarget2D> OutputRenderTarget;

	FTextureRenderTargetResource* CachedRenderTargetResource = nullptr;
	FIntPoint CachedRenderTargetSize = FIntPoint::ZeroValue;
	bool HasConnected{false};

	static void CalculateCenteredFillRect(const FIntPoint SourceSize,const FIntPoint DestSize, FIntPoint& OutSourcePosition, FIntPoint& OutSourceSize );
};
