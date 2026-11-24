#!/usr/bin/env node
// Move an existing fleet to this master without reinstalling any agent:
// copies the desktop master's identity (master.settings.json — TLS
// certificate, Ed25519 key, enrollment secret) and its known PCs (with their
// pinned agent keys) into this master's data folder.
//
//   npm run import-desktop-master -- "%APPDATA%\FleetView"
//
// The folder holds secrets that give SYSTEM on every PC: copy it only over
// channels you trust and keep the data folder private.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDotEnv, loadConfig } from "../src/config.js";
import { identityPath, loadOrCreateIdentity } from "../src/identity.js";
import { writeJsonAtomic } from "../src/store.js";

loadDotEnv();
const src = process.argv[2];
if (!src) {
  console.error('usage: npm run import-desktop-master -- "<folder with master.settings.json>"');
  process.exit(2);
}
const cfg = loadConfig();
const settingsSrc = join(src, "master.settings.json");
if (!existsSync(settingsSrc)) {
  console.error(`${settingsSrc} not found`);
  process.exit(1);
}
const dest = identityPath(cfg.dataDir);
if (existsSync(dest) && !process.argv.includes("--force")) {
  console.error(`${dest} already exists. Add --force to replace it (agents enrolled with it would stop trusting this master).`);
  process.exit(1);
}
const settings = JSON.parse(readFileSync(settingsSrc, "utf8"));
writeJsonAtomic(dest, settings, { private: true });
const id = loadOrCreateIdentity(cfg.dataDir, { log: () => {} }); // validates it
console.log(`identity imported (certificate ${id.fingerprint.slice(0, 16)}…, ${id.masterName})`);

const knownSrc = join(src, "known_agents.json");
if (existsSync(knownSrc)) {
  const known = JSON.parse(readFileSync(knownSrc, "utf8"));
  const agentsPath = join(cfg.dataDir, "agents.json");
  const current = existsSync(agentsPath) ? JSON.parse(readFileSync(agentsPath, "utf8")) : [];
  const byId = new Map(current.map((a) => [a.agent_id, a]));
  for (const k of known) {
    byId.set(k.agent_id, {
      ...(byId.get(k.agent_id) ?? {}),
      agent_id: k.agent_id,
      hostname: k.hostname,
      first_seen: k.first_seen,
      last_seen: k.last_seen,
      agent_version: k.agent_version ?? "",
      tags: k.tags ?? [],
      notes: k.notes ?? "",
      ips: k.ips ?? [],
      macs: k.macs ?? [],
      os: k.os ?? "",
      user: k.user ?? null,
      key_hash: k.key_hash ?? null,
    });
  }
  writeJsonAtomic(agentsPath, [...byId.values()], { private: true });
  console.log(`${known.length} known PC(s) imported`);
}
console.log("Done. Stop the desktop master before starting this one (both would answer the agents).");
