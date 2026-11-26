// Wires the master together. `startMaster()` is used by server.js and by the
// end-to-end test (with its own data folder and ports).

import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { loadOrCreateIdentity } from "./identity.js";
import { AgentHub } from "./agents.js";
import { startDiscovery } from "./discovery.js";
import { InstallerLibrary } from "./installers.js";
import { AgentPackage } from "./agentpkg.js";
import { AgentBuilder } from "./builder.js";
import { JobEngine } from "./jobs.js";
import { Auth } from "./auth.js";
import { Logs } from "./logs.js";
import { startWeb } from "./web.js";
import { ConfigSync } from "./configsync.js";
import { ScriptLibrary, runAutoScripts } from "./scripts.js";

export async function startMaster(overrides = {}, { quiet = false } = {}) {
  const config = { ...loadConfig(), ...overrides };
  mkdirSync(config.dataDir, { recursive: true });
  const logs = new Logs(config.dataDir, { quiet });
  const log = (m) => logs.write(m);
  const identity = loadOrCreateIdentity(config.dataDir, { masterName: config.masterName, log });
  // e-Management URL (turns on the agents' MoldSign bridge): the environment
  // wins; otherwise the value saved in master.settings.json — set in Settings,
  // or imported from the desktop master, which kept it there.
  config.emanagementFromEnv = !!config.emanagementUrl;
  if (!config.emanagementUrl) config.emanagementUrl = String(identity.raw.emanagement_url ?? "").trim();
  const hub = new AgentHub({ config, identity, log });
  if (config.agentPort !== null) {
    await hub.listen();
    if (overrides.agentPort === 0) config.agentPort = hub.server.address().port;
  }
  // Beacons advertise the direct agent port, so discovery needs it.
  const discovery = config.discovery && config.agentPort !== null ? startDiscovery({ config, identity, log }) : null;
  const library = new InstallerLibrary(config.dataDir);
  const pkg = new AgentPackage(config.dataDir);
  const builder = new AgentBuilder({ config, pkg, log });
  const jobs = new JobEngine({ config, hub, library, pkg, log });
  const auth = new Auth(config, log);
  const configSync = new ConfigSync({ config, hub, jobs, log });
  const scripts = new ScriptLibrary(config.dataDir);
  // Scripts marked "run on new PCs". A short wait first: a new agent may
  // restart once to pick up the master's settings (see configsync.js), and a
  // job created while it is away simply waits for it.
  const autoDelay = config.autoScriptDelayMs ?? 60_000;
  hub.on("enrolled", (agentId) => setTimeout(() => runAutoScripts({ scripts, jobs, agentId, log }), autoDelay).unref?.());
  const web = await startWeb({ config, hub, jobs, library, pkg, builder, auth, identity, logs, configSync, scripts });
  // A prebuilt exe (FLEETVIEW_AGENT_EXE) takes the place of building.
  if (config.agentBuild && !pkg.envPath) builder.ensure();
  log(`${identity.masterName} ready — certificate ${identity.fingerprint.slice(0, 16)}…`);
  return {
    config,
    identity,
    hub,
    jobs,
    configSync,
    scripts,
    library,
    pkg,
    builder,
    auth,
    logs,
    web,
    async close() {
      web.close();
      builder.close();
      configSync.close();
      discovery?.close();
      jobs.close();
      scripts.close();
      hub.close();
    },
  };
}
