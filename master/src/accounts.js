// Local Windows accounts on the PCs: list, rename, set password,
// enable/disable, add/remove from Administrators, create, delete.
//
// Everything runs as PowerShell through the agent's existing RunPowerShell
// (as SYSTEM), so no agent change is needed. Rules:
//   * The Administrators group is found by SID (S-1-5-32-544): its name is
//     localized ("Administratori" on Romanian Windows).
//   * A PC's last enabled administrator is never disabled, demoted or deleted.
//   * Passwords never appear in the script's first line, which is what the
//     agent's audit log records, and are not stored in the job history.

const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

export const ACTIONS = {
  set_password: { label: "Set password", needsPassword: true },
  rename: { label: "Rename" },
  enable: { label: "Enable" },
  disable: { label: "Disable" },
  add_admin: { label: "Make administrator" },
  remove_admin: { label: "Remove from administrators" },
  create: { label: "Create account", needsPassword: true },
  delete: { label: "Delete account" },
};

/** Windows local account name rules. Returns an error message or null. */
export function checkName(name) {
  const n = String(name ?? "");
  if (!n.trim()) return "enter a user name";
  if (n.length > 20) return "user names are at most 20 characters";
  if (/["/\\[\]:;|=,+*?<>@]/.test(n)) return 'user names cannot contain " / \\ [ ] : ; | = , + * ? < > @';
  if (/^[. ]+$/.test(n)) return "a user name cannot be only dots or spaces";
  return null;
}

export function checkPassword(pw) {
  const p = String(pw ?? "");
  if (!p) return "enter a password";
  if (p.length > 127) return "passwords are at most 127 characters";
  return null;
}

/** Validate an account action; throws with a user-facing message. */
export function validate(payload, password) {
  const a = ACTIONS[payload?.action];
  if (!a) throw new Error("unknown account action");
  const e1 = checkName(payload.user);
  if (e1) throw new Error(e1);
  if (payload.action === "rename") {
    const e2 = checkName(payload.new_name);
    if (e2) throw new Error(`new name: ${e2}`);
  }
  if (a.needsPassword) {
    const e3 = checkPassword(password);
    if (e3) throw new Error(e3);
  }
}

const PRELUDE = String.raw`$ErrorActionPreference = 'Stop'
$adminGroup = Get-LocalGroup -SID 'S-1-5-32-544'
function Get-AdminSids {
  try { @(Get-LocalGroupMember -Group $adminGroup | ForEach-Object { $_.SID.Value }) }
  catch {
    # Get-LocalGroupMember fails on groups with orphaned SIDs; ADSI does not.
    $g = [ADSI]("WinNT://$env:COMPUTERNAME/" + $adminGroup.Name + ",group")
    @($g.psbase.Invoke('Members') | ForEach-Object {
      $b = $_.GetType().InvokeMember('objectSid', 'GetProperty', $null, $_, $null)
      (New-Object System.Security.Principal.SecurityIdentifier($b, 0)).Value })
  }
}
function Assert-NotLastAdmin($u) {
  $admins = @(Get-AdminSids)
  if ($admins -notcontains $u.SID.Value) { return }
  $local = @{}; Get-LocalUser | ForEach-Object { $local[$_.SID.Value] = $_ }
  # Another enabled local admin, or a non-local member (e.g. Domain Admins).
  $others = @($admins | Where-Object { $_ -ne $u.SID.Value -and (-not $local.ContainsKey($_) -or $local[$_].Enabled) })
  if ($others.Count -eq 0) { throw ($u.Name + ' is the only enabled administrator on this PC - refusing, the PC would have no administrator.') }
}
`;

/** Script that prints the PC's local accounts as JSON. */
export function listScript() {
  return `# FleetView: list local accounts
${PRELUDE}
$admins = @(Get-AdminSids)
$list = @(Get-LocalUser | ForEach-Object {
  [pscustomobject]@{
    name = $_.Name
    full_name = $_.FullName
    description = $_.Description
    enabled = [bool]$_.Enabled
    admin = ($admins -contains $_.SID.Value)
    builtin = ($_.SID.Value -match '-(500|501|503|504)$')
    default_kind = $(if ($_.SID.Value -match '-(500|501|503|504)$') { 'builtin' } elseif ($_.Name -match '^(defaultuser\d+|WsiAccount|defaultuser100000)$') { 'setup' } else { $null })
    last_logon = $(if ($_.LastLogon) { $_.LastLogon.ToUniversalTime().ToString('o') } else { $null })
    password_last_set = $(if ($_.PasswordLastSet) { $_.PasswordLastSet.ToUniversalTime().ToString('o') } else { $null })
    password_required = [bool]$_.PasswordRequired
    sid = $_.SID.Value
  }
})
[Console]::OutputEncoding = [Text.Encoding]::UTF8
ConvertTo-Json -InputObject $list -Compress -Depth 3`;
}

/** Script for one account action. `password` is only for set_password/create. */
export function actionScript(p, password) {
  validate(p, password);
  const user = psq(p.user);
  const pw = () => `$pw = ConvertTo-SecureString ${psq(password)} -AsPlainText -Force`;
  const get = `$u = Get-LocalUser -Name ${user}`;
  let body;
  switch (p.action) {
    case "set_password":
      body = `${get}
${pw()}
Set-LocalUser -InputObject $u -Password $pw
${p.must_change ? `$a = [ADSI]("WinNT://$env:COMPUTERNAME/" + $u.Name + ",user"); $a.PasswordExpired = 1; $a.SetInfo()` : ""}
'Password changed for ' + $u.Name${p.must_change ? " + ' (must change it at next sign-in)'" : ""}`;
      break;
    case "rename":
      body = `${get}
Rename-LocalUser -InputObject $u -NewName ${psq(p.new_name)}
'Renamed ' + $u.Name + ' to ' + ${psq(p.new_name)}`;
      break;
    case "enable":
      body = `${get}
Enable-LocalUser -InputObject $u
'Enabled ' + $u.Name`;
      break;
    case "disable":
      body = `${get}
Assert-NotLastAdmin $u
Disable-LocalUser -InputObject $u
'Disabled ' + $u.Name`;
      break;
    case "add_admin":
      body = `${get}
if (@(Get-AdminSids) -contains $u.SID.Value) { $u.Name + ' is already an administrator' }
else { Add-LocalGroupMember -Group $adminGroup -Member $u; $u.Name + ' is now an administrator' }`;
      break;
    case "remove_admin":
      body = `${get}
if (@(Get-AdminSids) -notcontains $u.SID.Value) { $u.Name + ' is not an administrator' }
else { Assert-NotLastAdmin $u; Remove-LocalGroupMember -Group $adminGroup -Member $u; $u.Name + ' is no longer an administrator' }`;
      break;
    case "create": {
      const full = p.full_name ? ` -FullName ${psq(p.full_name)}` : "";
      body = `if (Get-LocalUser -Name ${user} -ErrorAction SilentlyContinue) { throw (${user} + ' already exists on this PC') }
${pw()}
$u = New-LocalUser -Name ${user} -Password $pw${full} -AccountNeverExpires
Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545') -Member $u
${p.admin ? "Add-LocalGroupMember -Group $adminGroup -Member $u" : ""}
${p.must_change ? `$a = [ADSI]("WinNT://$env:COMPUTERNAME/" + $u.Name + ",user"); $a.PasswordExpired = 1; $a.SetInfo()` : ""}
'Created ' + $u.Name${p.admin ? " + ' (administrator)'" : ""}`;
      break;
    }
    case "delete":
      body = `${get}
Assert-NotLastAdmin $u
Remove-LocalUser -InputObject $u
'Deleted ' + $u.Name + ' (its profile folder under C:\\Users is kept)'`;
      break;
  }
  // The first line is what the agent's audit log records: no secrets in it.
  return `# FleetView: ${ACTIONS[p.action].label.toLowerCase()} for local user ${String(p.user).replace(/[\r\n]/g, " ")}
${PRELUDE}
${body}`;
}

/** Title shown in Activity (no secrets). */
export function actionTitle(p) {
  const a = ACTIONS[p.action]?.label ?? p.action;
  return p.action === "rename" ? `Rename user ${p.user} → ${p.new_name}` : `${a}: ${p.user}`;
}

/** Parse the list script's output. */
export function parseList(stdout) {
  const text = String(stdout ?? "").trim();
  const start = text.indexOf("[");
  if (start < 0) throw new Error("no account list in the PC's answer");
  const list = JSON.parse(text.slice(start));
  return (Array.isArray(list) ? list : [list]).sort((a, b) => a.name.localeCompare(b.name));
}
