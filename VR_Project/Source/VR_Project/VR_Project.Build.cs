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
		PrivateDependencyModuleNames.AddRange(new string[] { "AgoraPlugin", "RenderCore", "RHI" });

		// Uncomment if you are using Slate UI
		// PrivateDependencyModuleNames.AddRange(new string[] { "Slate", "SlateCore" });
		
		// Uncomment if you are using online features
		// PrivateDependencyModuleNames.Add("OnlineSubsystem");

		// To include OnlineSubsystemSteam, add it to the plugins section in your uproject file with the Enabled attribute set to true
	}
}
