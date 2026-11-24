# FleetView — Setup & Operations

## 1. Prerequisites

- **Master:** any machine with **Node.js 20+** behind HTTPS, served at
  `FLEETVIEW_PUBLIC_URL` (default https://fleetview.akulav.com). The console
  and the agents share that address: agents open `wss://…/agent`.
- **Rust on the master**, which compiles the agent itself: on Windows the MSVC
  toolchain; elsewhere `rustup target add x86_64-pc-windows-gnu` plus mingw-w64.
- **Agent PCs:** Windows 10/11, you have local admin to install once. They only
  need outbound HTTPS.

## 2. Run the master

See the [README](../README.md#-master-setup): copy `master/.env.example` to
`.env`, set a password hash (`npm run hash-password`), `npm start`. Put it
behind HTTPS with `master/deploy/Caddyfile` or `nginx.conf`.

On first start it creates in its data folder (`master/data` by default):

- `master.settings.json`: an Ed25519 **identity key** (signs discovery
  beacons), a self-signed **TLS certificate** for the agent channel, and a
  random **enrollment secret**. Agents pin these, so **back this file up**;
  losing it means reinstalling every agent.
- `agents.json` (PCs and their pinned agent keys), `jobs.json`,
  `installers/` (uploaded files), `logs/`.

Coming from the desktop (0.5) master? `npm run import-desktop-master --
"%APPDATA%FleetView"` imports its identity and PCs; no agent is reinstalled.

## 3. Build the agent

```bash
cargo build -p fleetview-agent --release   # target/release/fleetview-agent.exe
```

> On a fresh Windows box, install the toolchain with
> `winget install Rustlang.Rustup` and the **“Desktop development with C++”**
> workload (or VS Build Tools) so the MSVC linker is present.

Releases (`v*` tags) publish `FleetViewAgent-x.y.z.exe`.

## 4. Make the agent setup file

The agent is **one exe** that installs itself, updates itself and runs as the
service — there is no separate installer.

In the console: **Settings → Upload agent package** (the agent exe), then
**Download agent installer**. You get `FleetViewAgent-<version>.exe` with this
config embedded:

```json
{
  "master_public_key": "…",
  "master_cert_fingerprint": "…",
  "enrollment_secret": "…",
  "master_address": null,
  "discovery_targets": [],
  "telemetry_interval_secs": 30
}
```

`master_address` comes from `FLEETVIEW_AGENT_ADDRESS` (default: the public URL;
`"discovery"` = LAN broadcast; null = the address compiled into the agent) and
`emanagement_url` from `FLEETVIEW_EMANAGEMENT_URL` (turns on the MoldSign
signing bridge). Keep the file private: it contains the enrollment secret.

## 5. Running the agent for development

`fleetview-agent console` runs the service worker in the foreground. With
`FLEETVIEW_DATA_DIR=<folder>` it uses that folder (config, staging, logs)
instead of `C:ProgramDataFleetView` and leaves its permissions alone, so it
can run unelevated next to an installed agent; the end-to-end test uses this.

## 6. Install on an agent PC

Double-click `FleetViewAgent-Setup-*.exe` and accept the UAC prompt (or run
`FleetViewAgent-Setup-*.exe /S` from an admin script for a silent install).
It:

1. copies itself to `Program Files\FleetView Agent\fleetview-agent.exe`
   (without the embedded config),
2. writes the config to `C:\ProgramData\FleetView\agent.config.json`, merged
   with any config already there (an existing `agent_id` and local keys are
   kept),
3. registers the **`FleetViewAgent`** service (LocalSystem, auto-start,
   auto-restart on failure) and starts it,
4. locks down `C:\ProgramData\FleetView` to SYSTEM + Administrators,
5. adds **FleetView Agent** to *Apps & features*.

Running it on a PC that already has the agent **updates** it in place (the
service is stopped, the exe swapped, the service started; if the new version
doesn't start, the previous exe is put back). PCs installed with the old
Inno Setup installer are upgraded the same way and its leftovers removed.

The agent discovers the master and appears in the master's list within a few
seconds.
## 7. Daily use

Everything is a click away from the **Computers** list: tick PCs for bulk
actions (bar at the bottom), or click a PC for its page.

- **Install software** (top right, a PC's page, or the selection bar): drop an
  `.exe`/`.msi` or reuse an uploaded one, check the detected silent switches,
  pick *this PC / selected / all online / all*, Install. Each PC's progress and
  result (exit code, meaning, command line, log tail) appears live under
  **Activity**; *Retry n not done* re-runs failures and skipped PCs. See the
  README for the switches per installer type.
- **Programs** tab: installed programs, *Uninstall* (best-effort silent; some
  apps still show UI in session 0).
- **Accounts** tab: local accounts (enabled, administrator, last logon,
  password age). Rename, set a password, enable/disable, add/remove from
  Administrators, create, delete. The selection bar's **Accounts** does the same
  for one user name on many PCs at once (e.g. set `itadmin`'s password
  everywhere). Passwords are not kept in the job history; a PC's last enabled
  administrator can't be disabled, demoted or deleted.
- **Run PowerShell** (as SYSTEM, output in Activity), **Message** (a toast for
  the logged-in user), **Screenshot** (the user is notified and sees a red frame).
- **Agent settings** (selection bar): change where agents look for the master
  (`master_address`: a web address, `host:port`, or `discovery`). The agent
  restarts to apply it. Cleared, it uses the address compiled into it.

The PC's tray icon shows the agent's state: blue with a green check =
connected, grey = searching for the master, amber arrow = installing pushed
software, red eye = the screen is being viewed.

If a vendor installer has **no** silent mode, wrap it: extract it with `7z`,
deploy the payload with a PowerShell script, or repackage it as an MSI, then
push that.

## 8. Updating agents remotely

Upload the new agent exe under **Settings → Agent package**. PCs on an older
version are marked *update* and **Settings → Update n agents** updates them
(offline ones when they connect).

The update is an ordinary file push run with `update`. On the PC the pushed
exe hands off to a detached worker and returns at once; the worker stops the
service, swaps the exe and starts the new version, rolling back to the previous
exe if it doesn't come up. The new version shows in the list when the PC
reconnects. If `FLEETVIEW_EMANAGEMENT_URL` is set, the update also writes it
to the agent config (turning on the MoldSign bridge). Downgrades are never
offered. The worker logs to `C:\ProgramData\FleetView\logs\update.log*`.

## <a name="versioning"></a>9. Versioning

- The **agent version** is `[workspace.package] version` in the root
  `Cargo.toml` (semver `major.minor.patch`). It is reported by every agent and
  embedded in the agent exe as `FLEETVIEW_AGENT_VERSION=x.y.z` so the master
  can read a file's version without running it. The master's own version is in
  `master/package.json` (shown under Settings).
- To release: bump the version in `Cargo.toml`, commit, then tag the same
  version. The release workflow refuses a tag that doesn't match.

```bash
git tag v0.2.0
git push origin v0.2.0
```

  The release contains `FleetViewAgent-x.y.z.exe` and
  `FleetViewMaster-x.y.z.zip` (the master folder, without data or `.env`).
- Upgrade the master first, then upload the new agent package; it flags every
  older agent as outdated.

## <a name="multi-subnet"></a>LAN-only setups

With `FLEETVIEW_AGENT_ADDRESS=discovery` and `FLEETVIEW_DISCOVERY=true` agents
find a master on their LAN by UDP broadcast. Broadcasts don't cross routers: if
agents are on different subnets than the master, either:

- set a fixed `"master_address"` in `agent.config.json`, **or**
- list the master's subnet broadcast address in `"discovery_targets"`, e.g.
  `["192.168.20.255:48621"]`.

## Ports

| Port | Proto | Purpose |
|------|-------|---------|
| 443 (→ 8080) | TCP | Web console **and agents** (`wss://…/agent`), through the HTTPS reverse proxy. |
| 48620 | TCP | Optional direct agent channel (raw pinned TLS) for agents older than 0.6 / LAN setups. |
| 48621 | UDP | Optional LAN discovery (off by default). |

Agents dial **out** to the master, so agent PCs need no inbound rules.

## Uninstall

- Agent: *Apps & features* → *FleetView Agent*, or `fleetview-agent.exe uninstall` (`--silent` for scripts). Removes the service, the program and the config; `audit.log`, `logs` and `agent.id` stay.
- Master: stop its service and delete its folder (keep a backup of `data/`).
