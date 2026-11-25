// Maintenance tasks: ready-made PowerShell the agent runs as SYSTEM, on one PC
// or the whole fleet. Each script prints a short human summary and exits
// non-zero when something needs attention, so Activity shows Done/Failed per PC.

const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

const UTF8 = "[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$ErrorActionPreference = 'Stop'";

// Windows Update Agent COM API: works as SYSTEM, no module to install.
const WU_SEARCH = String.raw`$session = New-Object -ComObject Microsoft.Update.Session
$session.ClientApplicationID = 'FleetView'
$searcher = $session.CreateUpdateSearcher()
$found = $searcher.Search("IsInstalled=0 and IsHidden=0 and Type='Software'").Updates`;

const REBOOT_PENDING = String.raw`function Test-RebootPending {
  (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or
  (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')
}`;

export const TASKS = {
  check_updates: {
    label: "Check for Windows updates",
    group: "Windows Update",
    help: "Lists updates waiting to be installed and whether a restart is pending. Changes nothing.",
    minutes: 30,
    script: () => `${UTF8}
${REBOOT_PENDING}
${WU_SEARCH}
$n = $found.Count
if ($n -eq 0) { 'Up to date - no updates waiting.' } else { "$n update(s) waiting:" }
foreach ($u in $found) { '  - ' + $u.Title + $(if ($u.MsrcSeverity) { ' [' + $u.MsrcSeverity + ']' } else { '' }) }
$last = (Get-HotFix | Where-Object InstalledOn | Sort-Object InstalledOn -Descending | Select-Object -First 1)
if ($last) { 'Last update installed: ' + $last.HotFixID + ' on ' + $last.InstalledOn.ToString('yyyy-MM-dd') }
if (Test-RebootPending) { 'A restart is pending to finish earlier updates.' }
exit $(if ($n -gt 0) { 1 } else { 0 })`,
    // Exit 1 = "updates waiting": shown as Failed so it stands out in a fleet view.
    failMeaning: "updates are waiting (see details)",
  },
  install_updates: {
    label: "Install Windows updates",
    group: "Windows Update",
    help: "Downloads and installs all waiting software updates (no drivers). Does not restart the PC; the result says when a restart is needed.",
    minutes: 180,
    script: () => `${UTF8}
${REBOOT_PENDING}
${WU_SEARCH}
$todo = New-Object -ComObject Microsoft.Update.UpdateColl
foreach ($u in $found) { if (-not $u.EulaAccepted) { $u.AcceptEula() }; [void]$todo.Add($u) }
if ($todo.Count -eq 0) { 'Up to date - nothing to install.'; if (Test-RebootPending) { 'A restart is pending.' }; exit 0 }
"Downloading $($todo.Count) update(s)..."
$dl = $session.CreateUpdateDownloader(); $dl.Updates = $todo; [void]$dl.Download()
$ready = New-Object -ComObject Microsoft.Update.UpdateColl
foreach ($u in $todo) { if ($u.IsDownloaded) { [void]$ready.Add($u) } else { '  not downloaded: ' + $u.Title } }
if ($ready.Count -eq 0) { 'Nothing could be downloaded.'; exit 2 }
"Installing $($ready.Count) update(s)..."
$inst = $session.CreateUpdateInstaller(); $inst.Updates = $ready
$res = $inst.Install()
$codes = @{ 2 = 'installed'; 3 = 'installed with errors'; 4 = 'FAILED'; 5 = 'aborted' }
$failed = 0
for ($i = 0; $i -lt $ready.Count; $i++) {
  $r = $res.GetUpdateResult($i)
  if ($r.ResultCode -ge 4) { $failed++ }
  '  ' + $codes[[int]$r.ResultCode] + ': ' + $ready.Item($i).Title + $(if ($r.HResult) { ' (0x' + ('{0:X8}' -f $r.HResult) + ')' } else { '' })
}
if ($res.RebootRequired -or (Test-RebootPending)) { 'RESTART NEEDED to finish installing.' }
exit $(if ($failed -gt 0) { 1 } else { 0 })`,
  },
  sfc: {
    label: "Check system files (sfc /scannow)",
    group: "Repair",
    help: "Scans protected Windows files and repairs them from the local store. Takes 5–30 minutes. If it can't repair something, run the DISM repair and then this again.",
    minutes: 120,
    script: () => `${UTF8}
$start = Get-Date
# sfc writes UTF-16; read it as such.
[Console]::OutputEncoding = [Text.Encoding]::Unicode
$out = & "$env:windir\\System32\\sfc.exe" /scannow 2>&1 | Out-String
$code = $LASTEXITCODE
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$lines = @($out -split "\`r?\`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -notmatch '^(Verification|Verificare)\\s+\\d+%' })
$lines | Select-Object -Last 6
# CBS.log is English whatever the Windows language: count what sfc did this run.
$cbs = "$env:windir\\Logs\\CBS\\CBS.log"
$since = $start.ToString('yyyy-MM-dd HH:mm:ss')
$sr = @(Get-Content $cbs -ErrorAction SilentlyContinue | Where-Object { $_ -match '\\[SR\\]' -and $_.Substring(0, [Math]::Min(19, $_.Length)) -ge $since })
$bad = @($sr | Where-Object { $_ -match 'Cannot repair member file' }).Count
$fixed = @($sr | Where-Object { $_ -match 'Repairing corrupted file|Repaired file' }).Count
if ($bad) { "Result: $bad file(s) could NOT be repaired - run 'Repair Windows image (DISM)' and then this again."; exit 1 }
elseif ($fixed) { "Result: corrupted files found and repaired ($fixed). A restart is recommended." }
else { 'Result: no integrity violations.' }
exit $(if ($code -gt 1) { $code } else { 0 })`,
  },
  dism: {
    label: "Repair Windows image (DISM)",
    group: "Repair",
    help: "DISM /Online /Cleanup-Image /RestoreHealth: repairs the component store that sfc repairs from (uses Windows Update). 10–40 minutes.",
    minutes: 150,
    script: () => `${UTF8}
$out = & "$env:windir\\System32\\dism.exe" /Online /Cleanup-Image /RestoreHealth /English 2>&1 | Out-String
$code = $LASTEXITCODE
@($out -split "\`r?\`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -notmatch '^\\[=*\\s*[\\d.]+%' }) | Select-Object -Last 6
exit $code`,
  },
  defender_scan: {
    label: "Defender: update + quick scan",
    group: "Security",
    help: "Updates Microsoft Defender signatures, runs a quick scan and lists threats found in the last day.",
    minutes: 90,
    script: () => `${UTF8}
try { Update-MpSignature -ErrorAction Stop; 'Signatures updated.' } catch { 'Signature update failed: ' + $_.Exception.Message }
Start-MpScan -ScanType QuickScan
$st = Get-MpComputerStatus
'Real-time protection: ' + $(if ($st.RealTimeProtectionEnabled) { 'on' } else { 'OFF' }) + '; signatures from ' + $st.AntivirusSignatureLastUpdated.ToString('yyyy-MM-dd')
$t = @(Get-MpThreatDetection | Where-Object { $_.InitialDetectionTime -gt (Get-Date).AddDays(-1) })
if ($t.Count) { "$($t.Count) threat detection(s) in the last day:"; $t | ForEach-Object { '  - ' + $_.ThreatID + ' ' + ($_.Resources -join ', ') }; exit 1 }
'No threats found.'
if (-not $st.RealTimeProtectionEnabled) { exit 1 }`,
  },
  cleanup: {
    label: "Clean up temporary files",
    group: "Maintenance",
    help: "Deletes temp files older than 7 days (Windows and every profile), the Windows Update download cache and the recycle bins. Reports the space freed.",
    minutes: 60,
    script: () => `${UTF8}
$ErrorActionPreference = 'SilentlyContinue'
function Free { (Get-PSDrive -Name ($env:SystemDrive.TrimEnd(':'))).Free }
$before = Free
$cut = (Get-Date).AddDays(-7)
$dirs = @("$env:windir\\Temp") + @(Get-ChildItem "$env:SystemDrive\\Users" -Directory | ForEach-Object { Join-Path $_.FullName 'AppData\\Local\\Temp' })
foreach ($d in $dirs) { if (Test-Path $d) { Get-ChildItem $d -Recurse -Force -File | Where-Object LastWriteTime -lt $cut | Remove-Item -Force } }
Stop-Service wuauserv -Force; Remove-Item "$env:windir\\SoftwareDistribution\\Download\\*" -Recurse -Force; Start-Service wuauserv
Clear-RecycleBin -Force
$freed = (Free) - $before
'Freed ' + [Math]::Round([Math]::Max(0, $freed) / 1MB) + ' MB on ' + $env:SystemDrive + '; ' + [Math]::Round((Free) / 1GB, 1) + ' GB free now.'
exit 0`,
  },
  disk_health: {
    label: "Disk health and space",
    group: "Maintenance",
    help: "Physical disk health (SMART status, wear, errors) and free space per drive. Fails when a disk is unhealthy or a drive has under 10% free.",
    minutes: 10,
    script: () => `${UTF8}
$warn = 0
foreach ($d in Get-PhysicalDisk) {
  $r = $d | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue
  $line = '{0} ({1}, {2} GB): {3}' -f $d.FriendlyName, $d.MediaType, [Math]::Round($d.Size / 1GB), $d.HealthStatus
  if ($r) { $line += $(if ($null -ne $r.Wear) { ', wear ' + $r.Wear + '%' } else { '' }) + $(if ($r.ReadErrorsUncorrected) { ', uncorrected read errors ' + $r.ReadErrorsUncorrected } else { '' }) + $(if ($r.Temperature) { ', ' + $r.Temperature + ' C' } else { '' }) }
  $line
  if ($d.HealthStatus -ne 'Healthy') { $warn++ }
}
foreach ($v in Get-Volume | Where-Object { $_.DriveLetter -and $_.DriveType -eq 'Fixed' -and $_.Size }) {
  $pct = [Math]::Round($v.SizeRemaining / $v.Size * 100)
  '{0}: {1} GB free of {2} GB ({3}%)' -f $v.DriveLetter, [Math]::Round($v.SizeRemaining / 1GB, 1), [Math]::Round($v.Size / 1GB), $pct
  if ($pct -lt 10) { $warn++ }
}
exit $(if ($warn) { 1 } else { 0 })`,
  },
  gpupdate: {
    label: "Refresh group policy",
    group: "Maintenance",
    help: "gpupdate /force (computer policy).",
    minutes: 15,
    script: () => `${UTF8}
$out = & gpupdate.exe /target:computer /force 2>&1 | Out-String
($out -split "\`r?\`n" | Where-Object { $_.Trim() }) -join "\`n"
exit $LASTEXITCODE`,
  },
  agent_config: {
    label: "Show agent settings",
    group: "Maintenance",
    help: "Reads the agent's own settings on each PC (master address, e-Management URL for the MoldSign bridge, version). Changes nothing; never shows the agent's secrets. PCs without an e-Management URL are marked Failed so they stand out — fix them with Agent settings.",
    minutes: 5,
    failMeaning: "no e-Management URL — MoldSign bridge off (use Agent settings)",
    script: () => `${UTF8}
$path = Join-Path $env:ProgramData 'FleetView\\agent.config.json'
if (-not (Test-Path $path)) { 'agent.config.json not found at ' + $path; exit 2 }
$c = Get-Content $path -Raw | ConvertFrom-Json
$exe = Join-Path $env:ProgramFiles 'FleetView Agent\\fleetview-agent.exe'
$ver = if (Test-Path $exe) { (Get-Item $exe).LastWriteTime.ToString('yyyy-MM-dd HH:mm') } else { 'not found' }
'Master address:   ' + $(if ($c.master_address) { $c.master_address } else { '(none - built-in address)' })
'Config changed:   ' + (Get-Item $path).LastWriteTime.ToString('yyyy-MM-dd HH:mm')
'Agent exe:        ' + $ver
# Last line = the summary shown in Activity.
'e-Management URL: ' + $(if ($c.emanagement_url) { $c.emanagement_url } else { '(none - MoldSign bridge off)' })
exit $(if ($c.emanagement_url) { 0 } else { 1 })`,
  },
  flush_dns: {
    label: "Flush DNS cache",
    group: "Network",
    help: "ipconfig /flushdns and /registerdns.",
    minutes: 5,
    script: () => `${UTF8}
Clear-DnsClientCache
& ipconfig.exe /registerdns | Out-Null
'DNS cache flushed and DNS registration refreshed.'`,
  },
  restart: {
    label: "Restart",
    group: "Power",
    help: "Restarts the PC after a warning to the logged-in user. Cancel with “Cancel restart / shutdown”.",
    minutes: 5,
    options: { delay_min: 5, message: "This computer will restart for maintenance. Please save your work." },
    script: (o) => powerScript("/r", o),
  },
  shutdown: {
    label: "Shut down",
    group: "Power",
    help: "Shuts the PC down after a warning to the logged-in user.",
    minutes: 5,
    options: { delay_min: 5, message: "This computer will shut down. Please save your work." },
    script: (o) => powerScript("/s", o),
  },
  cancel_power: {
    label: "Cancel restart / shutdown",
    group: "Power",
    help: "Cancels a pending restart or shutdown (shutdown /a).",
    minutes: 5,
    script: () => `& shutdown.exe /a 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { 'Pending restart/shutdown cancelled.' } else { 'Nothing to cancel.' }
exit 0`,
  },
};

