// Configuration from environment variables (and an optional `.env` file next
// to package.json). Every setting has a sensible default except secrets,
// which are generated on first run and kept in the data folder.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Parse a .env file (KEY=value, # comments, optional quotes). Values already
 * in the environment win. */
export function loadDotEnv(path = join(APP_ROOT, ".env")) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const bool = (v, dflt) => (v === undefined || v === "" ? dflt : /^(1|true|yes|on)$/i.test(v));
const int = (v, dflt) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : dflt;
};

export function loadConfig(env = process.env) {
  const publicUrl = (env.FLEETVIEW_PUBLIC_URL || "https://fleetview.akulav.com").replace(/\/+$/, "");
  // FLEETVIEW_* wins; otherwise the host platform's PORT / HOST / DATA_DIR
  // (AutoNode, and most Node hosts, set these), then the defaults.
  const httpHost = env.FLEETVIEW_HTTP_HOST || env.HOST || "127.0.0.1";
  const cfg = {
    /** Where people open the console. Used for cookies and links. */
    publicUrl,
    /** The web console listens here (put a reverse proxy with HTTPS in front). */
    httpHost,
    httpPort: int(env.FLEETVIEW_HTTP_PORT, int(env.PORT, 8080)),
    /** Optional HTTPS directly in Node (PEM paths) instead of a proxy. */
    httpsCert: env.FLEETVIEW_HTTPS_CERT || "",
    httpsKey: env.FLEETVIEW_HTTPS_KEY || "",
    /** Trust X-Forwarded-* from the proxy. On by default when bound to loopback. */
    trustProxy: bool(env.FLEETVIEW_TRUST_PROXY, httpHost === "127.0.0.1" || httpHost === "::1" || httpHost === "localhost"),

    /** Optional direct agent port (raw pinned TLS): LAN setups and agents
     * older than 0.6. 0 = off. Agents 0.6+ normally use the web address. */
    agentHost: env.FLEETVIEW_AGENT_HOST || "0.0.0.0",
    agentPort: /^(off|no|false)$/i.test(env.FLEETVIEW_AGENT_PORT ?? "") ? null : int(env.FLEETVIEW_AGENT_PORT, 48620),
    /** Where new agent installers connect: by default the public URL (a
     * WebSocket to <url>/agent, through the same HTTPS as the console).
     * "host:port" uses the direct agent port; "discovery" = LAN broadcast. */
    agentAddress: (env.FLEETVIEW_AGENT_ADDRESS || publicUrl).trim(),
    /** Answer agents' UDP broadcasts on the LAN (port 48621). Only useful
     * when the master shares a LAN with the PCs. */
    discovery: bool(env.FLEETVIEW_DISCOVERY, false),
    discoveryPort: int(env.FLEETVIEW_DISCOVERY_PORT, 48621),

    /** Identity, PCs, jobs, uploads. On AutoNode: its DATA_DIR, which deploys never touch. */
    dataDir: resolve(APP_ROOT, env.FLEETVIEW_DATA_DIR || env.DATA_DIR || "data"),
    masterName: env.FLEETVIEW_MASTER_NAME || "",
    emanagementUrl: (env.FLEETVIEW_EMANAGEMENT_URL || "").trim(),

    adminUser: env.FLEETVIEW_ADMIN_USER || "admin",
    /** scrypt hash from `npm run hash-password`. */
    adminPasswordHash: env.FLEETVIEW_ADMIN_PASSWORD_HASH || "",
    /** Plain password (development only; prefer the hash). */
    adminPassword: env.FLEETVIEW_ADMIN_PASSWORD || "",
    sessionSecret: env.FLEETVIEW_SESSION_SECRET || "",
    sessionHours: int(env.FLEETVIEW_SESSION_HOURS, 12),

    /** Largest installer accepted for upload (MB). */
    maxUploadMb: int(env.FLEETVIEW_MAX_UPLOAD_MB, 2048),
    /** Installs pushed to different PCs at the same time. */
    parallelTransfers: int(env.FLEETVIEW_PARALLEL_TRANSFERS, 4),

    /** Compile the agent here from the repository's Rust sources (at start,
     * and again whenever they change), with publicUrl as its built-in master. */
    agentBuild: bool(env.FLEETVIEW_AGENT_BUILD, true),
    /** Repository root holding agent/ and shared/ (default: next to master/). */
    agentSourceDir: env.FLEETVIEW_AGENT_SOURCE || "",
    /** Rust target; default native on Windows, x86_64-pc-windows-gnu elsewhere. */
    agentTarget: env.FLEETVIEW_AGENT_TARGET || "",
    /** Path to cargo (default ~/.cargo/bin/cargo, then PATH). */
    cargo: env.FLEETVIEW_CARGO || "",
  };
  cfg.secureCookies = cfg.publicUrl.startsWith("https://");
  return cfg;
}
