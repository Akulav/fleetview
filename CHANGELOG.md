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

### Fixed
- New agent installers had no `emanagement_url` (so no MoldSign bridge) after moving from the desktop master:
  it kept the URL in `master.settings.json`, which the web master ignored unless `FLEETVIEW_EMANAGEMENT_URL`
  was set. The saved value is now used, shown and editable in Settings, and **Agent settings** can push it to
  PCs that are missing it.

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