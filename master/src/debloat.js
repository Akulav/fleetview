// The example "debloat" script the saved-script library starts with.
// Conservative on purpose: nothing here touches the Microsoft Store, Defender,
// Windows Update, Edge, winget or the frameworks apps depend on. ASCII only.

export const DEBLOAT_SCRIPT = String.raw`# FleetView: conservative Windows 10/11 debloat (example - edit to taste)
#
# Runs as SYSTEM. Safe to run again: it only removes what is still there and
# sets values that are not set yet. What it does:
#   1. Removes consumer AppX apps for every user AND from the Windows image,
#      so new user profiles do not get them back.
#   2. Turns off "consumer features" (apps Windows installs by itself), tips,
#      suggestions and suggested apps in Start, for every user signed in now
#      and for new users (Default profile).
#   3. Sets diagnostic data (telemetry) to the minimum this edition allows,
#      turns off the advertising ID and feedback prompts.
# What it never touches: Microsoft Store, App Installer (winget), Windows
# Security / Defender, Windows Update, Edge, Calculator, Photos, Notepad,
# Terminal, Snipping Tool, the media player, and the frameworks (VCLibs, .NET,
# UI.Xaml) other apps need.

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# ---- 1. Apps to remove (wildcards allowed). Delete a line to keep an app. --
$RemoveApps = @(
  'Microsoft.BingNews'                  # News
  'Microsoft.BingWeather'               # Weather
  'Microsoft.BingSearch'                # Bing search app
  'Microsoft.GetHelp'                   # Get Help
  'Microsoft.Getstarted'                # Tips
  'Microsoft.MicrosoftSolitaireCollection'
  'Microsoft.MicrosoftOfficeHub'        # "Office" / Microsoft 365 launcher (not Office itself)
  'Microsoft.People'
  'Microsoft.WindowsFeedbackHub'
  'Microsoft.WindowsMaps'
  'Microsoft.ZuneVideo'                 # Movies & TV
  'Microsoft.MixedReality.Portal'
  'Microsoft.SkypeApp'
  'Microsoft.549981C3F5F10'             # Cortana
  'Microsoft.PowerAutomateDesktop'
  'Microsoft.Windows.DevHome'
  'MicrosoftTeams'                      # Teams (personal/free). Work Teams is MSTeams - kept.
  'Clipchamp.Clipchamp'
  'MicrosoftCorporationII.MicrosoftFamily'
  'Microsoft.Messaging'
  'Microsoft.OneConnect'
  'Microsoft.Print3D'
  'Microsoft.3DBuilder'
  'Microsoft.Microsoft3DViewer'
  # Games and promoted third-party apps Windows pre-installs:
  'king.com.*'                          # Candy Crush and friends
  '*.Disney*'
  'SpotifyAB.SpotifyMusic'
  'Facebook.*'
  '*.Twitter'
  'BytedancePte.Ltd.TikTok'
  # Optional - uncomment if you don't want them:
  # 'Microsoft.YourPhone'               # Phone Link
  # 'Microsoft.XboxApp'                 # Xbox console companion
  # 'Microsoft.GamingApp'               # Xbox app
  # 'Microsoft.OutlookForWindows'       # new Outlook
  # 'Microsoft.Todos'
)

# Never removed, even if a pattern above matches them.
$Protected = @(
  'Microsoft.WindowsStore', 'Microsoft.StorePurchaseApp', 'Microsoft.DesktopAppInstaller',
  'Microsoft.SecHealthUI', 'Microsoft.Windows.SecHealthUI', 'Microsoft.MicrosoftEdge*', 'Microsoft.Edge*',
  'Microsoft.VCLibs*', 'Microsoft.NET.*', 'Microsoft.UI.Xaml*', 'Microsoft.WindowsAppRuntime*', 'Microsoft.Services.Store.Engagement',
  'Microsoft.WindowsCalculator', 'Microsoft.Windows.Photos', 'Microsoft.WindowsNotepad', 'Microsoft.WindowsTerminal',
  'Microsoft.ScreenSketch', 'Microsoft.Paint', 'Microsoft.ZuneMusic', 'Microsoft.HEIFImageExtension*', 'Microsoft.*VideoExtension*',
  'Microsoft.WebpImageExtension', 'Microsoft.RawImageExtension', 'Microsoft.Xbox.TCUI', 'Microsoft.XboxIdentityProvider',
  'Microsoft.XboxGameOverlay', 'Microsoft.XboxGamingOverlay', 'Microsoft.XboxSpeechToTextOverlay', 'MSTeams',
  'Microsoft.WindowsAlarms', 'Microsoft.WindowsCamera', 'Microsoft.WindowsSoundRecorder', 'Microsoft.MicrosoftStickyNotes',
  'Microsoft.CompanyPortal', 'Microsoft.AAD.BrokerPlugin', 'Microsoft.AccountsControl'
)
function Test-Protected($name) { foreach ($p in $Protected) { if ($name -like $p) { return $true } }; return $false }

$removed = 0; $failed = 0; $changed = 0

'== Apps'
$installed = @(Get-AppxPackage -AllUsers -ErrorAction SilentlyContinue)
$provisioned = @(Get-AppxProvisionedPackage -Online -ErrorAction SilentlyContinue)
foreach ($pattern in $RemoveApps) {
  foreach ($pv in @($provisioned | Where-Object { $_.DisplayName -like $pattern })) {
    if (Test-Protected $pv.DisplayName) { continue }
    try {
      [void](Remove-AppxProvisionedPackage -Online -PackageName $pv.PackageName -ErrorAction Stop)
      '  removed from the Windows image: ' + $pv.DisplayName; $removed++
    } catch { '  could not remove from the image: ' + $pv.DisplayName + ' - ' + $_.Exception.Message; $failed++ }
  }
  foreach ($pkg in @($installed | Where-Object { $_.Name -like $pattern -and -not $_.NonRemovable })) {
    if (Test-Protected $pkg.Name) { continue }
    try {
      Remove-AppxPackage -Package $pkg.PackageFullName -AllUsers -ErrorAction Stop
      '  removed for all users: ' + $pkg.Name; $removed++
    } catch { '  could not remove: ' + $pkg.Name + ' - ' + $_.Exception.Message; $failed++ }
  }
}

# ---- helpers for registry values --------------------------------------------
function Set-Dword($path, $name, $value) {
  # $path like 'HKLM:\SOFTWARE\...'. Creates the key without touching others.
  if (-not (Test-Path -LiteralPath $path)) { [void](New-Item -Path $path -Force) }
  $cur = (Get-ItemProperty -LiteralPath $path -Name $name -ErrorAction SilentlyContinue).$name
  if ($cur -ne $value) {
    [void](New-ItemProperty -LiteralPath $path -Name $name -PropertyType DWord -Value $value -Force)
    $script:changed++
  }
}

'== Consumer features, tips and suggestions'
$cloud = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent'
Set-Dword $cloud 'DisableWindowsConsumerFeatures' 1     # no auto-installed "suggested" apps
Set-Dword $cloud 'DisableSoftLanding' 1                 # no "tips about Windows"
Set-Dword $cloud 'DisableCloudOptimizedContent' 1
Set-Dword $cloud 'DisableConsumerAccountStateContent' 1

# Per-user suggestion switches (ContentDeliveryManager).
$cdmValues = @(
  'ContentDeliveryAllowed', 'FeatureManagementEnabled', 'OemPreInstalledAppsEnabled', 'PreInstalledAppsEnabled',
  'PreInstalledAppsEverEnabled', 'SilentInstalledAppsEnabled', 'SoftLandingEnabled', 'SystemPaneSuggestionsEnabled',
  'SubscribedContent-310093Enabled', 'SubscribedContent-338388Enabled', 'SubscribedContent-338389Enabled',
  'SubscribedContent-338393Enabled', 'SubscribedContent-353694Enabled', 'SubscribedContent-353696Enabled'
)
function Set-UserSuggestions($hiveRoot) {
  $cdm = $hiveRoot + '\Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager'
  foreach ($v in $cdmValues) { Set-Dword $cdm $v 0 }
  Set-Dword ($hiveRoot + '\Software\Microsoft\Windows\CurrentVersion\AdvertisingInfo') 'Enabled' 0
  Set-Dword ($hiveRoot + '\Software\Microsoft\Siuf\Rules') 'NumberOfSIUFInPeriod' 0
}
# Users signed in now.
foreach ($sid in @(Get-ChildItem Registry::HKEY_USERS | Where-Object { $_.PSChildName -match '^S-1-(5-21|12-1)-[0-9-]+$' } | ForEach-Object { $_.PSChildName })) {
  Set-UserSuggestions ('Registry::HKEY_USERS\' + $sid)
}
# New users: the Default profile. Loaded for a moment, then unloaded.
$defaultHive = Join-Path $env:SystemDrive 'Users\Default\NTUSER.DAT'
if (Test-Path -LiteralPath $defaultHive) {
  & reg.exe load 'HKU\FleetViewDefault' $defaultHive 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) {
    try { Set-UserSuggestions 'Registry::HKEY_USERS\FleetViewDefault' }
    finally {
      [gc]::Collect(); [gc]::WaitForPendingFinalizers()
      & reg.exe unload 'HKU\FleetViewDefault' 2>&1 | Out-Null
    }
  } else { '  could not load the Default user profile - new users keep the defaults' }
}

'== Telemetry and privacy'
# 0 = Security (only honoured on Enterprise/Education), 1 = Required (the minimum on Home/Pro).
$edition = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').EditionID
$level = $(if ($edition -match 'Enterprise|Education|Server') { 0 } else { 1 })
Set-Dword 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DataCollection' 'AllowTelemetry' $level
Set-Dword 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DataCollection' 'DoNotShowFeedbackNotifications' 1
Set-Dword 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\AdvertisingInfo' 'DisabledByGroupPolicy' 1
Set-Dword 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' 'PublishUserActivities' 0   # activity history
Set-Dword 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' 'UploadUserActivities' 0
'  telemetry level: ' + $level + ' (' + $edition + ')'

# Last line = the summary shown in Activity.
'Debloat done: ' + $removed + ' app package(s) removed, ' + $changed + ' setting(s) changed' + $(if ($failed) { ', ' + $failed + ' failed (see details)' } else { '' }) + '.'
exit $(if ($failed) { 1 } else { 0 })
`;
