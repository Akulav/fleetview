// Installer files: type detection, silent-switch presets, argument parsing,
// and the uploaded-installer library kept on the master.

import crypto from "node:crypto";
import { createWriteStream, mkdirSync, openSync, readSync, closeSync, rmSync, renameSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { JsonFile } from "./store.js";

/** Silent-install presets. `args` is the command line after the file name. */
export const PRESETS = {
  msi: { label: "MSI (Windows Installer)", args: "/qn /norestart", isMsi: true },
  inno: { label: "Inno Setup", args: "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-", isMsi: false },
  nsis: { label: "NSIS", args: "/S", isMsi: false },
  wix: { label: "WiX bundle", args: "/quiet /norestart", isMsi: false },
  installshield: { label: "InstallShield", args: "/s /v/qn", isMsi: false },
  advanced: { label: "Advanced Installer", args: "/exenoui /qn /norestart", isMsi: false },
  squirrel: { label: "Squirrel (per-user)", args: "--silent", isMsi: false },
  custom: { label: "Custom", args: "", isMsi: false },
};

export const WARNINGS = {
  custom: "Unknown installer type: enter the vendor's silent switch. A wrong switch makes the installer wait for a click nobody can give, until the 60-minute timeout.",
  squirrel: "Squirrel installers install per user; run as SYSTEM they land in the system profile. Prefer the vendor's MSI or machine-wide installer.",
};

const SCAN_BYTES = 8 * 1024 * 1024;

/** Detect the installer framework from the file name and its first bytes. */
export function detectKind(fileName, head) {
  if (/\.msi$/i.test(fileName)) return "msi";
  const has = (s) => head.includes(Buffer.from(s, "latin1"));
  const has16 = (s) => head.includes(Buffer.from(s, "utf16le"));
  // Most specific first: bundles embed the names of what they wrap.
  if (has(".wixburn")) return "wix";
  if (has("Inno Setup")) return "inno";
  if (has("Nullsoft") || has("NullsoftInst")) return "nsis";
  if (has("Advanced Installer") || has16("Advanced Installer")) return "advanced";
  if (has("InstallShield") || has16("InstallShield")) return "installshield";
  if (has("Squirrel") && has("Update.exe")) return "squirrel";
  if (has16("Inno Setup")) return "inno";
  return "custom";
}

export function detectFile(path, fileName) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(SCAN_BYTES, statSync(path).size));
    readSync(fd, buf, 0, buf.length, 0);
    return detectKind(fileName, buf);
  } finally {
    closeSync(fd);
  }
}

/** Split a command line into arguments: whitespace separates, double quotes
 * group (and are removed), so `/D="C:\Program Files\X"` stays one argument.
 * The agent re-quotes arguments that contain spaces. */
export function splitArgs(s) {
  const out = [];
  let cur = "";
  let quoted = false;
  let any = false;
  for (const ch of String(s ?? "")) {
    if (ch === '"') {
      quoted = !quoted;
      any = true;
    } else if (/\s/.test(ch) && !quoted) {
      if (any) out.push(cur);
      cur = "";
      any = false;
    } else {
      cur += ch;
      any = true;
    }
  }
  if (any) out.push(cur);
  return out;
}

/** A file name that is safe on Windows (the agent sanitizes too). */
export function safeFileName(name) {
  let n = String(name ?? "").split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/^[. ]+|[. ]+$/g, "");
  if (!n) n = "installer.exe";
  return n.slice(0, 180);
}