function powerScript(flag, o = {}) {
  const delay = Math.max(0, Math.min(600, Math.round(Number(o.delay_min ?? 5)))) * 60;
  const msg = String(o.message ?? "").replace(/[\r\n"]/g, " ").slice(0, 500);
  return `${UTF8}
& shutdown.exe ${flag} /f /t ${delay} /d p:0:0 /c ${psq(msg || "FleetView maintenance")}
if ($LASTEXITCODE -ne 0) { 'shutdown.exe failed with ' + $LASTEXITCODE + ' (another restart may already be scheduled)'; exit $LASTEXITCODE }
'${flag === "/r" ? "Restart" : "Shutdown"} in ${delay / 60} min.'`;
}

/** The script + time limit for a task, or throws. */
export function taskScript(id, options = {}) {
  const t = TASKS[id];
  if (!t) throw new Error("unknown task");
  return {
    script: `# FleetView task: ${t.label}\n${t.script({ ...(t.options ?? {}), ...options })}`,
    minutes: t.minutes,
  };
}

/** Task list for the UI (no scripts). */
export function taskCatalog() {
  return Object.entries(TASKS).map(([id, t]) => ({ id, label: t.label, group: t.group, help: t.help, minutes: t.minutes, options: t.options ?? null, fail_meaning: t.failMeaning ?? null }));
}
