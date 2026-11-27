# Changelog

All notable changes to FleetView are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).
Older versions are described on the [releases page](https://github.com/Akulav/fleet-manager/releases).

## [0.6.0] - unreleased

### Added — password vault and two-step sign-in
- **Passwords tab:** a zero-knowledge password vault (PBKDF2-SHA256 600k → AES-256-GCM in the browser; the
  server stores only ciphertext and rejects anything else). Folder tree, instant search (Ctrl+K), favorites and
  recently used, one-click copy with a 30-second clipboard clear, password generator, add / edit / move / delete,
  "connect" for servers (.rdp file or ssh command, never the password), auto-lock after 5 minutes, encrypted
  backup and restore, unencrypted CSV export behind the master password, change master password, metadata-only
  activity log. Works on phones.
- **Import from KeePassXC** in the browser: `.kdbx` (KDBX 4 with Argon2d/id or AES-KDF, AES-256 or ChaCha20)
  and CSV exports, with a preview and duplicate skipping. Argon2, BLAKE2b, ChaCha20 and the KDBX reader are
  written here (no third-party code) and tested against Node's own implementations and a real KeePassXC file.
- **Two-step sign-in (TOTP)** in Settings → Security with a QR code; required for the vault. Codes work once;
  turning 2FA on or off signs out other sessions; failures count toward the sign-in lockout.
- **Recovery codes:** turning on 2FA gives 10 one-time codes (copy / download / print) that replace an
  authenticator code at sign-in or for sensitive actions. Stored as hashes, each use logged with the count left,
  a new set (password + code) voids the old one.

### Added — PC management
- **Rename PCs** from a PC's page or in bulk from the selection bar with a pattern (`PC-###` → PC-001, PC-002…),
  with a live preview and the NetBIOS rules checked as you type (15 characters, letters/digits/hyphens, not
  all digits, no leading/trailing hyphen; names in use are refused). Runs `Rename-Computer -Force` as SYSTEM, with
  an optional restart after a warning. PCs show *restart pending* until they come back under the new name, and a
  rename already pending on the PC is detected.
- **Startup apps** tab on each PC: Run/RunOnce keys (HKLM, WOW6432Node, every loaded user hive), the common and
  per-user Startup folders, and logon/boot scheduled tasks, with source, command and state. **Disable/Enable**
  the way Task Manager does (`StartupApproved` values; `Disable-ScheduledTask` for tasks).
- **Startup** page: scans the online PCs and shows which startup entries are on how many PCs and how many have
  them enabled, with "disable on all".
- **Scripts** page: a library of saved PowerShell scripts (create, edit, delete) to run on one PC, the selection,
  all online or all PCs (offline ones when they connect), with each PC's result (the script's last line) in
  Activity. A script can run **automatically once on every new PC**. Starts with a commented, conservative
  Windows 10/11 debloat example (consumer apps, consumer features and suggestions, telemetry to the minimum;
  never the Store, Defender, Windows Update or Edge).
- Tests: unit and API tests for all of the above (`test/manage.test.js`, including a PowerShell syntax check of
  every generated script) and end-to-end tests with the real agent.

### Added — bulk changes, security, performance
- **Apply** tab: pick changes (tasks, saved scripts, *mark as cleaned*), order them, pick computers (filters:
  online, not cleaned, cleaned, search), run. Each PC runs the list in order as one action (`batch` job) with a
  result per step; Retry resumes at the failed step. Ready-made lists: New PC setup, Clean-up, Secure, Health
  check, Fix & install updates.
- **Security baseline** task: every Defender module on (and the policies that disabled them removed), firewall,
  SmartScreen, UAC, SMBv1/AutoRun/Guest off, RDP with NLA; attack surface reduction rules (standard / audit /
  block all / leave), optional Controlled folder access; Defender left alone behind another antivirus.
  **Security check** task (read-only).
- **Adblocker in all browsers**: uBlock Origin Lite (Chrome, Edge, Brave) and uBlock Origin (Firefox) through
  browser policies, and a task to remove it.
- **Repair Windows Update** task.
- **Cleaned** mark per PC (date, who, note, history), on the PC's page, in a run, or for the selection; a
  *Not cleaned* filter.
