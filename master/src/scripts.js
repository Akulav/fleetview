// Saved scripts: a library of named PowerShell scripts kept on the master
// (scripts.json), run on one PC, a selection, all online PCs or all PCs.
// A script marked "run on new PCs" runs once on every PC that enrolls after
// that (each PC id at most once, remembered in the script's `auto_done`).
//
// A job keeps a copy of the script text it ran, so editing a script later
// never changes what the history says was run.

import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { JsonFile } from "./store.js";
import { DEBLOAT_SCRIPT } from "./debloat.js";

const MAX_SCRIPT = 256 * 1024;
const MAX_SCRIPTS = 500;

export class ScriptLibrary {
  constructor(dataDir) {
    const path = join(dataDir, "scripts.json");
    const fresh = !existsSync(path);
    this.file = new JsonFile(path, []);
    // A first start gets the example; deleting it later keeps it deleted.
    if (fresh) {
      this.file.value.push(record({
        name: "Debloat Windows 10/11 (example)",
        description: "Conservative clean-up: removes consumer apps (games, news, Bing apps…), turns off consumer features, tips and suggested apps, sets telemetry to the minimum. Keeps the Store, Defender, Windows Update and Edge. Edit the lists at the top to taste.",
        script: DEBLOAT_SCRIPT,
        by: "FleetView",
      }));
      this.file.flush();
    }
  }

  list() {
    return this.file.value;
  }
  get(id) {
    return this.file.value.find((s) => s.id === id) ?? null;
  }

  create(input, by = "") {
    if (this.file.value.length >= MAX_SCRIPTS) throw new Error(`at most ${MAX_SCRIPTS} saved scripts`);
    const s = record({ ...clean(input), by });
    this.file.value.push(s);
    this.file.touch();
    return s;
  }

  update(id, input, by = "") {
    const s = this.get(id);
    if (!s) return null;
    const c = clean({ name: s.name, description: s.description, script: s.script, auto_new: s.auto_new, ...input });
    // Turning "run on new PCs" on applies to PCs that enroll from now on.
    if (c.auto_new && !s.auto_new) s.auto_since = new Date().toISOString();
    Object.assign(s, c, { updated_at: new Date().toISOString(), updated_by: by });
    this.file.touch();
    return s;
  }

  remove(id) {
    const i = this.file.value.findIndex((s) => s.id === id);
    if (i < 0) return false;
    this.file.value.splice(i, 1);
    this.file.touch();
    return true;
  }

  /** Scripts that should run on a newly enrolled PC (and mark them done for it). */
  takeAutoRuns(agentId) {
    const out = [];
    for (const s of this.file.value) {
      if (!s.auto_new) continue;
      s.auto_done ??= [];
      if (s.auto_done.includes(agentId)) continue;
      s.auto_done.push(agentId);
      if (s.auto_done.length > 5000) s.auto_done.splice(0, s.auto_done.length - 5000);
      out.push(s);
    }
    if (out.length) this.file.touch();
    return out;
  }

  close() {
    this.file.flush();
  }
}

function record(c) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomBytes(8).toString("hex"),
    name: c.name,
    description: c.description ?? "",
    script: c.script,
    auto_new: !!c.auto_new,
    auto_since: c.auto_new ? now : null,
    auto_done: [],
    created_at: now,
    updated_at: now,
    by: c.by ?? "",
  };
}

/** Validate and normalize user input; throws with a user-facing message. */
export function clean(input) {
  const name = String(input?.name ?? "").trim().replace(/\s+/g, " ");
  const script = String(input?.script ?? "").replace(/\r\n/g, "\n");
  if (!name) throw new Error("give the script a name");
  if (name.length > 100) throw new Error("the name is at most 100 characters");
  if (!script.trim()) throw new Error("the script is empty");
  if (Buffer.byteLength(script) > MAX_SCRIPT) throw new Error("the script is larger than 256 KB");
  return { name, description: String(input?.description ?? "").trim().slice(0, 1000), script, auto_new: !!input?.auto_new };
}

/** What the UI gets (the auto-run bookkeeping as a count). */
export function scriptSummary(s) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    script: s.script,
    auto_new: s.auto_new,
    auto_since: s.auto_since ?? null,
    auto_count: s.auto_done?.length ?? 0,
    created_at: s.created_at,
    updated_at: s.updated_at,
    by: s.by,
  };
}

/** The job for running saved script `s` (the text is copied into the job). */
export function scriptJob(s) {
  const lines = s.script.split("\n").length;
  return {
    kind: "script",
    title: `Script: ${s.name}`,
    detail: `Saved script "${s.name}" (${lines} line${lines === 1 ? "" : "s"})`,
    payload: { script: s.script, script_id: s.id, script_name: s.name },
  };
}

/** Run the "on new PCs" scripts on a PC that just enrolled. */
export function runAutoScripts({ scripts, jobs, agentId, log }) {
  for (const s of scripts.takeAutoRuns(agentId)) {
    try {
      const job = jobs.create({ ...scriptJob(s), agentIds: [agentId], waitOffline: true, by: "auto (new PC)" });
      log(`new PC ${jobs.hub.get(agentId)?.hostname ?? agentId}: runs "${s.name}" (job ${job.id})`);
    } catch (e) {
      log(`new PC ${agentId}: could not queue "${s.name}": ${e.message}`);
    }
  }
}
