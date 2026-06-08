<#
.SYNOPSIS
  Per-device cook wrapper for VR_Project (Quest 3 or Pico 4 Enterprise).

.DESCRIPTION
  Replaces the manual "edit DefaultEngine.ini [HMDPluginPriority], cook,
  remember to flip back" workflow documented as a workaround in Devlog
  2026-06-08. For one cook invocation, the script:
    1. Mutates [HMDPluginPriority] in DefaultEngine.ini for the target.
    2. Invokes UAT verbatim per .cursorrules §8.2 (with optional flag drops).
    3. ALWAYS restores DefaultEngine.ini to baseline in a finally block --
       runs on success, UAT failure, throw, and Ctrl-C alike.
    4. Renames the produced APK to include the device tag so both
       vendors' APKs co-exist on disk (Quest doesn't overwrite Pico
       or vice versa).

  Baseline state (when this script is NOT running) is QUEST-targeted:
      [HMDPluginPriority]
      OpenXR=10
      PICOXRHMD=0
  Rationale: the editor's VR Preview / PIE uses this same block, and
  Quest+Link is the dominant in-editor dev workflow. A Pico cook just
  flips it for the duration of UAT and reverts.

  This script implements approach (b) ("per-device cook profile") from
  the 2026-06-08 Devlog backlog item "Proper universal-APK HMD
  selection fix".

.PARAMETER Device
  Target device: 'quest', 'pico', or 'auto' (default).
  'auto' detects via `adb devices` + `adb shell getprop ro.product.manufacturer`.
  Auto-detect fails (asks you to pass -Device explicitly) when zero or
  multiple devices are on ADB, or when the manufacturer is neither
  Oculus nor Pico.

.PARAMETER DryRun
  Mutate + restore the INI without invoking UAT. Use to validate the
  script's INI-handling semantics. Expected outcome: zero `git diff`
  after the script exits successfully.

.PARAMETER NoDeploy
  Drop `-deploy -run` from the UAT command -- produces an APK without
  installing/launching on the connected headset. Useful when cooking
  on a machine without the target device attached.

.PARAMETER Configuration
  UAT clientconfig (Development or Shipping). Defaults to Development.

.EXAMPLE
  .\Tools\Cook-VRApp.ps1 -Device quest
    Cook Quest-targeted APK, deploy + launch on connected Quest.

.EXAMPLE
  .\Tools\Cook-VRApp.ps1 -Device pico -NoDeploy
    Cook Pico-targeted APK, leave install as a separate `adb install` step.

.EXAMPLE
  .\Tools\Cook-VRApp.ps1
    Auto-detect connected device, cook + deploy + launch.

.EXAMPLE
  .\Tools\Cook-VRApp.ps1 -Device pico -DryRun
    Validate INI mutate/restore for Pico target without burning a cook.

.NOTES
  Supersedes the manual workaround documented in:
    - HowToPort.md gotcha #12 (now superseded by gotcha #12 v2)
    - Devlog 2026-06-08 "HMD-priority regression" workaround section
  See Devlog 2026-06-08 follow-up entry for design rationale.

  EXECUTION POLICY: Stock Windows PowerShell ships with execution policy
  'Restricted', which blocks running this script. First-time setup, one
  of these (in order of preference):

    # (a) Allow signed remote + any local script for the current user
    #     (one-time, persistent, recommended):
    Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

    # (b) Per-invocation bypass (no persistent state change):
    powershell -ExecutionPolicy Bypass -File .\Tools\Cook-VRApp.ps1 ...

    # (c) Session-only bypass (lasts for the current PS window):
    Set-ExecutionPolicy -Scope Process Bypass; .\Tools\Cook-VRApp.ps1 ...

  This bites because Cook-VRApp.ps1 is unsigned. Option (a) is the
  standard developer-machine setup for any PowerShell-based tooling.
#>
[CmdletBinding()]
param(
    [ValidateSet('quest', 'pico', 'auto')]
    [string]$Device = 'auto',

    [switch]$DryRun,

    [switch]$NoDeploy,

    [ValidateSet('Development', 'Shipping')]
    [string]$Configuration = 'Development'
)

$ErrorActionPreference = 'Stop'