- **Performance history**: CPU/memory from telemetry (hourly 14 days, daily 6 months), **snapshots** (30 s CPU,
  memory, commit, processes, boot time, top programs), **internet speed tests** (on demand or scheduled, one PC
  at a time), and a before/after comparison around the cleaned mark, per PC and for the fleet.
- **Accounts** separate people's accounts from Windows defaults and setup leftovers (`defaultuser0`).

### Changed — new console design
- **New layout:** a sidebar with icons (Home; Devices: Computers, Apply changes, Activity; Configure: Scripts,
  Startup apps; Security: Passwords; Admin: Settings) that collapses to icons, with a slide-out menu on phones;
  a header with the page title and search. Every page has its own address (`#/computers`…), so Back and
  bookmarks work.
- **Home dashboard:** online, need attention, actions running, cleaned and average internet speed at a glance;
  a *Needs attention* list (long offline, disk ≥ 90 %, memory ≥ 92 %, security check failed, recent failures,
  MoldSign bridge, agent update, pending restart), fleet health bars, recent activity and quick actions.
- **Search everything with Ctrl+K** (or `/`): computers, pages and actions, from anywhere.
- **Computers** is a sortable grid (click a column) with a status column, issue badges, a *Needs attention*
  filter, a tag filter, and a tidier selection bar (main actions plus *More*).
- **PC page** has a header with the PC's status, user, IP and Windows, four main actions and a *More* menu.
- New colours, type and icons (drawn in the app, no external files; the CSP is unchanged), light and dark.
- **Sign-in** page redesigned.

### Changed
- **The PC page** is a wide panel with the computer list on the left (search, click, ↑/↓ or J/K, ◀ ▶) and
  cards for the PC, performance, cleaning, internet, security and recent actions.
- The Computers list shows the last internet speed and a *cleaned* badge.

### Fixed
- **Uninstalls that hung forever (e.g. AnyDesk):** an uninstaller that asks for a click waited invisibly as
  SYSTEM until the agent's 4-hour limit. Uninstalls now use the program's own MSI product code or
  QuietUninstallString when it has one, know AnyDesk (`--silent --remove`) and Chromium browsers
  (`--force-uninstall`), stop an uninstaller still running after 15 minutes, and check afterwards that the
  program is really gone (many uninstallers return before they finish). NSIS `uninst.exe` no longer gets Inno
  Setup switches.
- **Repair Windows Update on PCs with an update blocker:** tools like Windows Update Blocker lock the update
  services' permissions so even SYSTEM gets "access denied" (`sc.exe exit 5`). The repair now takes the
  service's registry key back, restores Windows' usual permissions on it and on the service, then re-enables it;
  it also reports a service pointing to an unexpected program. Check / Install updates say when a service is
  locked and point to the repair.
- **Performance snapshots failed** on PCs where one measurement wasn't readable: each part is now measured on its
  own (CPU falls back to the processor load when the performance counters are broken), and the output says
  what couldn't be read.
- **Check / Install Windows updates failed with "The service cannot be started, either because it is disabled…"**
  (0x80070422) on PCs where a debloat tool had disabled the update services: they are re-enabled (manual start,
  as Windows ships them) before searching, and common error codes are explained.

### Fixed
- New agent installers had no `emanagement_url` (so no MoldSign bridge) after moving from the desktop master:
  it kept the URL in `master.settings.json`, which the web master ignored unless `FLEETVIEW_EMANAGEMENT_URL`
  was set. The saved value is now used, shown and editable in Settings, and **Agent settings** can push it to
  PCs that are missing it.
- **Agents are kept in sync with the master's e-Management URL automatically:** on every connect (and for all
  online PCs when it changes in Settings) the master sends it; a PC that already has it changes nothing, one
  that lacks it or has another gets it and restarts once. Each PC's page shows the result ("MoldSign bridge"),
  the list flags PCs it couldn't fix, and **Maintenance → Show agent settings** reads the setting on every PC.
- **Agent settings** is also on each PC's page.
- A `console`-mode agent (development, tests) no longer restarts the installed agent service on this PC when a
  setting changes.

