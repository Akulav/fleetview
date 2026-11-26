// Security baseline, its read-only check, the Windows Update repair and the
// adblocker policies. Plain PowerShell run as SYSTEM through the agent; ASCII
// only (the agent prefixes a UTF-8 BOM, Windows PowerShell 5.1 runs it).
//
// The baseline turns on what Windows ships but debloat tools, old installs or
// "speed-up" guides switch off: every Microsoft Defender module, the firewall,
// SmartScreen, UAC; and it turns off SMBv1, AutoRun and the Guest account.
// Things that break ordinary software are options, off by default
// (Controlled folder access) or chosen (attack surface reduction rules).
// When another antivirus is active, Defender is in passive mode and its
// settings are left alone.

// Registry helpers that write the 64-bit view (the agent may run as 32-bit)
// and create keys without wiping existing values (New-Item -Force would).
const REG = String.raw`$hklm = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64')
function Get-Reg($path, $name) { $k = $hklm.OpenSubKey($path); if (-not $k) { return $null }; try { $k.GetValue($name, $null) } finally { $k.Close() } }
function Set-Reg($path, $name, $value, $kind = 'DWord') {
  if ((Get-Reg $path $name) -eq $value) { return $false }
  $k = $hklm.CreateSubKey($path); try { $k.SetValue($name, $value, $kind) } finally { $k.Close() }; return $true
}
function Remove-Reg($path, $name) {
  $k = $hklm.OpenSubKey($path, $true); if (-not $k) { return $false }
  try { if ($null -ne $k.GetValue($name, $null)) { $k.DeleteValue($name); return $true }; return $false } finally { $k.Close() }
}`;

// Shared with the status check: what Defender is doing and who the AV is.
const AV = String.raw`function Get-AvProducts {
  try { @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop | ForEach-Object { $_.displayName } | Select-Object -Unique) } catch { @() }
}
$mp = $null; try { $mp = Get-MpComputerStatus -ErrorAction Stop } catch {}
$defenderActive = $mp -and ([string]$mp.AMRunningMode -in @('Normal', 'EDR Block Mode', '')) -and $mp.AntivirusEnabled
$otherAv = @(Get-AvProducts | Where-Object { $_ -notmatch 'Defender' })`;

// Policy values that turn Defender off. They win over Set-MpPreference, so
// the baseline removes them (only the values that disable something).
const DEFENDER_OFF_POLICIES = [
  ["SOFTWARE\\Policies\\Microsoft\\Windows Defender", "DisableAntiSpyware", 1],
  ["SOFTWARE\\Policies\\Microsoft\\Windows Defender", "DisableAntiVirus", 1],
  ["SOFTWARE\\Policies\\Microsoft\\Windows Defender", "DisableRoutinelyTakingAction", 1],
  ["SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Real-Time Protection", "DisableRealtimeMonitoring", 1],
  ["SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Real-Time Protection", "DisableBehaviorMonitoring", 1],
  ["SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Real-Time Protection", "DisableOnAccessProtection", 1],
  ["SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Real-Time Protection", "DisableScanOnRealtimeEnable", 1],
  ["SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Real-Time Protection", "DisableIOAVProtection", 1],
  ["SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Real-Time Protection", "DisableScriptScanning", 1],
  ["SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Spynet", "SpynetReporting", 0],
  ["SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Spynet", "SubmitSamplesConsent", 2],
  ["SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Spynet", "DisableBlockAtFirstSeen", 1],
  ["SOFTWARE\\Policies\\Microsoft\\Windows Defender\\MpEngine", "MpEnablePus", 0],
  ["SOFTWARE\\Policies\\Microsoft\\Windows\\System", "EnableSmartScreen", 0],
];

