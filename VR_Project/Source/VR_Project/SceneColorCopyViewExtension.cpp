// Render-thread scene-color copy extension. Authored by external collaborator,
// integrated 2026-06-15. See SceneColorCopyViewExtension.h for context.

#include "SceneColorCopyViewExtension.h"

#include "Async/Async.h"
#include "Engine/TextureRenderTarget2D.h"
#include "PostProcess/PostProcessMaterialInputs.h"
#include "RenderGraphBuilder.h"
#include "GlobalShader.h"
#include "RenderGraphUtils.h"
#include "ScreenPass.h"
#include "RHICommandList.h"
#include "TextureResource.h"

FSceneColorCopyViewExtension::FSceneColorCopyViewExtension(
	const FAutoRegister& AutoRegister)
	: FSceneViewExtensionBase(AutoRegister)
{
}

void FSceneColorCopyViewExtension::SetOutputRenderTarget(
	UTextureRenderTarget2D* InRenderTarget)
{
	UE_LOG(LogTemp,Error,TEXT("SetOutputRenderTarget"))
	OutputRenderTarget = InRenderTarget;
	if (!InRenderTarget)
	{
		CachedRenderTargetResource = nullptr;
		CachedRenderTargetSize = FIntPoint::ZeroValue;
		UE_LOG(LogTemp,Error,TEXT("SceneColorCapture: Didn't receive a valid RenderTarget."));
		return;
	}

	CachedRenderTargetResource =
		InRenderTarget->GameThread_GetRenderTargetResource();

	CachedRenderTargetSize = FIntPoint(
		InRenderTarget->SizeX,
		InRenderTarget->SizeY
	);
}

void FSceneColorCopyViewExtension::SubscribeToPostProcessingPass(
	EPostProcessingPass Pass,
	const FSceneView& InView,
	FAfterPassCallbackDelegateArray& InOutPassCallbacks,
	bool bIsPassEnabled)
{
	
	if (Pass != EPostProcessingPass::Tonemap)
	{
		return;
	}
	const bool bIsStereoEye =
		IStereoRendering::IsStereoEyeView(InView);

	const bool bShouldCapture =
		!bIsStereoEye || InView.IsPrimarySceneView();
	if (!bShouldCapture)
	{
		return;
	}
	

	InOutPassCallbacks.Add(
		FAfterPassCallbackDelegate::CreateRaw(
			this,
			&FSceneColorCopyViewExtension::CopySceneColor_RenderThread
		)
	);
}


