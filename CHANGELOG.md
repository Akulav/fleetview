# Changelog

All notable changes to FleetView are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).
Older versions are described on the [releases page](https://github.com/Akulav/fleet-manager/releases).

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