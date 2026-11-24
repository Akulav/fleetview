# FleetView — Security Model

FleetView lets a master run commands as SYSTEM and view screens across a fleet.
That power demands a clear trust model. This document describes it and the
hardening the project applies.

## Threat model

- **In scope:** another host on the LAN trying to impersonate the master; a rogue
  agent trying to enroll; passive eavesdropping on the wire.
- **Partly in scope:** a local non-admin user on an agent trying to read secrets
  or stop the agent.
- **Out of scope:** a local **administrator** on an agent (they own the machine
  and can stop any service); a compromised master host (it is the trust root).

## Trust establishment

The master is the trust anchor. On first run it generates:

1. an **Ed25519 identity keypair** — signs discovery beacons;
2. a **self-signed TLS certificate** — secures the control channel;
3. a random **enrollment secret**.

The agent is provisioned (via `agent.config.json`) with the **public** half:
the master's public key, the TLS certificate **SHA-256 fingerprint**, and the
enrollment secret.

### Discovery can't be spoofed

A discovery beacon is signed with the master's identity key and names the TLS
fingerprint. An agent **verifies the signature** against its pinned public key and
checks the fingerprint before connecting. A rogue host without the private key
cannot forge a beacon, so agents won't follow it — even after a legitimate IP
change.

### The channel is pinned, not CA-trusted

The agent's TLS verifier ignores the public CA store and instead requires the
server certificate's SHA-256 to equal the **pinned** fingerprint (always the one
from the agent's own config, never one taken from the network). It also
**verifies the TLS handshake signature** against that certificate's key: the
certificate itself is public, so only the signature proves the peer holds the
master's private key. This both removes the need for PKI on a closed LAN and
blocks man-in-the-middle hosts.

### Agents must prove enrollment

After the TLS handshake the agent presents the **enrollment secret**; the master
rejects anything else. So joining the fleet requires possessing the secret.

Each agent also has its **own key** (`agent.key`, 32 random bytes, created on
first start in the locked-down data folder and never written to the config the
master generates). The master stores only its SHA-256 and pins it to the PC's
id the first time that id connects with a key; from then on that id is refused
without the same key. Agents older than 0.5.0 send no key: they still connect
and are pinned once they update.

## What this means for secrets

- **Keep `agent.config.json` and the master settings private.** Anyone with the
  enrollment secret can enroll an agent and receive commands as that master.
- The agent config lives in `C:\ProgramData\FleetView`. `ProgramData` normally
  lets every user read files and create files in subfolders, so both the
  installer and the service (at every start) run `icacls … /inheritance:r` to
  restrict the folder to **SYSTEM + Administrators** only. Staged installers are
  written to fresh, randomly named folders inside it and deleted after running.
- The IPC token for the service↔helper channel is passed to the helper on its
  command line only (it is no longer written to `status.json`).
- The master's identity key, TLS private key and enrollment secret live in
  `master/data/master.settings.json` (written with mode 600 on Linux). Back it
  up; losing it means re-provisioning all agents. Never commit `data/` or `.env`.

## Transparency & accountability (by design)

FleetView is **not** covert surveillance software and should not be deployed as
such:

- the agent shows a **tray icon** whenever it runs and a **splash at logon**;
- starting a **live screen view** and taking a **screenshot** both show a notice
  to the user; this is enforced by the agent itself, not by the master, and the
  tray tooltip says when the screen is being viewed. The stream stops
  automatically if the master disconnects;
- **install from URL** accepts only `https://` URLs (the file runs as SYSTEM);
- **Run on ALL online agents** asks for confirmation with the target count;
- every remote command (PowerShell, install, file run) is appended to a local
  **audit log** at `C:\ProgramData\FleetView\audit.log` on the agent;
- the service name, publisher and description are plainly labelled.

Tell your users the agent is installed and what it does. At an organization,
get sign-off from IT security before deployment.

## Residual risks & recommendations

- **Unsigned binaries** may be flagged by Defender/SmartScreen. Prefer
  **code-signing** the executables (and the installers) with your organization's
  certificate. Do **not** try to evade detection; use an exclusion via policy only
  with approval.
- **Session-0 command execution** runs as SYSTEM — scripts and installers you push
  have full control of the machine. Review what you push.
- **One shared enrollment secret** for the whole fleet. Anyone holding it (e.g.
  from a leaked `agent.config.json`) can enroll a fake agent under a new id. It
  can't take over an enrolled PC's id once that PC's key is pinned (0.5.0+), but
  an id that has never connected with a key can still be claimed first. Don't
  put credentials in pushed scripts; rotate the master identity if the config
  leaks.
- **Beacon replay.** A signed discovery beacon isn't bound to the sender's IP,
  so a LAN host can replay one and point agents at itself. It can't finish the
  TLS handshake, so the effect is a delayed connection (DoS), not takeover. Use
  a fixed `master_address` if this matters.
- **Console access = SYSTEM on every PC.** The web console has one admin
  account (scrypt-hashed password from `.env`), an HttpOnly + SameSite=Strict
  (+ Secure on https) session cookie, a required `X-FleetView` header on every
  change (CSRF guard), a strict Content-Security-Policy, and locks an IP out for
  10 minutes after 8 failed sign-ins in 15 minutes. Use a long password, serve
  it only over HTTPS, and consider limiting the console to your office IPs at
  the proxy. Every action is logged with the user who did it.
- **Passwords set from the console** (local accounts) travel to the agent inside
  the pinned TLS channel and the PowerShell script the agent runs; they are kept
  only in the master's memory until delivered (not in `jobs.json`) and never in
  the first line of the script, which is what the agent's audit log records.
- **Inventory** is read by the SYSTEM service, so per-user installs (HKCU of the
  logged-in user) are not listed.
- The master's periodic beacon broadcast to UDP 48621 is not received by agents
  (they listen on an ephemeral port for replies to their own query); discovery
  relies on the query/reply path.
- Consider network segmentation so the master's control port (48620/TCP) is only
  reachable from managed subnets.

## Reporting

Found a security issue? Open a private report / security advisory on the project's
GitHub repository rather than a public issue.
