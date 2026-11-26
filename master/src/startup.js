// Startup apps on the PCs: what starts when Windows boots or a user signs in.
//
// Listed (as SYSTEM, through RunPowerShell):
//   * Run / RunOnce keys: HKLM, HKLM\SOFTWARE\WOW6432Node, and every user
//     hive loaded under HKU (users that are signed in, plus any hive Windows
//     keeps loaded). Users that are signed out are not readable without
//     loading their NTUSER.DAT, which we don't do: it can break their next
//     sign-in if it happens while the hive is loaded.
//   * Startup folders: the common one and every user profile's.
//   * Scheduled tasks with a logon or boot trigger.
//
// Disabling/enabling works like Task Manager: Run entries and Startup-folder
// items stay where they are and get a value under
//   ...\Explorer\StartupApproved\{Run, Run32, StartupFolder}
// whose first byte is even (enabled, 02) or odd (disabled, 03 + a FILETIME).
// Explorer honours it at sign-in. Scheduled tasks are enabled/disabled with
// Enable-/Disable-ScheduledTask. RunOnce entries can't be disabled.
//
// The registry is opened in its 64-bit view whatever the PowerShell bitness,
// and keys are created with RegistryKey.CreateSubKey (New-Item -Force would
// wipe an existing key's values). Generated PowerShell is ASCII only.

const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

export const KINDS = { run: "Registry Run", runonce: "Registry RunOnce", folder: "Startup folder", task: "Scheduled task" };

const COMMON = String.raw`[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$hklm = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64')
$hku = [Microsoft.Win32.RegistryKey]::OpenBaseKey('Users', 'Registry64')
$runKey = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
$run32Key = 'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'
$approvedKey = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved'
$startupRel = 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup'
$commonStartup = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\StartUp'
# Local and Entra ID (Azure AD) users; not the _Classes hives.
$userSidRe = '^S-1-(5-21|12-1)-[0-9-]+$'
function Get-LoadedSids { @($hku.GetSubKeyNames() | Where-Object { $_ -match $userSidRe }) }
function Get-UserName($sid) {
  try { (New-Object System.Security.Principal.SecurityIdentifier($sid)).Translate([System.Security.Principal.NTAccount]).Value } catch { $sid }
}
function Get-Profiles {
  $pl = $hklm.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList')
  foreach ($sid in @($pl.GetSubKeyNames() | Where-Object { $_ -match $userSidRe })) {
    $p = $pl.OpenSubKey($sid).GetValue('ProfileImagePath')
    if ($p) { [pscustomobject]@{ sid = $sid; path = [Environment]::ExpandEnvironmentVariables($p) } }
  }
}`;

/** Script that prints every startup entry on the PC as JSON. */
export function listScript() {
  return `# FleetView: list startup apps
${COMMON}
$out = New-Object System.Collections.ArrayList
# $true / $false from a StartupApproved value; $true when there is none.
function Get-Approved($base, $prefix, $sub, $name) {
  $k = $base.OpenSubKey($prefix + $approvedKey + '\\' + $sub)
  if (-not $k) { return $true }
  $v = $k.GetValue($name)
  if ($v -is [byte[]] -and $v.Length -gt 0) { return (($v[0] -band 1) -eq 0) }
  return $true
}
function Add-Entry($h) { [void]$out.Add([pscustomobject]$h) }
function Add-RunKey($base, $prefix, $key, $approvedSub, $scope, $sid, $user, $hive) {
  foreach ($once in @($false, $true)) {
    $path = $key + $(if ($once) { 'Once' } else { '' })
    $k = $base.OpenSubKey($prefix + $path)
    if (-not $k) { continue }
    foreach ($n in $k.GetValueNames()) {
      if ($n -eq '') { continue }
      $cmd = [string]$k.GetValue($n, $null, 'DoNotExpandEnvironmentNames')
      Add-Entry @{
        kind = $(if ($once) { 'runonce' } else { 'run' }); scope = $scope; sid = $sid; user = $user; name = $n; command = $cmd
        location = $hive + '\\' + $path
        enabled = $(if ($once) { $true } else { Get-Approved $base $prefix $approvedSub $n })
        can_toggle = (-not $once)
      }
    }
  }
}
function Get-LinkTarget($file) {
  if ($file.Extension -ne '.lnk') { return $file.FullName }
  try {
    $s = (New-Object -ComObject WScript.Shell).CreateShortcut($file.FullName)
    return ('"' + $s.TargetPath + '" ' + $s.Arguments).Trim()
  } catch { return $file.FullName }
}
function Add-Folder($dir, $scope, $sid, $user, $approvedBase, $approvedPrefix) {
  if (-not (Test-Path -LiteralPath $dir)) { return }
  foreach ($f in @(Get-ChildItem -LiteralPath $dir -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'desktop.ini' })) {
    $known = $null -ne $approvedBase
    Add-Entry @{
      kind = 'folder'; scope = $scope; sid = $sid; user = $user; name = $f.Name; command = (Get-LinkTarget $f); location = $dir
      enabled = $(if ($known) { Get-Approved $approvedBase $approvedPrefix 'StartupFolder' $f.Name } else { $null })
      can_toggle = $known
    }
  }
}

Add-RunKey $hklm '' $runKey 'Run' 'machine' $null $null 'HKLM'
Add-RunKey $hklm '' $run32Key 'Run32' 'machine32' $null $null 'HKLM'
$loaded = Get-LoadedSids
foreach ($sid in $loaded) { Add-RunKey $hku ($sid + '\\') $runKey 'Run' 'user' $sid (Get-UserName $sid) 'HKU' }
Add-Folder $commonStartup 'machine' $null $null $hklm ''
foreach ($p in @(Get-Profiles)) {
  $isLoaded = $loaded -contains $p.sid
  Add-Folder (Join-Path $p.path $startupRel) 'user' $p.sid (Get-UserName $p.sid) $(if ($isLoaded) { $hku } else { $null }) ($p.sid + '\\')
}
try {
  foreach ($t in @(Get-ScheduledTask -ErrorAction Stop)) {
    $trig = @($t.Triggers | Where-Object { $_ -and ($_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -or $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger') })
    if (-not $trig.Count) { continue }
    $cmd = (@($t.Actions | ForEach-Object { if ($_.Execute) { ('"' + $_.Execute + '" ' + $_.Arguments).Trim() } else { '(COM handler)' } }) -join '; ')
    Add-Entry @{
      kind = 'task'; scope = 'machine'; sid = $null; user = [string]$t.Principal.UserId; name = $t.TaskName; task_path = $t.TaskPath; command = $cmd
      location = 'Task Scheduler ' + $t.TaskPath
      trigger = $(if (@($trig | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' }).Count) { 'boot' } else { 'logon' })
      enabled = ([string]$t.State -ne 'Disabled'); can_toggle = $true
      microsoft = ($t.TaskPath -like '\\Microsoft\\*')
    }
  }
} catch { }
ConvertTo-Json -InputObject @($out) -Compress -Depth 3`;
}