// Microsoft's attack surface reduction rules. The first three are the
// "standard protection" rules Microsoft recommends blocking everywhere; the
// others can stop Office macros or tools some offices rely on, so "standard"
// only audits them (Defender logs what it would have blocked).
export const ASR_RULES = [
  ["56a863a9-875e-4185-98a7-b882c64b5ce5", "Block abuse of exploited vulnerable signed drivers", true],
  ["9e6c4e1f-7d60-472f-ba1a-a39ef669e4b2", "Block credential stealing from LSASS", true],
  ["e6db77e5-3df2-4cf1-b95a-636979351e5b", "Block persistence through WMI event subscription", true],
  ["be9ba2d9-53ea-4cdc-84e5-9b1eeee46550", "Block executable content from email client and webmail", false],
  ["d4f940ab-401b-4efc-aadc-ad5f3c50688a", "Block Office applications from creating child processes", false],
  ["3b576869-a4ec-4529-8536-b80a7769e899", "Block Office applications from creating executable content", false],
  ["75668c1f-73b5-4cf0-bb93-3ecf5cb7cc84", "Block Office applications from injecting code into other processes", false],
  ["92e97fa1-2edf-4476-bdd6-9dd0b4dddc7b", "Block Win32 API calls from Office macros", false],
  ["d3e037e1-3eb8-44c8-a917-57927947596d", "Block JavaScript or VBScript from launching downloaded executable content", false],
  ["5beb7efe-fd9a-4556-801d-275e5ffc04cc", "Block execution of potentially obfuscated scripts", false],
  ["b2b3f03d-6a65-4f7b-a9c7-1c7ef74a9ba4", "Block untrusted and unsigned processes that run from USB", false],
  ["7674ba52-37eb-4a4f-a9a1-f0f9a1619a2c", "Block Adobe Reader from creating child processes", false],
  ["c1db55ab-c21a-4637-bb3f-a12568109d35", "Use advanced protection against ransomware", false],
];
export const ASR_MODES = { off: "Leave as they are", audit: "Audit only (log, block nothing)", standard: "Standard: block the 3 safe rules, audit the rest", block: "Block all (can stop Office macros)" };