/** Uploaded installers, stored under <data>/installers/<id>/<file>. */
export class InstallerLibrary {
  constructor(dataDir) {
    this.dir = join(dataDir, "installers");
    mkdirSync(this.dir, { recursive: true });
    this.file = new JsonFile(join(dataDir, "installers.json"), []);
  }
  list() {
    return this.file.value;
  }
  get(id) {
    return this.file.value.find((x) => x.id === id) ?? null;
  }
  path(item) {
    return join(this.dir, item.id, item.file_name);
  }
  /** Stream an upload to disk, hashing as it goes. Rejects above maxBytes. */
  async add(stream, fileName, maxBytes) {
    const id = crypto.randomBytes(8).toString("hex");
    const name = safeFileName(fileName);
    const dir = join(this.dir, id);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, ".upload");
    const hash = crypto.createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) return cb(new Error(`file is larger than ${Math.round(maxBytes / 1048576)} MB`));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(stream, meter, createWriteStream(tmp));
      if (size === 0) throw new Error("empty file");
      renameSync(tmp, join(dir, name));
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    const sha256 = hash.digest("hex");
    // Same bytes uploaded again: keep the existing entry (and its settings).
    const dup = this.file.value.find((x) => x.sha256 === sha256 && x.file_name === name);
    if (dup) {
      rmSync(dir, { recursive: true, force: true });
      return { item: dup, duplicate: true };
    }
    const kind = detectFile(join(dir, name), name);
    const preset = PRESETS[kind];
    const item = {
      id,
      file_name: name,
      size,
      sha256,
      kind,
      kind_label: preset.label,
      args: preset.args,
      is_msi: preset.isMsi,
      uploaded_at: new Date().toISOString(),
    };
    this.file.value.unshift(item);
    this.file.flush();
    return { item, duplicate: false };
  }
  update(id, patch) {
    const item = this.get(id);
    if (!item) return null;
    if (typeof patch.args === "string") item.args = patch.args.trim();
    if (typeof patch.is_msi === "boolean") item.is_msi = patch.is_msi;
    if (typeof patch.kind === "string" && PRESETS[patch.kind]) {
      item.kind = patch.kind;
      item.kind_label = PRESETS[patch.kind].label;
    }
    this.file.flush();
    return item;
  }
  remove(id) {
    const i = this.file.value.findIndex((x) => x.id === id);
    if (i < 0) return false;
    rmSync(join(this.dir, id), { recursive: true, force: true });
    this.file.value.splice(i, 1);
    this.file.flush();
    return true;
  }
  exists(item) {
    return existsSync(this.path(item));
  }
}

// ---- uninstall ------------------------------------------------------------

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Split an UninstallString into [exe, rest]. */
export function splitCommand(cmd) {
  cmd = String(cmd ?? "").trim();
  if (cmd.startsWith('"')) {
    const end = cmd.indexOf('"', 1);
    return end > 0 ? [cmd.slice(1, end), cmd.slice(end + 1).trim()] : [cmd.slice(1), ""];
  }
  const i = cmd.toLowerCase().indexOf(".exe");
  if (i >= 0) return [cmd.slice(0, i + 4), cmd.slice(i + 4).trim()];
  const sp = cmd.indexOf(" ");
  return sp < 0 ? [cmd, ""] : [cmd.slice(0, sp), cmd.slice(sp + 1).trim()];
}

/** Uninstallers whose silent switch isn't one of the usual ones (by exe name). */
const SILENT_RULES = [
  // AnyDesk: --uninstall opens a confirmation window, which hangs as SYSTEM.
  [/^anydesk/i, () => "--silent --remove"],
];

/** Chromium-style installers (Chrome, Edge, Copilot, Brave, Opera, WebView2…)
 * whatever their exe is called: `--uninstall` needs `--force-uninstall` to
 * run without asking, and never takes /S. */
const isChromiumUninstall = (args) => /(^|\s)--uninstall(\s|$)/i.test(args);

/** The silent form of an UninstallString: { file, args }. */
export function silentCommand(uninstall) {
  const [exe, rest] = splitCommand(uninstall);
  const exeName = exe.split(/[\\/]/).pop().toLowerCase();
  let file = exe;
  let args = rest;
  const rule = SILENT_RULES.find(([re]) => re.test(exeName));
  if (exeName.startsWith("msiexec")) {
    file = "msiexec.exe";
    const m = /\{[0-9A-Fa-f-]+\}/.exec(uninstall);
    if (m) args = `/X ${m[0]} /qn /norestart`;
    else {
      args = rest.replace(/\/I/i, "/X");
      if (!/\/q/i.test(args)) args += " /qn /norestart";
    }
  } else if (rule) {
    args = rule[1](args);
  } else if (isChromiumUninstall(args)) {
    args = args.replace(/(^|\s)\/S(?=\s|$)/g, " ");
    if (!/--force-uninstall/i.test(args)) args += " --force-uninstall";
  } else if (/^unins\d{3}\.exe$/.test(exeName)) {
    if (!/\/verysilent/i.test(args)) args += " /VERYSILENT /SUPPRESSMSGBOXES /NORESTART";
  } else if (!/\/s\b|\/quiet|\/silent|--silent|\/qn/i.test(args)) {
    args += " /S";
  }
  return { file, args: args.trim() };
}

