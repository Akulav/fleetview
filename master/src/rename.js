// Rename PCs: one at a time from a PC's page, or many at once with a
// pattern like "PC-###" (the #s become a zero-padded number).
//
// Runs `Rename-Computer -Force` as SYSTEM through RunPowerShell. A new name
// only takes effect after a restart, so the script first reads the name
// Windows will use next boot: if a rename is already pending it says so
// (and to which name) instead of renaming again. The restart is optional and
// comes with a warning to the signed-in user (shutdown /r with a delay).
//
// Generated PowerShell is ASCII only: names are validated to [A-Za-z0-9-].

const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** NetBIOS computer name rules. Returns an error message or null. */
export function checkPcName(name) {
  const n = String(name ?? "");
  if (!n) return "enter a name";
  if (n.length > 15) return `"${n}" is longer than 15 characters (the Windows limit for PC names)`;
  if (!/^[A-Za-z0-9-]+$/.test(n)) return `"${n}": PC names can only contain letters, digits and hyphens`;
  if (/^\d+$/.test(n)) return `"${n}": a PC name cannot be only digits`;
  if (n.startsWith("-") || n.endsWith("-")) return `"${n}": a PC name cannot start or end with a hyphen`;
  return null;
}

/**
 * Names for `count` PCs from a pattern. The first run of #s is the number,
 * zero-padded to the number of #s ("PC-###", start 1 → PC-001, PC-002 …).
 * Without a # the pattern is used as is (only valid for one PC).
 */
export function expandPattern(pattern, count, start = 1) {
  const p = String(pattern ?? "").trim();
  const m = /#+/.exec(p);
  const first = Math.max(0, Math.floor(Number(start) || 0));
  const names = [];
  for (let i = 0; i < count; i++) {
    names.push(m ? p.slice(0, m.index) + String(first + i).padStart(m[0].length, "0") + p.slice(m.index + m[0].length) : p);
  }
  return names;
}

/**
 * Validate a set of renames { agentId: newName }; throws with the first
 * problem. Names must be unique (case-insensitive) within the set.
 */
export function validateRenames(names) {
  const entries = Object.entries(names ?? {});
  if (!entries.length) throw new Error("choose at least one PC");
  const seen = new Map();
  for (const [, n] of entries) {
    const e = checkPcName(n);
    if (e) throw new Error(e);
    const k = n.toUpperCase();
    if (seen.has(k)) throw new Error(`two PCs would both be named ${n} — use a pattern with # for a number`);
    seen.set(k, true);
  }
}

export function clampDelay(sec) {
  return Math.max(0, Math.min(3600, Math.round(Number(sec ?? 60)) || 0));
}

// Reads the names from the registry: ActiveComputerName = now, ComputerName =
// after the next restart. A difference means a rename is pending.
const NAMES = String.raw`$cnKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName'
$active = (Get-ItemProperty "$cnKey\ActiveComputerName").ComputerName
$next = (Get-ItemProperty "$cnKey\ComputerName").ComputerName`;

/** Script that renames this PC to `newName` (optionally restarting). */
export function renameScript(newName, { restart = false, delaySec = 60 } = {}) {
  const e = checkPcName(newName);
  if (e) throw new Error(e);
  const delay = clampDelay(delaySec);
  const restartLine = restart
    ? `& shutdown.exe /r /f /t ${delay} /d p:2:4 /c 'This computer was renamed by IT and will restart in ${Math.round(delay / 60) || "less than 1"} min. Please save your work.'
if ($LASTEXITCODE -ne 0) { 'Could not schedule the restart (shutdown.exe ' + $LASTEXITCODE + ' - another restart may already be scheduled). Restart it to finish the rename.'; exit 0 }
'Renamed: ' + $active + ' -> ' + $new + ', restarting in ${delay} s.'`
    : `'Renamed: ' + $active + ' -> ' + $new + ' - pending restart.'`;
  return `# FleetView: rename this PC to ${newName}
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$new = ${psq(newName)}
${NAMES}
if ($active -ieq $new -and $next -ieq $new) { 'Already named ' + $new + '.'; exit 0 }
if ($next -ieq $new) {
  'Rename to ' + $new + ' is already pending restart.'
} elseif ($next -ine $active) {
  # Another rename is pending: replacing it is fine (the last one wins).
  'Replacing the pending rename to ' + $next + '.'
  Rename-Computer -NewName $new -Force -WarningAction SilentlyContinue
} else {
  Rename-Computer -NewName $new -Force -WarningAction SilentlyContinue
}
${restartLine}`;
}

/** Quick script: the current name and the pending one, as JSON. */
export function nameStatusScript() {
  return `# FleetView: read this PC's name
${NAMES}
$dom = (Get-CimInstance Win32_ComputerSystem).PartOfDomain
[Console]::OutputEncoding = [Text.Encoding]::UTF8
ConvertTo-Json -Compress -InputObject @{ active = $active; pending = $(if ($next -ine $active) { $next } else { $null }); domain = [bool]$dom }`;
}

export function parseNameStatus(stdout) {
  const text = String(stdout ?? "").trim();
  const i = text.indexOf("{");
  if (i < 0) throw new Error("no answer from the PC");
  const v = JSON.parse(text.slice(i));
  return { active: v.active ?? "", pending: v.pending || null, domain: !!v.domain };
}