# ---------- repo layout ----------
$repoRoot  = Split-Path -Parent $PSScriptRoot
$iniPath   = Join-Path $repoRoot 'VR_Project\Config\DefaultEngine.ini'
$uprojPath = Join-Path $repoRoot 'VR_Project\VR_Project.uproject'
$uatPath   = 'C:\Program Files\Epic Games\UE_5.5\Engine\Build\BatchFiles\RunUAT.bat'
$apkDir    = Join-Path $repoRoot 'VR_Project\Binaries\Android'
$apkPath   = Join-Path $apkDir   'VR_Project-arm64.apk'

# Values per the Devlog 2026-06-08 regression analysis:
#   quest -> OpenXR=10, PICOXRHMD=0   (Meta runtime wins on Quest)
#   pico  -> OpenXR=0,  PICOXRHMD=10  (PXR runtime wins on Pico; OpenXR=10
#                                      would let Pico's generic OpenXR layer
#                                      win and ANR the app at cold boot)
$priorityValues = @{
    quest = @{ OpenXR = 10; PICOXRHMD = 0  }
    pico  = @{ OpenXR = 0;  PICOXRHMD = 10 }
}

# ---------- pre-flight ----------
if (-not (Test-Path $iniPath))   { throw "DefaultEngine.ini not found at $iniPath" }
if (-not (Test-Path $uprojPath)) { throw ".uproject not found at $uprojPath" }
if (-not $DryRun -and -not (Test-Path $uatPath)) {
    throw "RunUAT.bat not found at $uatPath -- is UE 5.5 installed at the expected location?"
}

# Refuse to run if DefaultEngine.ini has uncommitted edits. The script
# overwrites the file during cook and restores from an in-memory snapshot;
# any pre-existing uncommitted edits would be lost if a crash interrupted
# the restore. Force the dev to commit or stash first.
Push-Location $repoRoot
try {
    $iniRel = (Resolve-Path $iniPath -Relative).TrimStart('.\').Replace('\', '/')
    $dirtyFiles = git status --porcelain -- $iniRel
} finally {
    Pop-Location
}
if ($dirtyFiles) {
    throw "DefaultEngine.ini has uncommitted changes:`n$dirtyFiles`nCommit or stash before running this script (it temporarily overwrites the file)."
}

# ---------- device resolution ----------
function Resolve-Device {
    param([string]$Requested)
    if ($Requested -ne 'auto') { return $Requested }

    Write-Host "[Cook-VRApp] -Device auto: probing ADB ..."
    $devicesRaw = & adb devices -l 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "adb is not on PATH (or failed). Pass -Device quest|pico explicitly, or fix PATH."
    }
    $deviceSerials = @($devicesRaw |
        Where-Object { $_ -match '^\S+\s+device\b' } |
        ForEach-Object { ($_ -split '\s+')[0] })

    if ($deviceSerials.Count -eq 0) {
        throw "No authorized devices on ADB. Connect a headset (and accept the USB-debug prompt) or pass -Device quest|pico explicitly."
    }
    if ($deviceSerials.Count -gt 1) {
        throw "Multiple devices on ADB ($($deviceSerials -join ', ')). Pass -Device quest|pico explicitly to disambiguate."
    }

    $serial = $deviceSerials[0]
    $mfr = (& adb -s $serial shell getprop ro.product.manufacturer 2>$null).Trim()
    switch ($mfr) {
        'Oculus' { Write-Host "[Cook-VRApp] auto-detected Quest (serial=$serial, manufacturer=$mfr)"; return 'quest' }
        'Pico'   { Write-Host "[Cook-VRApp] auto-detected Pico  (serial=$serial, manufacturer=$mfr)"; return 'pico'  }
        default  { throw "Unknown manufacturer '$mfr' on device $serial. Pass -Device quest|pico explicitly." }
    }
}

$resolved = Resolve-Device -Requested $Device
$targetVals = $priorityValues[$resolved]
$deviceCap = if ($resolved -eq 'quest') { 'Quest' } else { 'Pico' }
Write-Host "[Cook-VRApp] target device: $resolved (HMDPluginPriority will be OpenXR=$($targetVals.OpenXR), PICOXRHMD=$($targetVals.PICOXRHMD) for this cook)"

# ---------- INI mutation prep ----------
# Read the file as raw bytes so we can restore byte-identically on exit
# (preserves line endings, BOM presence, trailing newline, etc.).
$originalBytes = [System.IO.File]::ReadAllBytes($iniPath)
$originalText  = [System.Text.Encoding]::UTF8.GetString($originalBytes)