FScreenPassTexture FSceneColorCopyViewExtension::CopySceneColor_RenderThread(
	FRDGBuilder& GraphBuilder,
	const FSceneView& View,
	const FPostProcessMaterialInputs& Inputs)
{
	const FScreenPassTextureSlice SceneColorSlice =
		Inputs.GetInput(EPostProcessMaterialInput::SceneColor);

	/*
	 * Desktop SceneColor is usually a normal Texture2D, but this also handles
	 * cases where Unreal provides a texture-array slice.
	 */
	FScreenPassTexture SceneColor =
		FScreenPassTexture::CopyFromSlice(
			GraphBuilder,
			SceneColorSlice
		);

	if (!SceneColor.IsValid())
	{
		UE_LOG(
			LogTemp,
			Warning,
			TEXT("RenderHijacking: Desktop SceneColor is invalid.")
		);

		return SceneColor;
	}

	if (!CachedRenderTargetResource)
	{
		UE_LOG(
			LogTemp,
			Warning,
			TEXT("RenderHijacking: No cached destination render-target resource.")
		);

		return SceneColor;
	}

	FRHITexture* DestinationTextureRHI =
		CachedRenderTargetResource->GetRenderTargetTexture();

	if (!DestinationTextureRHI)
	{
		UE_LOG(
			LogTemp,
			Warning,
			TEXT("RenderHijacking: Desktop destination RHI texture is invalid.")
		);

		return SceneColor;
	}

	FRDGTextureRef DestinationTexture =
		GraphBuilder.RegisterExternalTexture(
			CreateRenderTarget(
				DestinationTextureRHI,
				TEXT("RenderHijackingDesktopDestination")
			)
		);

	const FIntPoint InputPosition(
		SceneColor.ViewRect.Min.X,
		SceneColor.ViewRect.Min.Y
	);

	const FIntPoint InputSize(
		SceneColor.ViewRect.Width(),
		SceneColor.ViewRect.Height()
	);

	const FIntPoint OutputPosition(0, 0);

	const FIntPoint OutputSize(
		DestinationTexture->Desc.Extent.X,
		DestinationTexture->Desc.Extent.Y
	);

	/*
	 * Helpful when the desktop viewport does not fill the full destination.
	 * This prevents old frame contents from remaining in unused regions.
	 */
	AddClearRenderTargetPass(
		GraphBuilder,
		DestinationTexture,
		FLinearColor::Black
	);
	
	FIntPoint FullSourceSize{
	SceneColor.ViewRect.Width(),
	SceneColor.ViewRect.Height()
	};
	if (InputHeightOverride !=0 && InputWidthOverride)
	{
		FullSourceSize = {InputWidthOverride,InputHeightOverride};
	}

	const FIntPoint DestinationSize{
		DestinationTexture->Desc.Extent.X,
		DestinationTexture->Desc.Extent.Y
	};

	FIntPoint CroppedSourcePosition;
	FIntPoint CroppedSourceSize;

	CalculateCenteredFillRect(
		FullSourceSize,
		DestinationSize,
		CroppedSourcePosition,
		CroppedSourceSize
	);
	// SceneColor may start at a non-zero position inside a larger allocation.
	CroppedSourcePosition += SceneColor.ViewRect.Min;

	AddDrawTexturePass(
		GraphBuilder,
		FScreenPassViewInfo(View),
		SceneColor.Texture,
		DestinationTexture,
		CroppedSourcePosition,
		CroppedSourceSize,
		FIntPoint(0, 0),
		DestinationSize
	);

	static int32 CopyCount = 0;

	if ((CopyCount++ % 300) == 0)
	{
		UE_LOG(
			LogTemp,
			Warning,
			TEXT("RenderHijacking: Desktop draw #%d OK. Source=%dx%d Format=%d Destination=%dx%d Format=%d."),
			CopyCount,
			InputSize.X,
			InputSize.Y,
			static_cast<int32>(SceneColor.Texture->Desc.Format),
			OutputSize.X,
			OutputSize.Y,
			static_cast<int32>(DestinationTexture->Desc.Format)
		);
	}

	return SceneColor;
}


void FSceneColorCopyViewExtension::CalculateCenteredFillRect(
	const FIntPoint SourceSize,
	const FIntPoint DestSize,
	FIntPoint& OutSourcePosition,
	FIntPoint& OutSourceSize
)
{
	const float SourceAspect =
		static_cast<float>(SourceSize.X) /
		static_cast<float>(SourceSize.Y);

	const float DestinationAspect =
		static_cast<float>(DestSize.X) /
		static_cast<float>(DestSize.Y);

	if (SourceAspect > DestinationAspect)
	{
		// Source is wider than destination.
		// Crop left and right.
		const int32 CroppedWidth =
			FMath::RoundToInt(SourceSize.Y * DestinationAspect);

		OutSourceSize = FIntPoint(
			CroppedWidth,
			SourceSize.Y
		);

		OutSourcePosition = FIntPoint(
			(SourceSize.X - CroppedWidth) / 2,
			0
		);
	}
	else
	{
		// Source is taller / narrower than destination.
		// Crop top and bottom.
		const int32 CroppedHeight =
			FMath::RoundToInt(SourceSize.X / DestinationAspect);

		OutSourceSize = FIntPoint(
			SourceSize.X,
			CroppedHeight
		);

		OutSourcePosition = FIntPoint(
			0,
			(SourceSize.Y - CroppedHeight) / 2
		);
	}
}


