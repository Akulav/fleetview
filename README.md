<div align="center">

<img src="installer/assets/logo.png" alt="FleetView" width="112" height="112">

# FleetView

**Self-hosted management for a fleet of Windows PCs, made by Akulav.**

A web console (Node.js) at **https://fleetview.akulav.com** and a small Windows agent on every PC.
Push silent installers to one PC, a few, or all of them, and see each PC's result.

[![Latest release](https://img.shields.io/github/v/release/Akulav/fleet-manager?style=for-the-badge&label=release&color=2c62f6)](https://github.com/Akulav/fleet-manager/releases/latest)
[![Build](https://img.shields.io/github/actions/workflow/status/Akulav/fleet-manager/ci.yml?branch=main&style=for-the-badge&label=build)](https://github.com/Akulav/fleet-manager/actions/workflows/ci.yml)

![Windows](https://img.shields.io/badge/agent-Windows%2010%20%7C%2011-0078D6?style=flat-square&logo=windows&logoColor=white)
![Node](https://img.shields.io/badge/master-Node.js%2020%2B-3c873a?style=flat-square&logo=nodedotjs&logoColor=white)
![License](https://img.shields.io/badge/license-source--available-5c6270?style=flat-square)

[Master setup](#-master-setup) · [Deploy at fleetview.akulav.com](#-deploy-at-fleetviewakulavcom) ·
[Push software](#-pushing-software) · [Testing](#-testing) · [Security](docs/SECURITY.md) · [Architecture](docs/ARCHITECTURE.md)

</div>

---

> ⚠️ **Authorized use only.** The agent runs commands as SYSTEM and can take
> screenshots. Install it only on PCs you administer and tell their users. The
> agent is deliberately visible (tray icon, logon splash, on-screen frame while
> the screen is viewed) and logs every remote command locally.

## What it does

- **Computers**: online/offline status, user, Windows version, CPU/memory/disk,
  installed programs, agent version. Search and filters.
- **Install software**: one screen. Drop an `.exe`/`.msi` (or reuse one you
  uploaded before), check the detected silent switches, choose *this PC /
  selected / all online / all*, and click Install. Every PC shows its state
  live: *Waiting for PC → Sending n % → Installing → Done / Failed*, with the
  exit code and what it means, the exact command that ran and, for MSI and
  Inno Setup, the end of the installer's log.
- **Offline PCs** get the install when they next connect (on by default).
- **Maintenance**, on one PC or the whole fleet: check / install Windows
  updates, `sfc /scannow`, DISM repair, Defender update + quick scan, temp-file
  cleanup, disk health, group-policy refresh, DNS flush, restart / shut down
  with a warning (and cancel). Each PC reports a one-line summary plus the
  full output.
- **Local accounts** per PC (enabled, administrator, last sign-in, password
  age), with rename, set password, enable/disable, add/remove administrator,
  create, delete. The same action can go to many PCs at once, e.g. set
  `itadmin`'s password everywhere. Passwords are never stored, and a PC's last
  administrator is never removed.
- PowerShell as SYSTEM, messages to the logged-in user, screenshots (the user is
  notified), uninstall from a PC's program list, agent updates, and a remote
  change of the agent's master address.
- **Tray icon** on every PC that shows the agent's state: connected, searching
  (offline), installing, screen being viewed.
- **Password vault** (Passwords tab): your team's passwords, reachable from
  anywhere, encrypted in the browser so the server only ever stores ciphertext.
  Import from KeePassXC (`.kdbx` or `.csv`), folders, instant search, one-click
  copy, generator, encrypted backups. See [the security model](#-password-vault).

## 🔐 Password vault

**Zero-knowledge.** The vault is encrypted and decrypted only in your browser,
with a *master password* that is separate from the console sign-in and never
leaves the page:

| Step | How |
|---|---|
| Master password → key-encryption key | PBKDF2-SHA256, **600 000** iterations, 16-byte random salt (WebCrypto) |
| Vault key | random 256-bit key, wrapped with AES-256-GCM under the key-encryption key |
| Vault contents (all entries, folders, notes) | one JSON document, AES-256-GCM under the vault key, fresh 96-bit IV per save |
| What the server stores (`data/vault.json`) | salt, iteration count, IVs and ciphertext — nothing else. The API rejects any upload that isn't exactly that shape. |

Changing the master password re-wraps the vault key (the data stays as is).
Forgetting it means the vault can't be opened; there is no recovery by design.
Restore an encrypted backup or delete the vault and start over.

**Who can reach it.** The Passwords tab only works for sessions confirmed with
**two-step sign-in** (Settings → Security: a TOTP code from Microsoft/Google
Authenticator, Aegis, 1Password…). Turning 2FA on or off signs out every other
session. Sign-in failures (password or code) lock the address out for 10 minutes
after 8 tries. The session cookie is `HttpOnly`, `SameSite=Strict` and `Secure`
on HTTPS. Every change needs a custom header (CSRF guard). The pages run under a
strict Content-Security-Policy (`script-src 'self'`, no inline code, no third-party
code at all), with HSTS on HTTPS.

**In the browser.** The vault locks after **5 minutes** without activity, on
sign-out and on page reload (the key and plaintext are dropped from memory, open
vault drawers close). Copied passwords are cleared from the clipboard after
**30 seconds**. "Connect" on server entries builds an `.rdp` file or an `ssh`
command with the address and user name only, never the password. Only random
entry ids (no names) are kept in the browser's storage, for "Recently used".

**Import.** `.kdbx` files (KDBX 4: Argon2d/Argon2id or AES-KDF, AES-256 or
ChaCha20, password-only) are opened in a Web Worker in the browser. The KeePass
password is typed there and never sent. KeePassXC CSV exports
(`Group,Title,Username,Password,URL,Notes`) work too; delete the CSV afterwards,
it isn't encrypted. Both show a preview (counts, folders, first entries) before
anything is saved, keep the folder tree, and can skip duplicates.

**Backups and export.** *Download encrypted backup* gives the ciphertext record
(it opens only with the master password it was made with). *Restore a backup* and
*Delete the vault* need your console password **and** an authenticator code.
*Export as CSV* is unencrypted, so it asks for the master password again and warns
first.

**Audit log.** Unlocks, failed unlocks, saves, imports (count only), exports,
backups, restores and resets are logged with time, user and IP address. Entry
names and secrets are never logged (*More → Activity log*).

**What it doesn't protect against:** someone who controls the server (or
FleetView's code) could ship modified JavaScript that captures the master
password the next time you unlock. That's true of every web-based password
manager; keep the server and its admin access tight. A compromised PC (keylogger)
can capture anything typed on it.

**Proof.** `npm test` includes a check that stores a vault full of marker strings
through the real API, then searches every file in the master's data folder: none
contain them, and the stored record still opens in the browser code. It also
cross-checks the Argon2, BLAKE2b and ChaCha20 code against Node's own and opens
a real `keepassxc-cli` database. All test data is fake.

## 🗂️ Project layout

| Path | What it is |
|------|------------|
| `master/` | The master: Node.js web console + agent server (no npm dependencies). |
| `agent/`  | The agent (Rust): Windows service + tray/splash/screen-capture helper. One exe that installs and updates itself. |
| `shared/` | Wire protocol, crypto and package format used by the agent (and mirrored by the master). |
| `installer/assets/` | Icons (generated by `tools/make-icons.mjs`) and splash. |
| `docs/` | Setup, security and architecture notes. |

## 🚀 Master setup

Needs **Node.js 20+** (no `npm install`: the master has no dependencies).

```bash
cd master
cp .env.example .env        # then edit it
npm run hash-password       # paste the printed line into .env
npm start
```

Open the console at `http://127.0.0.1:8080` locally, or at the public URL once
it's behind HTTPS. Without a password hash, the first start prints a random
password once.

Configuration (`master/.env`, all optional):

| Variable | Default | Meaning |
|---|---|---|
| `FLEETVIEW_PUBLIC_URL` | `https://fleetview.akulav.com` | Where people open the console (secure cookies, links). |
| `FLEETVIEW_HTTP_HOST` / `_PORT` | `127.0.0.1` / `8080` | Console listener. Keep it on loopback behind a reverse proxy. |
| `FLEETVIEW_HTTPS_CERT` / `_KEY` | — | Serve HTTPS from Node directly instead of a proxy. |
| `FLEETVIEW_ADMIN_USER` | `admin` | Console user name. |
| `FLEETVIEW_ADMIN_PASSWORD_HASH` | — | From `npm run hash-password`. |
| `FLEETVIEW_AGENT_ADDRESS` | the public URL | Where agents connect. Default: `wss://<public URL>/agent`, through the same HTTPS as the console. `host:port` = the direct agent port, `discovery` = LAN broadcast. |
| `FLEETVIEW_AGENT_PORT` | `48620` | Optional direct agent port (raw TLS) for LAN setups and agents older than 0.6; `off` to disable. |
| `FLEETVIEW_DISCOVERY` | `false` | Answer agents' LAN broadcasts (UDP 48621). |
| `FLEETVIEW_AGENT_BUILD` | `true` | Compile the agent on this master from the repository's sources, at start and whenever they change. |
| `FLEETVIEW_AGENT_TARGET` | native / `x86_64-pc-windows-gnu` | Rust target for that build (native on Windows, cross-compiled elsewhere). |
| `FLEETVIEW_CARGO` | `~/.cargo/bin/cargo` | Path to cargo, if it isn't there or on `PATH`. |
| `FLEETVIEW_DATA_DIR` | `data` | Identity, PCs, jobs, uploaded installers, logs. **Back it up, keep it private.** |
| `FLEETVIEW_EMANAGEMENT_URL` | — | e-Management URL for the agents' MoldSign signing bridge. |
| `FLEETVIEW_MAX_UPLOAD_MB` | `2048` | Largest installer accepted. |
| `FLEETVIEW_PARALLEL_TRANSFERS` | `4` | PCs receiving a file at the same time. |

### Keep your existing fleet (moving from the desktop master)

Agents trust the master's certificate and key, not its address. Import them and
no PC needs reinstalling:

```bash
npm run import-desktop-master -- "C:\Users\<you>\AppData\Roaming\FleetView"
```

This copies `master.settings.json` (the identity) and `known_agents.json` (the
PCs and their pinned agent keys) into `data/`. Without shell access to the
server, do the same in the console: **Settings → Move PCs from the desktop
master** (upload both files).

Then move the PCs over, from the old desktop master:

1. In the web console, **Settings → Download agent installer** (0.6 or newer).
2. In the desktop master, load that file as the agent package and **Update** all PCs.
3. Agent 0.6 has no master address from the desktop era, so it uses its built-in
   one (the web address it was compiled for) and connects to the web master with the
   same pinned certificate. Until that address answers it also keeps trying LAN
   discovery, so the desktop master doesn't lose a PC if the website isn't up yet.
4. Stop the desktop master.

### Add computers

**Settings → Download agent installer.** The master compiles the agent itself
(on first start and whenever its sources change, a few minutes the first time)
with its own web address built in; every download carries the master's
certificate and address. Run it on each PC (double-click, or `/S` for silent).
The PC appears within seconds. Older agents show *update*; **Settings → Update n
agents** updates them remotely. A built `fleetview-agent.exe` can still be
uploaded instead when the master can't compile (no Rust on the server).

## 🌐 Deploy at fleetview.akulav.com

Only HTTPS is needed: the console and the agents share it. Agents open a
WebSocket to `/agent` and run their pinned TLS inside it, so the proxy or CDN
(Cloudflare) carries only ciphertext and can't impersonate the master.

| Port | Who | Through the reverse proxy? |
|---|---|---|
| 443 → `127.0.0.1:8080` | the console **and the agents** (`wss://…/agent`) | yes (HTTPS + WebSocket) |
| 48620/tcp | optional: agents older than 0.6, LAN setups | no (raw TLS) |

**The agent is compiled on the server**, so it needs Rust:

- Linux: `curl https://sh.rustup.rs -sSf | sh`, then
  `rustup target add x86_64-pc-windows-gnu` and `apt install gcc-mingw-w64-x86-64`
  (as the user the master runs as).
- Windows: Rust with the MSVC build tools.

1. Put the repository in `/opt/fleetview` (or anywhere: the master needs the
   `agent/` and `shared/` folders next to `master/`), create `master/.env` as above.
2. Reverse proxy with automatic HTTPS: [`master/deploy/Caddyfile`](master/deploy/Caddyfile)
   (or [`nginx.conf`](master/deploy/nginx.conf)). The proxy must not buffer
   `/api/events` (live updates); both examples handle this.
3. Run it as a service: [`master/deploy/fleetview-master.service`](master/deploy/fleetview-master.service)
   (systemd). On Windows, run `node server.js` from Task Scheduler at startup
   (or a service wrapper such as NSSM) in the `master` folder.
4. Firewall: allow 443 (and 80 for the certificate).
5. Health check: `GET /healthz`.

### With AutoNode

[AutoNode](https://github.com/Akulav/auto-node) can host the master straight from this repository:

1. **Websites → New Website → From GitHub** → `Akulav/fleet-manager` (branch `main`). The root
   `package.json` makes AutoNode treat it as a Node.js site (`npm start` → `master/server.js`). The master
   then compiles the agent from the `agent/` folder of the same checkout (Rust must be installed on the
   AutoNode server for the site's user, see above); the console shows the build's progress under Settings.
2. **Settings → Environment variables** of the site:
   - `FLEETVIEW_ADMIN_PASSWORD_HASH`: the line printed by `npm run hash-password` (run it on any PC
     with Node, in `master/`). Without it, a random password is printed once in the site's **Logs**.
   - Optional: `FLEETVIEW_PUBLIC_URL` (default `https://fleetview.akulav.com`, also the address compiled
     into the agent), `FLEETVIEW_MASTER_NAME`, `FLEETVIEW_EMANAGEMENT_URL`.

   `PORT`, `HOST` and `DATA_DIR` come from AutoNode: the master's identity, PCs, jobs, uploads and the
   agent build cache live in the site's data folder, which deploys and rollbacks never touch.
3. **Domains** → add `fleetview.akulav.com` to the site. Health check path: `/healthz`.
4. **DNS:** `fleetview.akulav.com` must resolve: in Cloudflare add a record for `fleetview` (A to the
   AutoNode server's public IP, or a CNAME / tunnel route, as for the other sites on AutoNode).
5. Moving from the desktop master: **Settings → Move PCs from the desktop master** in the console, then
   update the PCs from the desktop master (see above).

**Cloudflare:** proxied (orange cloud) is fine: WebSockets pass through, and the agents' pinned TLS runs
inside them. No port besides 443 is needed.

## 📦 Pushing software

Click **Install software** (top right, or from a PC's page, or with PCs ticked).

| Installer type (auto-detected) | Silent switches used |
|---|---|
| MSI | `msiexec /i file.msi /qn /norestart` (+ a verbose log) |
| Inno Setup | `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-` (+ `/LOG=`) |
| NSIS | `/S` |
| WiX bundle | `/quiet /norestart` |
| InstallShield | `/s /v/qn` |
| Advanced Installer | `/exenoui /qn /norestart` |
| Unknown | none: type the vendor's switch (**Custom**) |

Switches are editable per file and remembered. Quoted values work:
`/D="C:\Program Files\App"`. The console shows the exact command line.

- **Skip computers that already have it** is off by default, so an install
  always runs (upgrades and repairs). Turn it on and type the program name;
  each PC's program list is refreshed before the check.
- `3010`/`1641` (restart needed) count as success. A failed install shows the
  exit code, its meaning and the log tail. An installer that waits for a click
  is killed after 60 min with its whole process tree.

### Why pushed installers used to "never arrive"

The desktop master pre-filled *skip if installed* with a name guessed from the
file name (`MoldSignSetup-2.4.14.exe` → `moldsign`) and compared it with the
PC's program list as last reported, which was only refreshed when the agent
connected. Every PC with any MoldSign version (an upgrade), or where MoldSign
had just been uninstalled, was marked *Skipped — already installed*, and the
file was never sent. The same command run by hand worked because nothing was
skipped. Now skipping is opt-in and uses a fresh list, and every PC's result
says exactly what happened.

## 🧪 Testing

```bash
cargo build -p fleetview-agent      # the agent the end-to-end test drives
cd master
npm test                            # unit: wire format vs. Rust bytes, detection, auth, …
npm run test:e2e                    # real agent ↔ master: push, run, report
```

The end-to-end test starts a master, provisions the real Rust agent (in
`console` mode, with its own data folder) exactly like a downloaded installer,
and pushes a compiled stand-in installer through the HTTP API. It checks a
silent run with its result, wrong switches failing with a reason, an offline
PC getting the install when it connects, a 40 MB file streaming with flow
control, and opt-in skipping. CI runs it on every push.

**Manual check on a real PC** (e.g. MoldSign): upload `MoldSignSetup-x.exe`
(detected as Inno Setup), choose one PC, click **Install on 1 computer**. The
PC's tray icon switches to *installing* (amber arrow). The row goes *Sending →
Installing → Done* with `ran: MoldSignSetup-x.exe /VERYSILENT /SUPPRESSMSGBOXES
/NORESTART /SP-`, and the program appears under the PC's **Programs** tab. On
failure, **Show details** has the Inno Setup log tail.

## 🛠️ Building the agent

Requires the Rust MSVC toolchain.

```bash
cargo build -p fleetview-agent --release     # target/release/fleetview-agent.exe
node tools/make-icons.mjs                    # regenerate the icons (optional)
```

Releases: bump `[workspace.package] version` in `Cargo.toml`, push tag
`vX.Y.Z`. The workflow tests everything and publishes
`FleetViewAgent-X.Y.Z.exe` and `FleetViewMaster-X.Y.Z.zip`.

---

<div align="center">

**Made with ❤️ by [Akulav](https://github.com/Akulav)**

<sub>© 2026 Akulav. Source-available under the <a href="LICENSE">Akulav Source-Available License</a>.</sub>

</div>