const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** The baseline. options: { asr: off|audit|standard|block, controlled_folders: bool } */
export function baselineScript(o = {}) {
  const asr = ASR_MODES[o.asr] ? o.asr : "standard";
  const policies = DEFENDER_OFF_POLICIES.map(([k, n, v]) => `@(${psq(k)}, ${psq(n)}, ${v})`).join(",\n  ");
  const rules =
    asr === "off"
      ? ""
      : ASR_RULES.map(([id, , std]) => {
          const action = asr === "audit" ? "AuditMode" : asr === "block" || std ? "Enabled" : "AuditMode";
          return `@(${psq(id)}, ${psq(action)})`;
        }).join(",\n  ");
  return String.raw`[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
${REG}
$changed = 0; $problems = 0; $restart = $false
function Ok($t) { '[ok]   ' + $t }
function Fixed($t) { $script:changed++; '[set]  ' + $t }
function Problem($t) { $script:problems++; '[FAIL] ' + $t }
function Info($t) { '[info] ' + $t }

# --- Microsoft Defender ---
${AV}
foreach ($p in @(
  ${policies}
)) { if ((Get-Reg $p[0] $p[1]) -eq $p[2]) { [void](Remove-Reg $p[0] $p[1]); Fixed ('removed policy ' + $p[1] + '=' + $p[2] + ' that turned protection off') } }
if (-not $mp) { Problem 'Microsoft Defender is not available on this PC (Get-MpComputerStatus failed).' }
elseif (-not $defenderActive) {
  Info ('Defender is in ' + $mp.AMRunningMode + ' mode; the active antivirus is ' + $(if ($otherAv.Count) { $otherAv -join ', ' } else { 'another product' }) + '. Defender settings left alone.')
} else {
  $want = [ordered]@{
    DisableRealtimeMonitoring = $false; DisableBehaviorMonitoring = $false; DisableIOAVProtection = $false
    DisableScriptScanning = $false; DisableBlockAtFirstSeen = $false; DisableArchiveScanning = $false
    DisableEmailScanning = $false; DisableRemovableDriveScanning = $false
    MAPSReporting = 2; SubmitSamplesConsent = 1; PUAProtection = 1; EnableNetworkProtection = 1; CloudBlockLevel = 2
  }
  $pref = Get-MpPreference
  foreach ($k in $want.Keys) {
    $cur = $pref.$k
    if ($null -ne $cur -and [string]$cur -eq [string]$want[$k]) { continue }
    $arg = @{ $k = $want[$k] }
    try { Set-MpPreference @arg -ErrorAction Stop; Fixed ('Defender ' + $k + ' = ' + $want[$k]) }
    catch { Problem ('Defender ' + $k + ': ' + $_.Exception.Message.Trim()) }
  }
${o.controlled_folders ? `  if ($pref.EnableControlledFolderAccess -ne 1) { try { Set-MpPreference -EnableControlledFolderAccess Enabled; Fixed 'Controlled folder access on' } catch { Problem ('Controlled folder access: ' + $_.Exception.Message.Trim()) } }` : "  # Controlled folder access: not changed (option off)."}
${rules ? `  $rules = @(
  ${rules}
  )
  $ids = @($pref.AttackSurfaceReductionRules_Ids); $acts = @($pref.AttackSurfaceReductionRules_Actions)
  $n = 0
  foreach ($r in $rules) {
    $i = [array]::IndexOf(@($ids | ForEach-Object { ([string]$_).ToLower() }), $r[0])
    $code = @{ Enabled = 1; AuditMode = 2 }[$r[1]]
    if ($i -ge 0 -and [int]$acts[$i] -eq $code) { continue }
    try { Add-MpPreference -AttackSurfaceReductionRules_Ids $r[0] -AttackSurfaceReductionRules_Actions $r[1] -ErrorAction Stop; $n++ }
    catch { Problem ('ASR rule ' + $r[0] + ': ' + $_.Exception.Message.Trim()) }
  }
  if ($n) { Fixed ('attack surface reduction: ' + $n + ' rule(s) set (${asr})') } else { Ok 'attack surface reduction rules (${asr})' }` : "  # Attack surface reduction rules: not changed."}
  try { Update-MpSignature -ErrorAction Stop; Ok 'Defender signatures updated' } catch { Info ('signature update failed: ' + $_.Exception.Message.Trim()) }
  $mp = Get-MpComputerStatus
  if ($mp.RealTimeProtectionEnabled) { Ok 'real-time protection on' } else { Problem 'real-time protection is still OFF (Tamper Protection or a policy may block the change)' }
  if ($mp.IsTamperProtected) { Ok 'Tamper Protection on' } else { Info 'Tamper Protection is off - turn it on in Windows Security (it cannot be set by script)' }
}

# --- Firewall ---
foreach ($f in Get-NetFirewallProfile) {
  if ($f.Enabled) { continue }
  try { Set-NetFirewallProfile -Name $f.Name -Enabled True -ErrorAction Stop; Fixed ('firewall on for the ' + $f.Name + ' profile') }
  catch { Problem ('firewall ' + $f.Name + ': ' + $_.Exception.Message.Trim()) }
}
foreach ($pn in @('DomainProfile', 'StandardProfile', 'PublicProfile')) {
  if ((Get-Reg ('SOFTWARE\Policies\Microsoft\WindowsFirewall\' + $pn) 'EnableFirewall') -eq 0) { Problem ('a policy turns the firewall off (' + $pn + ') - fix it in group policy') }
}

# --- SmartScreen ---
if ((Get-Reg 'SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer' 'SmartScreenEnabled') -ne 'Warn') {
  [void](Set-Reg 'SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer' 'SmartScreenEnabled' 'Warn' 'String'); Fixed 'SmartScreen for apps and files: warn'
}
if (Set-Reg 'SOFTWARE\Policies\Microsoft\Edge' 'SmartScreenEnabled' 1) { Fixed 'Edge SmartScreen on' }
if (Set-Reg 'SOFTWARE\Policies\Microsoft\Edge' 'SmartScreenPuaEnabled' 1) { Fixed 'Edge blocks potentially unwanted apps' }

# --- UAC ---
$sys = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
if (Set-Reg $sys 'EnableLUA' 1) { Fixed 'UAC turned back on'; $restart = $true }
if ((Get-Reg $sys 'ConsentPromptBehaviorAdmin') -eq 0) { [void](Set-Reg $sys 'ConsentPromptBehaviorAdmin' 5); Fixed 'UAC asks administrators again (was: never notify)' }
if (Set-Reg $sys 'PromptOnSecureDesktop' 1) { Fixed 'UAC prompt on the secure desktop' }

# --- SMBv1, AutoRun, Guest, Remote Desktop ---
try {
  if ((Get-SmbServerConfiguration).EnableSMB1Protocol) { Set-SmbServerConfiguration -EnableSMB1Protocol $false -Force -Confirm:$false; Fixed 'SMBv1 server off' }
} catch { Info ('SMB settings: ' + $_.Exception.Message.Trim()) }
$exp = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer'
if (Set-Reg $exp 'NoDriveTypeAutoRun' 255) { Fixed 'AutoRun off for all drives' }
if (Set-Reg $exp 'NoAutorun' 1) { Fixed 'AutoPlay does not run programs' }
$guest = Get-LocalUser | Where-Object { $_.SID.Value -match '-501$' }
if ($guest -and $guest.Enabled) { Disable-LocalUser -InputObject $guest; Fixed ('Guest account disabled (' + $guest.Name + ')') }
$rdp = 'SYSTEM\CurrentControlSet\Control\Terminal Server'
if ((Get-Reg $rdp 'fDenyTSConnections') -eq 0 -and (Set-Reg ($rdp + '\WinStations\RDP-Tcp') 'UserAuthentication' 1)) { Fixed 'Remote Desktop requires Network Level Authentication' }

if ($restart) { 'RESTART NEEDED for UAC to take effect.' }
$summary = 'Security baseline: ' + $(if ($changed) { "$changed setting(s) changed" } else { 'everything was already set' }) + $(if ($problems) { ", $problems problem(s) - see details" } else { '' }) + '.'
$summary
exit $(if ($problems) { 1 } else { 0 })`;
}

