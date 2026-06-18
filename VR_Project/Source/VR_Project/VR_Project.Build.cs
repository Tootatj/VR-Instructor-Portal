// Fill out your copyright notice in the Description page of Project Settings.

using UnrealBuildTool;

public class VR_Project : ModuleRules
{
	public VR_Project(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
	
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "InputCore" });

		// AgoraPlugin: native IMediaEngine::pushVideoFrame() / setExternalVideoSource() are C++ only
		// (not exposed in the plugin's Blueprint surface), so UAgoraVideoPump links against the
		// plugin's public C++ headers. RenderCore + RHI are required for the render-thread RT
		// readback that feeds each pushed frame.
		//
		// Renderer: required by FSceneColorCopyViewExtension (Phase 7 instructor-view rebuild,
		// 2026-06-15) for FPostProcessMaterialInputs / FScreenPassTexture / FScreenPassRenderTarget.
		// Renderer is technically a private engine module — UE 5.5 supports adding it to a game
		// module's PrivateDependencyModuleNames as long as we also expose its include search path
		// via PrivateIncludePathModuleNames below.
		PrivateDependencyModuleNames.AddRange(new string[] { "AgoraPlugin", "RenderCore", "RHI", "Renderer" });
		PrivateIncludePathModuleNames.Add("Renderer");

		// SocketIOClient (getnamo) + its JSON helper module: USignalingSubsystem speaks the
		// dashboard's Socket.IO protocol (headset:register, headset:command, etc.) and uses
		// the BP-facing FSIOJsonObject for ack payloads. HTTP + Json are stock UE modules
		// needed for the POST /api/token call that mints the Agora token after register.
		PrivateDependencyModuleNames.AddRange(new string[] { "SocketIOClient", "SIOJson", "HTTP", "Json" });

		// HeadMountedDisplay: UHeadsetPresenceMonitor (Phase 1 Agora cost mitigation,
		// Devlog 2026-06-11) reads IXRTrackingSystem::GetHMDWornState() through GEngine
		// to detect when a user has taken the headset off. Vendor plugin (OpenXR /
		// PICOXR) selection is still controlled by [HMDPluginPriority] per the
		// 2026-06-08 per-device cook recipe; this dependency is just the abstract
		// interface.
		PrivateDependencyModuleNames.Add("HeadMountedDisplay");

		// Uncomment if you are using Slate UI
		// PrivateDependencyModuleNames.AddRange(new string[] { "Slate", "SlateCore" });
		
		// Uncomment if you are using online features
		// PrivateDependencyModuleNames.Add("OnlineSubsystem");

		// To include OnlineSubsystemSteam, add it to the plugins section in your uproject file with the Enabled attribute set to true
	}
}
