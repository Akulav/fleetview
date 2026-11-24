// Wires the master together. `startMaster()` is used by server.js and by the
// end-to-end test (with its own data folder and ports).

import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { loadOrCreateIdentity } from "./identity.js";
import { AgentHub } from "./agents.js";
import { startDiscovery } from "./discovery.js";
import { InstallerLibrary } from "./installers.js";
import { AgentPackage } from "./agentpkg.js";
import { JobEngine } from "./jobs.js";
import { Auth } from "./auth.js";
import { Logs } from "./logs.js";
import { startWeb } from "./web.js";

export async function startMaster(overrides = {}, { quiet = false } = {}) {
  const config = { ...loadConfig(), ...overrides };
  mkdirSync(config.dataDir, { recursive: true });
  const logs = new Logs(config.dataDir, { quiet });
  const log = (m) => logs.write(m);
  const identity = loadOrCreateIdentity(config.dataDir, { masterName: config.masterName, log });
  const hub = new AgentHub({ config, identity, log });
  await hub.listen();
  if (overrides.agentPort === 0) config.agentPort = hub.server.address().port;
  const discovery = config.discovery ? startDiscovery({ config, identity, log }) : null;
  const library = new InstallerLibrary(config.dataDir);
  const pkg = new AgentPackage(config.dataDir);
  const jobs = new JobEngine({ config, hub, library, pkg, log });
  const auth = new Auth(config, log);
  const web = await startWeb({ config, hub, jobs, library, pkg, auth, identity, logs });
  log(`${identity.masterName} ready — certificate ${identity.fingerprint.slice(0, 16)}…`);
  return {
    config,
    identity,
    hub,
    jobs,
    library,
    pkg,
    auth,
    logs,
    web,
    async close() {
      web.close();
      discovery?.close();
      jobs.close();
      hub.close();
    },
  };
}