/** Stable key for one entry, the same on every PC (user entries ignore the SID). */
export function entryKey(e) {
  const scope = e.scope === "user" ? "user" : e.scope;
  return [e.kind, scope, String(e.name ?? "").toLowerCase(), String(e.task_path ?? "").toLowerCase()].join("|");
}

/** Parse the list script's output into a sorted list. */
export function parseList(stdout) {
  const text = String(stdout ?? "").trim();
  // PowerShell may unwrap a one-item array into the object itself.
  const start = text.search(/[[{]/);
  if (start < 0) {
    if (!text || text === "null") return [];
    throw new Error("no startup list in the PC's answer");
  }
  const raw = JSON.parse(text.slice(start));
  const list = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map((e) => ({
    key: entryKey(e),
    kind: e.kind,
    scope: e.scope,
    sid: e.sid ?? null,
    user: e.user || null,
    name: String(e.name ?? ""),
    task_path: e.task_path ?? null,
    command: String(e.command ?? ""),
    location: String(e.location ?? ""),
    trigger: e.trigger ?? null,
    enabled: e.enabled === null || e.enabled === undefined ? null : !!e.enabled,
    can_toggle: !!e.can_toggle,
    microsoft: !!e.microsoft,
  }));
  const order = { run: 0, folder: 1, runonce: 2, task: 3 };
  return list.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name) || String(a.user).localeCompare(String(b.user)));
}

/** Validate a toggle request; returns a clean payload or throws. */
export function validateToggle(p) {
  const kind = String(p?.kind ?? "");
  const scope = String(p?.scope ?? "");
  const name = String(p?.name ?? "");
  if (!["run", "folder", "task"].includes(kind)) throw new Error(kind === "runonce" ? "RunOnce entries can't be disabled" : "unknown startup entry type");
  if (!name || name.length > 260 || /[\r\n\0]/.test(name)) throw new Error("invalid entry name");
  const valid = { run: ["machine", "machine32", "user"], folder: ["machine", "user"], task: ["machine"] }[kind];
  if (!valid.includes(scope)) throw new Error("invalid entry scope");
  const sid = p.sid == null || p.sid === "" ? null : String(p.sid);
  if (sid && !/^S-1-[0-9-]+$/.test(sid)) throw new Error("invalid user SID");
  let taskPath = null;
  if (kind === "task") {
    taskPath = String(p.task_path ?? "\\");
    if (!/^\\([^\r\n\0]*\\)?$/.test(taskPath) || taskPath.length > 500) throw new Error("invalid task path");
  }
  return { kind, scope, sid: scope === "user" ? sid : null, name, task_path: taskPath, enable: !!p.enable };
}