# `(?m)` enables ^ to match start-of-line. Confirmed via grep that the file
# contains exactly one `OpenXR=<n>` line and one `PICOXRHMD=<n>` line, both
# inside [HMDPluginPriority] -- so global -replace is unambiguous.
$mutatedText = $originalText `
    -replace '(?m)^OpenXR=\d+',    "OpenXR=$($targetVals.OpenXR)" `
    -replace '(?m)^PICOXRHMD=\d+', "PICOXRHMD=$($targetVals.PICOXRHMD)"

$mutatedBytes = [System.Text.Encoding]::UTF8.GetBytes($mutatedText)

# Sanity check: if there's no diff at all the file didn't contain the
# expected priority block (e.g. someone restructured the INI). Refuse to
# proceed rather than silently cook against an unmutated config.
if ([System.Linq.Enumerable]::SequenceEqual([byte[]]$originalBytes, [byte[]]$mutatedBytes) -and `
    $resolved -ne 'quest') {
    # Quest case can legitimately be a no-op if the baseline already
    # matches -- which is the expected baseline. Pico must produce a diff.
    throw "Mutation produced no change for -Device $resolved. DefaultEngine.ini may have been restructured -- the script's [HMDPluginPriority] regex no longer finds the expected lines. Investigate before re-running."
}

# ---------- cook with guaranteed restore ----------
function Restore-Ini {
    [System.IO.File]::WriteAllBytes($iniPath, $originalBytes)
    Write-Host "[Cook-VRApp] restored DefaultEngine.ini to baseline state."
}

try {
    [System.IO.File]::WriteAllBytes($iniPath, $mutatedBytes)
    Write-Host "[Cook-VRApp] mutated [HMDPluginPriority] -> OpenXR=$($targetVals.OpenXR), PICOXRHMD=$($targetVals.PICOXRHMD)"

    if ($DryRun) {
        Write-Host "[Cook-VRApp] -DryRun: skipping UAT. (Inspect 'git diff -- VR_Project/Config/DefaultEngine.ini' now if you want to see the mutation; the script will restore in <1s.)"
        Start-Sleep -Milliseconds 500
        return
    }

    # Build UAT command verbatim per .cursorrules §8.2, with optional flag drops.
    $deployFlags = if ($NoDeploy) { '' } else { '-deploy -run' }
    $uatArgs = @(
        'BuildCookRun'
        '-project="%CD%\VR_Project.uproject"'
        '-targetplatform=Android'
        '-cookflavor=ASTC'
        "-clientconfig=$Configuration"
        '-build -cook -stage -package -archive'
        '-archivedirectory="%CD%\Build"'
        $deployFlags
    ) -join ' '

    $cmdLine = "`"$uatPath`" $uatArgs"
    Write-Host "[Cook-VRApp] invoking UAT:"
    Write-Host "             $cmdLine"

    # cmd /c required so the %CD% literal in the args expands against
    # the VR_Project working directory (per .cursorrules §8.2 note --
    # PowerShell's %CD% expansion differs from cmd's).
    Push-Location (Join-Path $repoRoot 'VR_Project')
    try {
        & cmd /c $cmdLine
        $uatExit = $LASTEXITCODE
        if ($uatExit -ne 0) {
            throw "UAT failed with exit code $uatExit (see UAT log above for the failure signature; cross-ref .cursorrules §8.5)."
        }
    } finally {
        Pop-Location
    }

    # ---------- APK rename ----------
    if (Test-Path $apkPath) {
        $renamedPath = Join-Path $apkDir "VR_Project-$deviceCap-arm64.apk"
        if (Test-Path $renamedPath) { Remove-Item $renamedPath -Force }
        Move-Item $apkPath $renamedPath
        $sizeMB = [Math]::Round((Get-Item $renamedPath).Length / 1MB, 1)
        Write-Host "[Cook-VRApp] APK renamed -> $renamedPath ($sizeMB MB)"
    } else {
        Write-Warning "[Cook-VRApp] expected APK at $apkPath, not found. UAT may have produced it elsewhere; check Build/Android_ASTC/ as fallback."
    }
}
finally {
    Restore-Ini
}

Write-Host "[Cook-VRApp] done."