/** Read-only: what the baseline would change. Exit 1 when something is off. */
export function securityStatusScript() {
  return String.raw`[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
${REG}
$off = @()
function Row($ok, $t) { if ($ok) { '[ok]  ' + $t } else { $script:off += $t; '[OFF] ' + $t } }
${AV}
'Antivirus: ' + $(if ($defenderActive) { 'Microsoft Defender' } elseif ($otherAv.Count) { $otherAv -join ', ' } else { 'NONE FOUND' })
if ($defenderActive) {
  $p = Get-MpPreference
  Row $mp.RealTimeProtectionEnabled 'real-time protection'
  Row $mp.BehaviorMonitorEnabled 'behavior monitoring'
  Row $mp.IoavProtectionEnabled 'scan downloads and attachments'
  Row (-not $p.DisableScriptScanning) 'script scanning'
  Row ($p.MAPSReporting -gt 0) 'cloud-delivered protection'
  Row (-not $p.DisableBlockAtFirstSeen) 'block at first sight'
  Row ($p.SubmitSamplesConsent -in 1, 3) 'automatic sample submission'
  Row ($p.PUAProtection -eq 1) 'potentially unwanted app blocking'
  Row ($p.EnableNetworkProtection -eq 1) 'network protection'
  Row $mp.IsTamperProtected 'Tamper Protection'
  $age = [int]((Get-Date) - $mp.AntivirusSignatureLastUpdated).TotalDays
  Row ($age -le 3) ('signatures ' + $age + ' day(s) old')
  'ASR rules set: ' + @($p.AttackSurfaceReductionRules_Ids).Where({ $_ }).Count + '; controlled folder access: ' + $(if ($p.EnableControlledFolderAccess -eq 1) { 'on' } else { 'off' })
} elseif (-not $otherAv.Count) { $off += 'antivirus' }
foreach ($f in Get-NetFirewallProfile) { Row $f.Enabled ('firewall (' + $f.Name + ')') }
Row ((Get-Reg 'SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer' 'SmartScreenEnabled') -ne 'Off' -and (Get-Reg 'SOFTWARE\Policies\Microsoft\Windows\System' 'EnableSmartScreen') -ne 0) 'SmartScreen'
Row ((Get-Reg 'SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' 'EnableLUA') -ne 0 -and (Get-Reg 'SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' 'ConsentPromptBehaviorAdmin') -ne 0) 'UAC'
try { Row (-not (Get-SmbServerConfiguration).EnableSMB1Protocol) 'SMBv1 off' } catch {}
Row ((Get-Reg 'SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer' 'NoDriveTypeAutoRun') -eq 255) 'AutoRun off'
$guest = Get-LocalUser | Where-Object { $_.SID.Value -match '-501$' }
Row (-not ($guest -and $guest.Enabled)) 'Guest account disabled'
try { $bl = Get-BitLockerVolume -MountPoint $env:SystemDrive -ErrorAction Stop; 'BitLocker on ' + $env:SystemDrive + ': ' + $bl.ProtectionStatus } catch {}
if ($off.Count) { 'Off: ' + ($off -join ', '); exit 1 } else { 'All checked protections are on.' }`;
}