/**
 * Silent uninstall, run as SYSTEM on the PC. Prefers what the program
 * registered itself (its MSI product code, then its QuietUninstallString)
 * over the master's guess; stops an uninstaller still running after
 * `timeoutMin` (one waiting for a click nobody can see, as SYSTEM); and
 * checks afterwards that the program is really gone.
 */
export function uninstallScript(uninstall, name = "", { timeoutMin = 15 } = {}) {
  const { file, args } = silentCommand(uninstall);
  const mins = Math.max(1, Math.min(120, Math.round(timeoutMin)));
  return `# FleetView: uninstall ${String(name || file).replace(/[\r\n]/g, " ")}
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$name = ${psQuote(name)}
$file = ${psQuote(file)}
$argv = ${psQuote(args)}
${UNINSTALL_PS.replaceAll("@MINS@", String(mins))}`;
}

const UNINSTALL_PS = String.raw`function Get-Entries {
  $roots = @(
    ,@('LocalMachine', 'Registry64', 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')
    ,@('LocalMachine', 'Registry32', 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'))
  $hku = [Microsoft.Win32.RegistryKey]::OpenBaseKey('Users', 'Registry64')
  foreach ($sid in $hku.GetSubKeyNames()) { if ($sid -match '^S-1-5-21-[\d-]+$') { $roots += ,@('Users', 'Registry64', ($sid + '\Software\Microsoft\Windows\CurrentVersion\Uninstall')) } }
  foreach ($r in $roots) {
    $k = [Microsoft.Win32.RegistryKey]::OpenBaseKey($r[0], $r[1]).OpenSubKey($r[2])
    if (-not $k) { continue }
    foreach ($n in $k.GetSubKeyNames()) {
      $e = $k.OpenSubKey($n)
      if (-not $e) { continue }
      if ([string]$e.GetValue('DisplayName') -eq $name) {
        [pscustomobject]@{ key = $n; quiet = [string]$e.GetValue('QuietUninstallString'); msi = ($e.GetValue('WindowsInstaller') -eq 1) }
      }
      $e.Close()
    }
    $k.Close()
  }
}
function Split-Command($cmd) {
  $cmd = $cmd.Trim()
  if ($cmd.StartsWith('"')) { $i = $cmd.IndexOf('"', 1); if ($i -gt 0) { return @($cmd.Substring(1, $i - 1), $cmd.Substring($i + 1).Trim()) } }
  $i = $cmd.ToLower().IndexOf('.exe')
  if ($i -ge 0) { return @($cmd.Substring(0, $i + 4), $cmd.Substring($i + 4).Trim()) }
  return @($cmd, '')
}
$before = @(if ($name) { Get-Entries })
if ($name -and -not $before.Count) { 'Not installed (any more): ' + $name + ' - nothing to do.'; exit 0 }
$e = $before | Select-Object -First 1
if ($e -and $e.msi -and $e.key -match '^\{[0-9A-Fa-f-]+\}$') { $file = 'msiexec.exe'; $argv = '/X ' + $e.key + ' /qn /norestart' }
elseif ($e -and $e.quiet) { $c = Split-Command $e.quiet; $file = $c[0]; $argv = $c[1] }
# Chromium-style installers (Chrome, Edge, Copilot...): silent only with
# --force-uninstall, and /S means nothing to them.
$chromium = $argv -match '(^|\s)--uninstall(\s|$)'
if ($chromium) {
  $argv = ($argv -replace '(^|\s)/S(?=\s|$)', ' ').Trim()
  if ($argv -notmatch '--force-uninstall') { $argv += ' --force-uninstall' }
}
function Invoke-Uninstaller {
  'Running: ' + $file + ' ' + $argv
  $sp = @{ FilePath = $file; PassThru = $true; WindowStyle = 'Hidden' }
  if ($argv) { $sp.ArgumentList = $argv }
  $p = Start-Process @sp
  $h = $p.Handle # keeps the exit code readable after the process ends
  if (-not $p.WaitForExit(@MINS@ * 60000)) {
    & taskkill.exe /T /F /PID $p.Id 2>&1 | Out-Null
    'Stopped after @MINS@ min: the uninstaller was still running - it is probably waiting for a click (it has no silent mode). Uninstall it by hand once, or use a saved script with its silent switch.'
    exit 1460
  }
  $c = $p.ExitCode
  $script:code = $(if ($null -eq $c) { 0 } else { $c })
}
$started = Get-Date
$code = 0
Invoke-Uninstaller
$ok = @(0, 1641, 3010)
# Chromium-style installers report a finished uninstall as 19.
if ($chromium) { $ok += 19 }
if ($chromium -and $code -notin $ok) {
  # Microsoft's Edge-family apps (Edge, Copilot) refuse while the app runs for a
  # signed-in user, or unless uninstalling is allowed (EdgeUpdateDev\AllowUninstall).
  # Close the app, allow it for this one attempt, try again.
  'First attempt failed (exit ' + $code + '): closing the program and allowing the uninstall, then trying again...'
  $root = $file -replace '\\Application\\.*$', ''
  $procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) })
  foreach ($x in $procs) { try { Stop-Process -Id $x.Id -Force -ErrorAction Stop } catch {} }
  if ($procs.Count) { 'Closed ' + $procs.Count + ' running process(es) of it.' }
  $devPath = 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdateDev'
  $hk = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64')
  $dev = $hk.CreateSubKey($devPath)
  $had = $null -ne $dev.GetValue('AllowUninstall')
  $dev.SetValue('AllowUninstall', 1, 'DWord')
  try { Invoke-Uninstaller }
  finally { if (-not $had) { try { $dev.DeleteValue('AllowUninstall') } catch {} }; $dev.Close() }
}
if ($code -notin $ok) {
  if ($chromium) {
    # These installers say why in their own log (--verbose-logging): show its end.
    $dirs = @("$env:windir\SystemTemp", "$env:windir\Temp", $env:TEMP, "$env:ProgramData\Microsoft\EdgeUpdate\Log", (Split-Path $file -Parent))
    $log = @(foreach ($d in $dirs) { if ($d -and (Test-Path $d)) { Get-ChildItem -Path $d -Filter '*.log' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'install|setup|copilot|edge' -and $_.LastWriteTime -ge $started.AddMinutes(-1) } } }) |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($log) {
      '--- end of ' + $log.FullName + ' ---'
      Get-Content -Path $log.FullName -Tail 25 -ErrorAction SilentlyContinue
      '---'
    } else { '(no installer log found to explain it)' }
  }
  $why = @{ 7 = 'install failed'; 14 = 'insufficient rights'; 15 = 'not installed'; 16 = 'the program is running - close it first'; 20 = 'uninstall failed'; 21 = 'uninstall was cancelled' }
  'The uninstaller failed with exit code ' + $code + $(if ($argv -match '--uninstall' -and $why[[int]$code]) { ' (' + $why[[int]$code] + ')' } else { '' }) + '.'
  exit $code
}
if ($name) {
  # Many uninstallers hand over to a copy of themselves and return at once:
  # give them time to finish before checking.
  for ($i = 0; $i -lt 60 -and @(Get-Entries).Count; $i++) { Start-Sleep -Seconds 2 }
  if (@(Get-Entries).Count) { 'The uninstaller finished (exit ' + $code + ') but ' + $name + ' is still installed.'; exit 2 }
}
'Uninstalled' + $(if ($name) { ' ' + $name } else { '' }) + $(if ($code -in 1641, 3010) { ' - RESTART NEEDED to finish' } else { '' }) + '.'
exit 0`;

/** Same table as the agent: what an installer's exit code means. */
export function exitMeaning(code) {
  const t = {
    0: "success",
    3010: "success — restart needed to finish",
    1641: "success — the installer started a restart",
    1602: "cancelled (the installer showed UI that was dismissed)",
    1603: "fatal error during installation",
    1618: "another installation was in progress",
    1619: "the package could not be opened",
    1620: "not a valid MSI",
    1625: "blocked by system policy",
    1633: "package does not support this platform (32/64-bit)",
    1638: "another version is already installed",
    1639: "invalid command-line arguments",
    1: "generic failure — often wrong silent switches",
    2: "generic failure — often wrong silent switches",
  };
  return code === null || code === undefined ? "" : (t[code] ?? "failed");
}