void FSceneColorCopyViewExtension::PostRenderView_RenderThread(
	FRDGBuilder& GraphBuilder,
	FSceneView& InView)
{
	const int EyeIndex = IsCopyingLeftEye ? 0 : 1;
	if (InView.StereoViewIndex != EyeIndex) //only run it for one eye
	{
		return;
	}

	if (!CachedRenderTargetResource)
	{
		UE_LOG(LogTemp, Error,
			TEXT("SceneColorCapture: No cached render target resource."));
		return;
	}

	if (!InView.Family || !InView.Family->RenderTarget)
	{
		UE_LOG(LogTemp, Error,
			TEXT("SceneColorCapture: No view-family render target."));
		return;
	}

	FRHITexture* SourceTextureRHI =
		InView.Family->RenderTarget->GetRenderTargetTexture();

	FRHITexture* DestinationTextureRHI =
		CachedRenderTargetResource->GetRenderTargetTexture();

	if (!SourceTextureRHI || !DestinationTextureRHI)
	{
		UE_LOG(LogTemp, Error,
			TEXT("SceneColorCapture: Source or destination RHI texture invalid."));
		return;
	}

	const FRHITextureDesc& SourceDesc =
		SourceTextureRHI->GetDesc();

	const FRHITextureDesc& DestinationDesc =
		DestinationTextureRHI->GetDesc();

	if (SourceDesc.ArraySize < 2)
	{
		UE_LOG(LogTemp, Error,
			TEXT("SceneColorCapture: Expected stereo array texture, but ArraySize=%d."),
			SourceDesc.ArraySize);
		return;
	}

	FRDGTextureRef SourceTexture =
		GraphBuilder.RegisterExternalTexture(
			CreateRenderTarget(
				SourceTextureRHI,
				TEXT("SceneColorCaptureSource")
			)
		);

	FRDGTextureRef DestinationTexture =
		GraphBuilder.RegisterExternalTexture(
			CreateRenderTarget(
				DestinationTextureRHI,
				TEXT("SceneColorCaptureDestination")
			)
		);

	FIntPoint FullSourceSize{
	SourceDesc.Extent.X,
	SourceDesc.Extent.Y
	};
	if (InputHeightOverride !=0 && InputWidthOverride)
	{
		FullSourceSize = {InputWidthOverride,InputHeightOverride};
	}
	
	const FIntPoint DestinationSize{
		DestinationDesc.Extent.X,
		DestinationDesc.Extent.Y
	};

	FIntPoint CroppedSourcePosition;
	FIntPoint CroppedSourceSize;

	CalculateCenteredFillRect(
		FullSourceSize,
		DestinationSize,
		CroppedSourcePosition,
		CroppedSourceSize
	);

	if (!IsCopyingLeftEye) // removes the weird flickering on the inside corner if the right eye is copied
	{
		CroppedSourcePosition.X = CroppedSourcePosition.X + (SourceDesc.Extent.X - InputWidthOverride);
		UE_LOG(LogTemp,Warning,TEXT("Copying Right Eye offset = %d"),(SourceDesc.Extent.X - InputWidthOverride))
	}


	
	FRDGTextureSRVDesc EyeSRVDesc(SourceTexture);
	EyeSRVDesc.FirstArraySlice = EyeIndex;
	EyeSRVDesc.NumArraySlices = 1;

	FRDGTextureSRVRef EyeSRV =
		GraphBuilder.CreateSRV(EyeSRVDesc);

	const FScreenPassTextureSlice InputSlice(
		EyeSRV,
		FIntRect(
			CroppedSourcePosition,
			CroppedSourcePosition + CroppedSourceSize
		)
	);

	const FScreenPassRenderTarget OutputTarget(
		DestinationTexture,
		FIntRect(
			FIntPoint::ZeroValue,
			DestinationSize
		),
		ERenderTargetLoadAction::ENoAction
	);

	AddDrawTexturePass(
		GraphBuilder,
		FScreenPassViewInfo(InView),
		InputSlice,
		OutputTarget
	);

	static int32 CopyCount = 0;

	if ((CopyCount++ % 300) == 0)
	{
		UE_LOG(LogTemp, Warning,
			TEXT("SceneColorCapture: %hs copy OK. Source=%dx%d ArraySize=%d Format=%d Destination=%dx%d."),
			IsCopyingLeftEye ? "Left Eye" : "Right Eye",
			SourceDesc.Extent.X,
			SourceDesc.Extent.Y,
			SourceDesc.ArraySize,
			static_cast<int32>(SourceDesc.Format),
			DestinationDesc.Extent.X,
			DestinationDesc.Extent.Y);
	}
}