/** Repair Windows Update: services, blocking policies, caches. */
export function repairUpdatesScript() {
  return String.raw`[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
${REG}
$fixed = 0
foreach ($n in @('wuauserv', 'BITS', 'CryptSvc', 'TrustedInstaller', 'UsoSvc', 'DoSvc')) {
  $s = Get-Service -Name $n -ErrorAction SilentlyContinue
  if (-not $s) { continue }
  if ([string]$s.StartType -eq 'Disabled') {
    & sc.exe config $n start= demand | Out-Null
    if ($LASTEXITCODE -eq 0) { $fixed++; 'Service ' + $n + ' was disabled - set to manual start.' } else { 'Service ' + $n + ': could not re-enable (sc.exe exit ' + $LASTEXITCODE + ').' }
  }
}
# Policies that cut Windows Update off. Left alone on domain PCs: there they
# come from group policy, which would put them back.
$domain = (Get-CimInstance Win32_ComputerSystem).PartOfDomain
$wu = 'SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate'
foreach ($v in @('DisableWindowsUpdateAccess', 'DoNotConnectToWindowsUpdateInternetLocations', 'SetDisableUXWUAccess')) {
  if ((Get-Reg $wu $v) -eq 1) {
    if ($domain) { 'Policy ' + $v + '=1 blocks Windows Update; this PC is in a domain - change it in group policy.' }
    else { [void](Remove-Reg $wu $v); $fixed++; 'Removed policy ' + $v + ' that blocked Windows Update.' }
  }
}
if ((Get-Reg ($wu + '\AU') 'NoAutoUpdate') -eq 1 -and -not $domain) { [void](Remove-Reg ($wu + '\AU') 'NoAutoUpdate'); $fixed++; 'Removed policy NoAutoUpdate (automatic updates were off).' }
$wsus = Get-Reg $wu 'WUServer'
if ((Get-Reg ($wu + '\AU') 'UseWUServer') -eq 1 -and $wsus) {
  $ok = $false; try { $u = [Uri]$wsus; $c = New-Object Net.Sockets.TcpClient; $ok = $c.ConnectAsync($u.Host, $u.Port).Wait(5000); $c.Close() } catch {}
  if ($ok) { 'Updates come from the WSUS server ' + $wsus + ' (reachable).' }
  elseif ($domain) { 'The WSUS server ' + $wsus + ' does not answer; this PC is in a domain - fix it in group policy.' }
  else { [void](Set-Reg ($wu + '\AU') 'UseWUServer' 0); $fixed++; 'The WSUS server ' + $wsus + ' does not answer - switched this PC to Microsoft Update.' }
}
# Reset the download cache and the catalog database (the usual fix for
# downloads that never finish or 0x80070002 / 0x8024xxxx errors).
'Stopping update services...'
foreach ($n in @('wuauserv', 'BITS', 'CryptSvc', 'UsoSvc')) { Stop-Service -Name $n -Force -ErrorAction SilentlyContinue }
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
foreach ($d in @("$env:windir\SoftwareDistribution", "$env:windir\System32\catroot2")) {
  if (Test-Path $d) {
    try { Rename-Item $d ((Split-Path $d -Leaf) + '.old-' + $stamp) -ErrorAction Stop; $fixed++; 'Reset ' + $d + ' (old copy kept as .old-' + $stamp + ')' }
    catch { 'Could not reset ' + $d + ': ' + $_.Exception.Message.Trim() }
  }
}
# Older copies from earlier repairs.
Get-ChildItem "$env:windir\SoftwareDistribution.old-*", "$env:windir\System32\catroot2.old-*" -Directory -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending | Select-Object -Skip 1 | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
foreach ($n in @('CryptSvc', 'BITS', 'wuauserv')) { Start-Service -Name $n -ErrorAction SilentlyContinue }
$bad = @(foreach ($n in @('wuauserv', 'BITS', 'CryptSvc')) { if ((Get-Service $n).Status -ne 'Running') { $n } })
if ($bad.Count) { 'Not running after the repair: ' + ($bad -join ', '); exit 1 }
# A search proves it works.
try {
  $s = New-Object -ComObject Microsoft.Update.Session; $s.ClientApplicationID = 'FleetView'
  $n = $s.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'").Updates.Count
  'Windows Update repaired' + $(if ($fixed) { " ($fixed fix(es))" } else { '' }) + ' and working: ' + $n + ' update(s) waiting.'
} catch {
  'Windows Update still fails after the repair: ' + $_.Exception.Message.Trim() + ' (0x' + ('{0:X8}' -f $_.Exception.HResult) + '). Run "Repair Windows image (DISM)" next.'
  exit 1
}`;
}