### Changed
- **The master is now a Node.js web app** (`master/`, no dependencies), meant to run at
  https://fleetview.akulav.com behind an HTTPS proxy, configured with `.env`. It speaks the same agent protocol,
  so 0.4/0.5 agents connect unchanged; `npm run import-desktop-master` brings over the desktop master's identity
  and PCs. The egui desktop master and its Inno Setup installer are removed.
- **Simpler console:** one "Install software" screen (file → computers → options), a bottom bar for actions on
  the ticked PCs, live per-PC progress and results under Activity, light/dark themes, new blue look.
- **New icons:** app icon and four tray states (connected, searching, installing, screen viewed), drawn per size
  for 16–48 px; the tray loads the exact size for the screen's DPI.

- **Agents connect to the web address, not the LAN:** new installers point at the public URL
  (`wss://fleetview.akulav.com/agent`, the agent's pinned TLS inside a WebSocket), so only HTTPS is needed and
  Cloudflare can stay proxied. LAN discovery is off by default; port 48620 remains for older agents.
- **The master compiles the agent itself** from the repository's sources (at start and whenever they change)
  with its own address built in; Settings shows the build and offers the download. GitHub releases no longer
  ship an agent exe.
- Agents whose config has no master address (set up by the desktop master) use the built-in web address, and
  keep trying LAN discovery while it doesn't answer, so updating them from the desktop master moves them over.

### Added
- **Move PCs from the desktop master** in Settings: upload its `master.settings.json` (and `known_agents.json`)
  and its agents trust this master, without shell access to the server.
- **Maintenance tasks** for one PC or the fleet: Windows Update check/install, sfc /scannow, DISM RestoreHealth,
  Defender update + quick scan, temp cleanup, disk health, gpupdate, DNS flush, restart/shutdown with warning.
- **Local accounts:** list per PC; rename, set password, enable/disable, add/remove administrator, create,
  delete, on one PC or many. Passwords stay in memory until delivered; the last administrator is protected.
- Installs for offline PCs wait and run when the PC connects; *Retry n not done*.
- Agent: Inno Setup installs write a log whose tail is reported on failure; results include the exact command
  line; a timed-out installer is killed with its whole process tree; the tray shows "installing".
- Agent `console` mode honours `FLEETVIEW_DATA_DIR` (development/tests).
- End-to-end test: the real agent against the master, pushing installers through the API (`npm run test:e2e`).

### Fixed
- **Pushed installers that "never arrived" (e.g. MoldSign):** every queued installer got an automatic
  "skip if installed" name from its file name, checked against a software list only refreshed at connect, so PCs
  with any (or a just-uninstalled) MoldSign were silently skipped. Skipping is now opt-in and checks a fresh list.
- Installer pushes stream from disk with flow control instead of queueing the whole file in memory per PC.
- Silent switches with quoted values (`/D="C:\Program Files\X"`) are no longer split apart.
- Scripts run by the agent may take up to 4 h (was 30 min), enough for sfc, DISM and Windows updates.

## [0.5.0] - 2026-11-21

### Security
- **Each agent has its own key.** On first start an agent creates `agent.key` in its locked-down data folder and
  sends it when it connects; the master pins the key's SHA-256 to that PC's id and from then on refuses the id
  without the same key. Holding the shared enrollment secret is no longer enough to pose as an enrolled PC. Agents
  older than 0.5.0 still connect and are pinned once they update.
- The agent's data folder is owned by Administrators, and links (junctions, symlinks) planted in it are deleted
  before its permissions are reset, so a standard user who created the folder first can't redirect what the
  SYSTEM service writes there.

### Changed
- **New look:** the master uses Windows 11's dark and light themes: flat layers with hairline borders, the Windows
  accent blue (black text on it in dark mode), 4 px controls and 8 px cards, Segoe UI.

## [0.4.1] - 2026-11-20

### Changed
- **License:** FleetView is now source-available under the Akulav Source-Available License, like Akulav's other
  apps (it was MIT). The programs' file details say so too.
- README in the style of Akulav's other apps, with links to the setup, security and architecture docs.

### Fixed
- Pushing a file named like a Windows device (`nul.exe`, `COM1`, `LPT2.msi`…) no longer fails in a confusing way:
  the agent saves it under a safe name.