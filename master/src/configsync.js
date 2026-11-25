// Keeps every agent's settings in line with the master's.
//
// Today that is the e-Management URL (it turns on the agents' MoldSign
// signing bridge). Whenever an agent connects — and for every online agent
// when the URL is changed in Settings — the master sends it the URL with
// SetConfig. An agent that already has it answers "config unchanged" and
// nothing else happens; one that lacks it (or has another) writes it to its
// agent.config.json and restarts once. So PCs heal themselves: missing on a
// new install, removed by hand, or offline when the URL changed.
//
// The master address is deliberately not synced: a wrong push there could
// cut a PC off from the master, while the URL here can always be corrected.

import crypto from "node:crypto";
import { compareVersions } from "./agentpkg.js";

/** SetConfig exists in agents since 0.3.0; older ones would drop the connection. */
const MIN_AGENT = "0.3.0";
const RESULT_MS = 90_000;

export class ConfigSync {
  constructor({ config, hub, jobs, log }) {
    this.config = config;
    this.hub = hub;
    this.jobs = jobs;
    this.log = log;
    this.inFlight = new Set();
    // Give a freshly connected agent a moment (telemetry, inventory) first.
    this.onOnline = (id) => setTimeout(() => this.sync(id), 3000).unref?.();
    hub.on("online", this.onOnline);
  }

  close() {
    this.hub.off("online", this.onOnline);
  }

  /** Send the master's settings to one agent; records the outcome on it. */
  async sync(id) {
    const url = String(this.config.emanagementUrl ?? "").trim();
    const a = this.hub.get(id);
    // Nothing set on the master: never switch existing bridges off.
    if (!url || !a?.conn || this.inFlight.has(id)) return;
    if (compareVersions(a.agent_version, MIN_AGENT) < 0) {
      a.emanagement = { url, state: "unsupported", at: new Date().toISOString(), detail: `agent ${a.agent_version || "?"} is too old — update it` };
      return this.hub.changed(a);
    }
    this.inFlight.add(id);
    const commandId = crypto.randomUUID();
    const result = this.jobs.waitResult(id, commandId, RESULT_MS);
    this.hub.send(id, { SetConfig: { command_id: commandId, updates: [{ key: "emanagement_url", value: url }] } });
    let state, detail;
    try {
      const r = await result;
      if (!r.success) {
        state = "error";
        detail = (r.stderr || r.stdout || "failed").split(/\r?\n/)[0].slice(0, 200);
        this.log(`${a.hostname}: could not set the e-Management URL: ${detail}`);
      } else if (/unchanged/i.test(r.stdout)) {
        state = "ok";
      } else {
        state = "fixed";
        this.log(`${a.hostname}: e-Management URL was missing or different — set to ${url} (the agent restarts)`);
      }
    } catch (e) {
      // The agent restarting to apply the change also lands here sometimes.
      state = e.offline ? "pending" : "error";
      detail = e.message;
    } finally {
      this.inFlight.delete(id);
    }
    const cur = this.hub.get(id);
    if (cur) {
      // "fixed" is followed by a restart and a reconnect, which re-checks it.
      cur.emanagement = { url, state, at: new Date().toISOString(), detail: detail ?? null };
      this.hub.changed(cur);
    }
  }

  /** After the URL changed in Settings: every online agent now. */
  syncAll() {
    for (const a of this.hub.list()) if (a.conn) this.sync(a.agent_id);
  }
}