// ---- adblock -----------------------------------------------------------
// Force-installed through browser policies, the way an IT department does it:
// the browsers download the extension from their own stores and keep it
// updated, and users cannot remove it. uBlock Origin Lite for Chrome, Edge and
// Brave (full uBlock Origin no longer runs there), uBlock Origin for Firefox.
export const ADBLOCK = {
  chrome: { key: "SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist", entry: "ddkjiahejlhfcafbddmgiahcphecmpfh;https://clients2.google.com/service/update2/crx", label: "Chrome" },
  edge: { key: "SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist", entry: "cimighlppcgcoapaliogpjjdehbnofhn;https://edge.microsoft.com/extensionwebstorebase/v1/crx", label: "Edge" },
  brave: { key: "SOFTWARE\\Policies\\BraveSoftware\\Brave\\ExtensionInstallForcelist", entry: "ddkjiahejlhfcafbddmgiahcphecmpfh;https://clients2.google.com/service/update2/crx", label: "Brave" },
  firefox: { key: "SOFTWARE\\Policies\\Mozilla\\Firefox\\Extensions\\Install", entry: "https://addons.mozilla.org/firefox/downloads/latest/ublock-origin/latest.xpi", label: "Firefox", lock: ["SOFTWARE\\Policies\\Mozilla\\Firefox\\Extensions\\Locked", "uBlock0@raymondhill.net"] },
};

/** Add (or with remove=true take out) the adblocker in every browser. */
export function adblockScript({ remove = false } = {}) {
  const list = Object.values(ADBLOCK)
    .map((b) => `@(${psq(b.label)}, ${psq(b.key)}, ${psq(b.entry)}, ${psq(b.lock?.[0] ?? "")}, ${psq(b.lock?.[1] ?? "")})`)
    .join(",\n  ");
  return String.raw`[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
${REG}
# Policy lists are values "1", "2", ...: add ours under the next free number,
# never touching entries someone else put there.
function Add-ListEntry($path, $entry) {
  $id = $entry.Split(';')[0]
  $k = $hklm.CreateSubKey($path)
  try {
    $names = @($k.GetValueNames())
    foreach ($n in $names) { if (([string]$k.GetValue($n)).Split(';')[0] -eq $id) { return 'already set' } }
    $i = 1; while ($names -contains [string]$i) { $i++ }
    $k.SetValue([string]$i, $entry, 'String'); return 'added'
  } finally { $k.Close() }
}
function Remove-ListEntry($path, $entry) {
  $id = $entry.Split(';')[0]
  $k = $hklm.OpenSubKey($path, $true); if (-not $k) { return 'not set' }
  try {
    $hit = @($k.GetValueNames() | Where-Object { ([string]$k.GetValue($_)).Split(';')[0] -eq $id })
    foreach ($n in $hit) { $k.DeleteValue($n) }
    if ($hit.Count) { 'removed' } else { 'not set' }
  } finally { $k.Close() }
}
function Test-Browser($label) {
  $pf = @($env:ProgramFiles, ${'${env:ProgramFiles(x86)}'}) | Where-Object { $_ }
  $rel = @{ Chrome = 'Google\Chrome\Application\chrome.exe'; Edge = 'Microsoft\Edge\Application\msedge.exe'; Brave = 'BraveSoftware\Brave-Browser\Application\brave.exe'; Firefox = 'Mozilla Firefox\firefox.exe' }[$label]
  foreach ($p in $pf) { if (Test-Path (Join-Path $p $rel)) { return $true } }
  foreach ($u in Get-ChildItem "$env:SystemDrive\Users" -Directory -ErrorAction SilentlyContinue) {
    if (Test-Path (Join-Path $u.FullName ('AppData\Local\' + $rel))) { return $true }
  }
  return $false
}
$out = @()
foreach ($b in @(
  ${list}
)) {
  $installed = Test-Browser $b[0]
  # Brave has its own blocker: only touched when it is installed.
  if ($b[0] -eq 'Brave' -and -not $installed -and -not ${remove ? "$true" : "$false"}) { continue }
${remove
  ? `  $r = Remove-ListEntry $b[1] $b[2]
  if ($b[3]) { [void](Remove-ListEntry $b[3] $b[4]) }`
  : `  $r = Add-ListEntry $b[1] $b[2]
  if ($b[3]) { [void](Add-ListEntry $b[3] $b[4]) }`}
  $out += $b[0] + ': ' + $r + $(if (-not $installed) { ' (not installed)' } else { '' })
}
$out
'${remove ? "Adblocker policy removed - browsers drop it at their next start" : "Adblocker set for"}: ' + ($out -join '; ') + '${remove ? "" : ". Browsers install it within minutes or at their next start."}'`;
}