/** Script that enables/disables one startup entry. */
export function toggleScript(raw) {
  const p = validateToggle(raw);
  const verb = p.enable ? "enable" : "disable";
  const head = `# FleetView: ${verb} startup entry (${p.kind})
${COMMON}
$name = ${psq(p.name)}
$enable = $${p.enable}`;
  if (p.kind === "task") {
    return `${head}
$t = Get-ScheduledTask -TaskPath ${psq(p.task_path)} -TaskName $name
if ($enable) { [void]($t | Enable-ScheduledTask) } else { [void]($t | Disable-ScheduledTask) }
$(if ($enable) { 'Enabled' } else { 'Disabled' }) + ' scheduled task ' + $t.TaskPath + $t.TaskName`;
  }
  // Every place to write: base key + prefix + StartupApproved subkey.
  let where;
  if (p.scope === "machine" || p.scope === "machine32") {
    const check =
      p.kind === "run"
        ? `$k = $hklm.OpenSubKey(${p.scope === "machine" ? "$runKey" : "$run32Key"})
$found = $k -and ($k.GetValueNames() -contains $name)`
        : `$found = Test-Path -LiteralPath (Join-Path $commonStartup $name)`;
    where = `$places = @()
${check}
if ($found) { $places += ,@($hklm, '', '${p.kind === "run" ? (p.scope === "machine" ? "Run" : "Run32") : "StartupFolder"}', 'all users') }`;
  } else {
    const sids = p.sid ? `@(${psq(p.sid)})` : "Get-LoadedSids";
    const check =
      p.kind === "run"
        ? `$k = $hku.OpenSubKey($sid + '\\' + $runKey)
  $found = $k -and ($k.GetValueNames() -contains $name)`
        : `$prof = @(Get-Profiles | Where-Object { $_.sid -eq $sid })[0]
  $found = $prof -and (Test-Path -LiteralPath (Join-Path (Join-Path $prof.path $startupRel) $name))`;
    where = `$loaded = Get-LoadedSids
$places = @()
foreach ($sid in @(${sids})) {
  if ($loaded -notcontains $sid) { 'Skipped ' + (Get-UserName $sid) + ': not signed in (their settings are not loaded)'; continue }
  ${check}
  if ($found) { $places += ,@($hku, ($sid + '\\'), '${p.kind === "run" ? "Run" : "StartupFolder"}', (Get-UserName $sid)) }
}`;
  }
  return `${head}
${where}
if (-not $places.Count) { throw ('Startup entry ' + $name + ' was not found on this PC.') }
if ($enable) { $bytes = [byte[]](2,0,0,0,0,0,0,0,0,0,0,0) }
else { $bytes = [byte[]](@(3,0,0,0) + [BitConverter]::GetBytes([DateTime]::UtcNow.ToFileTimeUtc())) }
foreach ($pl in $places) {
  $k = $pl[0].CreateSubKey($pl[1] + $approvedKey + '\\' + $pl[2])
  $k.SetValue($name, $bytes, [Microsoft.Win32.RegistryValueKind]::Binary)
  $k.Close()
  $(if ($enable) { 'Enabled ' } else { 'Disabled ' }) + $name + ' for ' + $pl[3]
}`;
}

/** Update a cached list after a toggle succeeded on the PC. */
export function applyToggle(list, raw) {
  if (!Array.isArray(list)) return false;
  let p;
  try {
    p = validateToggle(raw);
  } catch {
    return false;
  }
  let n = 0;
  for (const e of list) {
    if (e.kind !== p.kind || e.scope !== p.scope || e.name !== p.name || !e.can_toggle) continue;
    if (p.kind === "task" && e.task_path !== p.task_path) continue;
    if (p.scope === "user" && p.sid && e.sid !== p.sid) continue;
    e.enabled = p.enable;
    n++;
  }
  return n > 0;
}

/** Title shown in Activity. */
export function toggleTitle(p) {
  return `${p.enable ? "Enable" : "Disable"} startup: ${p.name}${p.kind === "task" ? " (task)" : ""}`;
}

/**
 * Fleet view: which startup entries appear on how many PCs.
 * `agents` = [{ agent_id, hostname, startup, startup_at }].
 */
export function fleetSummary(agents) {
  const map = new Map();
  let scanned = 0;
  for (const a of agents) {
    if (!Array.isArray(a.startup)) continue;
    scanned++;
    const seen = new Set();
    for (const e of a.startup) {
      if (seen.has(e.key)) {
        // Same entry for two users of one PC: count the PC once, enabled if any is.
        const row = map.get(e.key);
        const pc = row.pcs.find((x) => x.id === a.agent_id);
        if (pc && e.enabled) pc.enabled = true;
        continue;
      }
      seen.add(e.key);
      let row = map.get(e.key);
      if (!row) {
        row = { key: e.key, kind: e.kind, scope: e.scope, name: e.name, task_path: e.task_path, microsoft: e.microsoft, can_toggle: false, commands: new Map(), pcs: [] };
        map.set(e.key, row);
      }
      row.can_toggle ||= e.can_toggle;
      row.commands.set(e.command, (row.commands.get(e.command) ?? 0) + 1);
      row.pcs.push({ id: a.agent_id, hostname: a.hostname, enabled: e.enabled });
    }
  }
  const rows = [...map.values()].map((r) => {
    const cmd = [...r.commands.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? "";
    const { commands, ...rest } = r;
    return { ...rest, command: cmd, variants: commands.size, count: r.pcs.length, enabled_count: r.pcs.filter((x) => x.enabled !== false).length };
  });
  rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { scanned, entries: rows };
}
