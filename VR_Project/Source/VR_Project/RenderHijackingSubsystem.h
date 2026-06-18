// VR Instructor Portal — Phase 7 instructor-view rebuild.
// Authored by external collaborator, integrated 2026-06-15. Pairs with
// FSceneColorCopyViewExtension to hijack an already-rendered VR/desktop frame
// into a UTextureRenderTarget2D WITHOUT re-rendering the scene — replaces
// the Phase 1/2 SceneCaptureComponent2D pipeline that was paying the per-
// frame scene-render cost twice on mobile VR.
//
// BP usage flow (covered in HowToPort.md "Frame hijacking" recipe):
//   1. BP_VRPawn BeginPlay -> Get Subsystem (URenderHijackingSubsystem)
//      -> StartRenderHijacking(W, H, InW, InH, ShouldCopyLeftEye=false).
//      W/H = the desired output stream resolution (1280x720 per .cursorrules §1.3).
//      InW/InH = the input HMD eye-buffer size; call GetRecommendedInputResolution()
//      to pick the right (Quest=1720x1760 / Pico=1500x1850) values.
//   2. Per-tick: GetOutputRenderTarget() -> set as `CapturedTexture` parameter
//      on a M_InstructorView dynamic material instance, then
//      DrawMaterialToRenderTarget(RT_InstructorView, MID).
//   3. RT_InstructorView feeds UAgoraVideoPump::SourceRT (re-pinned from the
//      old RT_InstructorStream during the Phase 7 swap).
//
// Lifecycle: a UGameInstanceSubsystem so it survives PIE-level transitions
// without being respawned. Deinitialize() tears down the view extension
// cleanly on GameInstance shutdown.

#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "RenderHijackingSubsystem.generated.h"

class UTextureRenderTarget2D;
class FSceneColorCopyViewExtension;

UCLASS()
class VR_PROJECT_API URenderHijackingSubsystem
	: public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintCallable, Category = "Render Hijacking")
	bool StartRenderHijacking(
		int32 Width = 2016,
		int32 Height = 1760,
		int32 InputWidthOverride = 0,
		int32 InputHeightOverride = 0,
		bool ShouldCopyLeftEye = false
	);

	UFUNCTION(BlueprintCallable, Category = "Render Hijacking")
	void StopRenderHijacking();

	UFUNCTION(BlueprintPure, Category = "Render Hijacking")
	UTextureRenderTarget2D* GetOutputRenderTarget() const
	{
		return OutputRenderTarget;
	}

	UFUNCTION(BlueprintPure, Category = "Render Hijacking")
	bool IsRenderHijackingActive() const
	{
		return ViewExtension.IsValid() && OutputRenderTarget != nullptr;
	}

	/**
	 * Returns the recommended (InputWidthOverride, InputHeightOverride) pair
	 * for the *active* XR runtime, so BP authors don't have to hardcode a
	 * vendor branch in their BeginPlay graph.
	 *
	 *   - PICOXR runtime  -> (1500, 1850)  (Pico 4 / Pico 4 Enterprise eye buffer)
	 *   - OpenXR (Meta)   -> (1720, 1760)  (Quest 3 eye buffer)
	 *   - Anything else / no HMD active -> (1720, 1760)  (Quest default; safe
	 *     fallback for new vendors because the FSceneColorCopyViewExtension's
	 *     right-eye offset correction degenerates with (0,0).)
	 *
	 * Static + BlueprintCallable so it's callable from a Class Default BP
	 * (no subsystem instance lookup required, just drag the node in).
	 *
	 * Detection uses GEngine->XRSystem->GetSystemName() — the *active*
	 * runtime, not the merely-enabled plugins. This is important because we
	 * keep BOTH PICOXR and OpenXR enabled simultaneously in the .uproject
	 * per the 2026-06-08 per-device cook recipe; checking enabled plugins
	 * (as the colleague's original .md suggested) would mis-detect on every
	 * Quest build that still has PICOXR linked but inactive.
	 */
	UFUNCTION(BlueprintPure, Category = "Render Hijacking")
	static FIntPoint GetRecommendedInputResolution();

	virtual void Deinitialize() override;

private:
	UPROPERTY()
	UTextureRenderTarget2D* OutputRenderTarget = nullptr;

	TSharedPtr<FSceneColorCopyViewExtension, ESPMode::ThreadSafe> ViewExtension;
	
};
