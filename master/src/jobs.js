// Jobs: everything the master asks agents to do, with a per-PC status.
//
// An install goes through these states on each PC:
//
//   queued → (waiting: PC offline, sent when it connects) → sending (n %)
//          → installing (agent runs it silently as SYSTEM) → succeeded | failed
//
// Rules that make pushes reliable:
//   * Installs on one PC run one after another (MSIs can't overlap), PCs run
//     in parallel with a fleet-wide cap on simultaneous transfers.
//   * Files stream from disk with flow control (bounded unacknowledged bytes)
//     instead of being queued whole in memory.
//   * Nothing is skipped behind the admin's back. "Skip if already installed"
//     is opt-in, and when used it asks the PC for a fresh software list first
//     — the stale list plus an auto-filled name was why pushes "never arrived".
//   * Offline PCs get the install when they connect (if the job says so).
//   * Every outcome carries a reason: exit code + meaning + installer log tail.

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { open } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { JsonFile } from "./store.js";
import { splitArgs, exitMeaning, uninstallScript } from "./installers.js";
import { taskScript, TASKS } from "./tasks.js";
import { actionScript, ACTIONS } from "./accounts.js";
import { renameScript } from "./rename.js";
import { toggleScript, applyToggle } from "./startup.js";
import { parseRecord, cleanSnapshot, cleanSpeed } from "./metrics.js";

const CHUNK = 256 * 1024;
/** Unacknowledged bytes allowed in flight per transfer. */
const WINDOW = 8 * 1024 * 1024;
const ACK_STALL_MS = 120_000;
/** The agent kills an installer after 60 min; allow for the report. */
const INSTALL_RESULT_MS = 70 * 60_000;
const SCRIPT_RESULT_MS = 250 * 60_000; // the agent stops a script after 4 h
const COMMAND_RESULT_MS = 2 * 60_000;
const MAX_JOBS = 300;
const MAX_OUTPUT = 64 * 1024;
const MAX_SEND_ATTEMPTS = 3;

const ACTIVE = new Set(["preparing", "sending", "installing", "running"]);
const DONE = new Set(["succeeded", "failed", "skipped", "cancelled"]);
const newId = () => crypto.randomBytes(16).toString("hex");

export class JobEngine extends EventEmitter {
  constructor({ config, hub, library, pkg, log, metrics = null }) {
    super();
    this.setMaxListeners(0);
    this.config = config;
    this.hub = hub;
    this.library = library;
    this.pkg = pkg;
    this.log = log;
    this.metrics = metrics;
    this.file = new JsonFile(join(config.dataDir, "jobs.json"), []);
    this.installing = new Set(); // agent ids with an install in progress
    /** job id → password for account jobs. Memory only: never in jobs.json. */
    this.secrets = new Map();
    this.transfers = 0;
    // Anything that was mid-flight when the master stopped has an unknown result.
    for (const job of this.file.value) {
      for (const t of Object.values(job.targets)) {
        if (ACTIVE.has(t.state)) {
          Object.assign(t, { state: "failed", message: "the master restarted while this was running — result unknown; check the PC's software list", finished_at: new Date().toISOString() });
        }
        for (const st of t.steps ?? []) if (st.state === "running") Object.assign(st, { state: "failed", message: "the master restarted while this step was running" });
      }
    }
    hub.on("online", () => this.pump());
    this.pumpTimer = setInterval(() => this.pump(), 30_000);
    this.pumpTimer.unref();
  }

  list() {
    return this.file.value;
  }
  get(id) {
    return this.file.value.find((j) => j.id === id) ?? null;
  }
  save(job) {
    this.file.touch();
    if (job) this.emit("job", job);
  }
  close() {
    clearInterval(this.pumpTimer);
    this.file.flush();
  }

  /**
   * kind: install | update | script | uninstall | message | config
   * payload by kind:
   *   install   { installer_id, args, is_msi, skip_if }
   *   update    { version, emanagement_url }
   *   script    { script }
   *   uninstall { name, uninstall: { [agentId]: uninstallString } }
   *   message   { title, body }
   *   config    { updates: [{ key, value }] }
   *   rename    { names: { [agentId]: newName }, restart, delay_sec }
   *   startup   { kind, scope, sid, name, task_path, enable }  (see startup.js)
   *   batch     { steps: [step], stop_on_fail }  — steps run in order on each PC:
   *             { type: "task", task, options, label } | { type: "saved_script", script_id, script, label }
   *             | { type: "mark_cleaned", note, label }
   */
  create({ kind, title, detail = "", agentIds, payload, waitOffline = false, by = "", secret = null }) {
    const ids = [...new Set(agentIds)].filter((id) => this.hub.get(id));
    if (!ids.length) throw new Error("no known PCs selected");
    const job = {
      id: newId().slice(0, 12),
      kind,
      title,
      detail,
      by,
      created_at: new Date().toISOString(),
      wait_offline: !!waitOffline,
      payload,
      targets: {},
    };
    for (const id of ids) {
      job.targets[id] = { hostname: this.hub.get(id).hostname, state: "queued", message: "", progress: 0, attempts: 0 };
    }
    this.file.value.unshift(job);
    if (secret) this.secrets.set(job.id, secret);
    if (this.file.value.length > MAX_JOBS) {
      // Drop the oldest finished jobs.
      for (let i = this.file.value.length - 1; i >= 0 && this.file.value.length > MAX_JOBS; i--) {
        if (Object.values(this.file.value[i].targets).every((t) => DONE.has(t.state))) this.file.value.splice(i, 1);
      }
    }
    this.log(`job ${job.id}: ${title} → ${ids.length} PC(s)`);
    this.save(job);
    this.pump();
    return job;
  }

  cancel(jobId) {
    const job = this.get(jobId);
    if (!job) return null;
    let n = 0;
    for (const t of Object.values(job.targets)) {
      if (t.state === "queued" || t.state === "waiting") {
        this.finish(job, t, "cancelled", "cancelled before it was sent");
        n++;
      }
    }
    this.save(job);
    return n;
  }

  /** Run failed/skipped/cancelled targets again. */
  retry(jobId) {
    const job = this.get(jobId);
    if (!job) return null;
    let n = 0;
    for (const t of Object.values(job.targets)) {
      if (t.state === "failed" || t.state === "skipped" || t.state === "cancelled") {
        Object.assign(t, { state: "queued", message: "", progress: 0, attempts: 0, exit_code: null, output: "", finished_at: null });
        // A batch picks up at the first step that did not succeed.
        for (const st of t.steps ?? []) if (st.state !== "succeeded") Object.assign(st, { state: "queued", message: "" });
        n++;
      }
    }
    this.save(job);
    this.pump();
    return n;
  }

  remove(jobId) {
    const i = this.file.value.findIndex((j) => j.id === jobId);
    if (i < 0) return false;
    if (Object.values(this.file.value[i].targets).some((t) => ACTIVE.has(t.state))) return false;
    this.file.value.splice(i, 1);
    this.save();
    this.emit("removed", jobId);
    return true;
  }

  finish(job, t, state, message, extra = {}) {
    Object.assign(t, { state, message, finished_at: new Date().toISOString(), ...extra });
    this.forgetSecretWhenDone(job);
    this.save(job);
  }

  // ---- dispatch ----------------------------------------------------------

  /** Start whatever can start now. Oldest jobs first. */
  pump() {
    const jobs = [...this.file.value].reverse();
    for (const job of jobs) {
      for (const [id, t] of Object.entries(job.targets)) {
        if (t.state !== "queued" && t.state !== "waiting") continue;
        if (!this.hub.isOnline(id)) {
          if (job.wait_offline) {
            if (t.state !== "waiting") {
              t.state = "waiting";
              t.message = "PC is offline — it gets this when it connects";
              this.save(job);
            }
          } else {
            this.finish(job, t, "skipped", "PC was offline");
          }
          continue;
        }
        if (job.kind === "install" || job.kind === "update") {
          if (this.installing.has(id) || this.transfers >= this.config.parallelTransfers) continue;
          this.installing.add(id);
          this.runInstall(job, id, t).finally(() => {
            this.installing.delete(id);
            this.pump();
          });
        } else {
          this.runCommand(job, id, t);
        }
      }
    }
  }

  /** Resolves with the agent's CommandResult for `commandId`; rejects when
   * the PC disconnects or the time runs out. Call before sending. */
  waitResult(agentId, commandId, ms) {
    let cleanup;
    const p = new Promise((resolve, reject) => {
      const onResult = (id, r) => {
        if (id === agentId && r.command_id === commandId) {
          cleanup();
          resolve(r);
        }
      };
      const onOffline = (id) => {
        if (id === agentId) {
          cleanup();
          reject(Object.assign(new Error("the PC disconnected"), { offline: true }));
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`no result from the PC after ${Math.round(ms / 60000)} min`));
      }, ms);
      cleanup = () => {
        clearTimeout(timer);
        this.hub.off("result", onResult);
        this.hub.off("offline", onOffline);
      };
      this.hub.on("result", onResult);
      this.hub.on("offline", onOffline);
    });
    p.cancel = () => cleanup();
    p.catch(() => {});
    return p;
  }

  /** Ask for a fresh software list and wait for it (or time out). */
  refreshSoftware(agentId, ms = 30_000) {
    return new Promise((resolve) => {
      const done = (ok) => {
        clearTimeout(timer);
        this.hub.off("software", onSw);
        resolve(ok);
      };
      const onSw = (id) => id === agentId && done(true);
      const timer = setTimeout(() => done(false), ms);
      this.hub.on("software", onSw);
      if (!this.hub.send(agentId, "RequestSoftware")) done(false);
    });
  }

  async runInstall(job, agentId, t) {
    t.state = "preparing";
    t.message = "";
    t.progress = 0;
    t.started_at = new Date().toISOString();
    t.attempts = (t.attempts ?? 0) + 1;
    this.save(job);

    // What to send.
    let fileName, total, readChunk, args, isMsi, closeFile = async () => {};
    try {
      if (job.kind === "install") {
        const item = this.library.get(job.payload.installer_id);
        if (!item || !this.library.exists(item)) return this.finish(job, t, "failed", "the installer file is no longer on the master");
        const path = this.library.path(item);
        total = statSync(path).size;
        const fh = await open(path, "r");
        closeFile = () => fh.close();
        readChunk = async (pos, n) => {
          const buf = Buffer.alloc(n);
          const { bytesRead } = await fh.read(buf, 0, n, pos);
          return buf.subarray(0, bytesRead);
        };
        fileName = item.file_name;
        args = splitArgs(job.payload.args);
        isMsi = !!job.payload.is_msi;

        const skip = String(job.payload.skip_if ?? "").trim().toLowerCase();
        if (skip) {
          t.message = "checking installed programs…";
          this.save(job);
          const fresh = await this.refreshSoftware(agentId);
          const hit = (this.hub.get(agentId)?.software ?? []).find((s) => s.name.toLowerCase().includes(skip));
          if (hit && fresh) {
            await closeFile();
            return this.finish(job, t, "skipped", `already installed: ${hit.name}${hit.version ? " " + hit.version : ""}`);
          }
        }
      } else {
        const image = this.pkg.image();
        if (!image) return this.finish(job, t, "failed", "no agent package on the master (Settings → Agent package)");
        total = image.length;
        readChunk = async (pos, n) => image.subarray(pos, pos + n);
        fileName = `fleetview-agent-${this.pkg.info().version}.exe`;
        args = ["update"];
        if (job.payload.emanagement_url) args.push("--set", `emanagement_url=${job.payload.emanagement_url}`);
        isMsi = false;
      }
    } catch (e) {
      await closeFile();
      return this.finish(job, t, "failed", `cannot read the file: ${e.message}`);
    }

    const conn = this.hub.conn(agentId);
    if (!conn) {
      await closeFile();
      t.state = "queued";
      return this.save(job);
    }
    const commandId = newId();
    const transferId = newId();
    t.command_id = commandId;
    const result = this.waitResult(agentId, commandId, INSTALL_RESULT_MS + 30 * 60_000);

    // ---- transfer ----
    let acked = 0;
    let ackWaiter = null;
    // A result before the transfer completes (the agent could not save the
    // file, …) or a disconnect ends any wait for acknowledgements.
    let earlyResult = null;
    let abortErr = null;
    result.then(
      (r) => {
        earlyResult = r;
        ackWaiter?.();
      },
      (e) => {
        abortErr = e;
        ackWaiter?.();
      },
    );
    const onAck = (id, tid, received) => {
      if (id !== agentId || tid !== transferId) return;
      acked = received;
      ackWaiter?.();
    };
    const waitAck = (cond) =>
      new Promise((resolve, reject) => {
        const done = (err) => {
          clearTimeout(timer);
          ackWaiter = null;
          err ? reject(err) : resolve();
        };
        const timer = setTimeout(
          () => done(new Error(`the PC stopped confirming the transfer (${fmtMb(acked)} of ${fmtMb(total)})`)),
          ACK_STALL_MS,
        );
        ackWaiter = () => {
          if (abortErr) done(abortErr);
          else if (earlyResult || cond()) done();
        };
        ackWaiter();
      });
    this.hub.on("ack", onAck);
    this.transfers++;
    t.state = "sending";
    t.message = `sending ${fmtMb(total)}`;
    this.save(job);
    let lastEmit = 0;
    try {
      await conn.sendDrained({
        FileBegin: {
          transfer_id: transferId,
          file_name: fileName,
          total_len: total,
          run_after: { command_id: commandId, args, is_msi: isMsi },
        },
      });
      for (let pos = 0; pos < total && !earlyResult; ) {
        await waitAck(() => pos - acked < WINDOW);
        if (earlyResult) break;
        const data = await readChunk(pos, Math.min(CHUNK, total - pos));
        if (!data.length) throw new Error("the file got shorter while sending");
        await conn.sendDrained({ FileChunk: { transfer_id: transferId, data } });
        pos += data.length;
        t.progress = acked / total;
        if (Date.now() - lastEmit > 300) {
          lastEmit = Date.now();
          this.emit("progress", job, agentId);
        }
      }
      if (!earlyResult) {
        await conn.sendDrained({ FileEnd: { transfer_id: transferId } });
        await waitAck(() => total === 0 || acked >= total);
      }
    } catch (e) {
      this.hub.off("ack", onAck);
      this.transfers--;
      await closeFile();
      result.cancel();
      if ((e.offline || conn.closed) && job.wait_offline && t.attempts < MAX_SEND_ATTEMPTS) {
        t.state = "waiting";
        t.message = "connection lost while sending — will retry when the PC reconnects";
        return this.save(job);
      }
      return this.finish(job, t, "failed", `not delivered: ${e.message}`);
    }
    this.hub.off("ack", onAck);
    this.transfers--;
    await closeFile();
    this.pump(); // the transfer slot is free for another PC

    // ---- install ----
    if (!earlyResult) {
      t.state = "installing";
      t.progress = 1;
      t.delivered_at = new Date().toISOString();
      t.message = job.kind === "update" ? "updating the agent…" : "installing silently as SYSTEM…";
      this.save(job);
    }
    let r;
    try {
      r = await result;
    } catch (e) {
      return this.finish(
        job,
        t,
        "failed",
        e.offline
          ? "the PC disconnected while installing — the result is unknown; check its software list"
          : e.message,
      );
    }
    const output = clip([r.stdout, r.stderr && `[stderr]\n${r.stderr}`].filter(Boolean).join("\n"));
    if (r.success) {
      this.hub.send(agentId, "RequestSoftware");
      const msg =
        job.kind === "update"
          ? `update to ${job.payload.version} started — the agent restarts in a few seconds`
          : r.exit_code !== null && r.exit_code !== 0
            ? `installed (exit ${r.exit_code}: ${exitMeaning(r.exit_code)})`
            : "installed";
      return this.finish(job, t, "succeeded", msg, { exit_code: r.exit_code, output });
    }
    const why =
      r.exit_code !== null
        ? `exit code ${r.exit_code}: ${exitMeaning(r.exit_code)}`
        : (r.stderr || "failed").split("\n")[0];
    return this.finish(job, t, "failed", why, { exit_code: r.exit_code, output });
  }

  async runCommand(job, agentId, t) {
    t.state = "running";
    t.started_at = new Date().toISOString();
    t.attempts = (t.attempts ?? 0) + 1;
    const commandId = newId();
    t.command_id = commandId;
    let msg, ms;
    switch (job.kind) {
      case "script":
        msg = { RunPowerShell: { command_id: commandId, script: job.payload.script } };
        ms = SCRIPT_RESULT_MS;
        break;
      case "uninstall": {
        const u = job.payload.uninstall?.[agentId];
        if (!u) return this.finish(job, t, "skipped", "not installed on this PC");
        msg = { RunPowerShell: { command_id: commandId, script: uninstallScript(u, job.payload.name) } };
        ms = 30 * 60_000; // the script stops the uninstaller after 15 min
        t.message = "uninstalling…";
        break;
      }
      case "config":
        msg = { SetConfig: { command_id: commandId, updates: job.payload.updates } };
        ms = COMMAND_RESULT_MS;
        break;
      case "batch":
        return this.runBatch(job, agentId, t);
      case "message":
        this.hub.send(agentId, { NotifyUser: { title: job.payload.title, body: job.payload.body } });
        return this.finish(job, t, "succeeded", "shown to the user");
      case "task": {
        let s;
        try {
          s = taskScript(job.payload.task, job.payload.options);
        } catch (e) {
          return this.finish(job, t, "failed", e.message);
        }
        msg = { RunPowerShell: { command_id: commandId, script: s.script } };
        ms = (s.minutes + 10) * 60_000;
        t.message = `running (can take up to ${s.minutes} min)…`;
        break;
      }
      case "account": {
        const secret = this.secrets.get(job.id);
        if (ACTIONS[job.payload.action]?.needsPassword && !secret) {
          return this.finish(job, t, "failed", "the password is not kept after a master restart — run it again");
        }
        let script;
        try {
          script = actionScript(job.payload, secret);
        } catch (e) {
          return this.finish(job, t, "failed", e.message);
        }
        msg = { RunPowerShell: { command_id: commandId, script } };
        ms = COMMAND_RESULT_MS * 2;
        break;
      }
      case "rename": {
        const name = job.payload.names?.[agentId];
        if (!name) return this.finish(job, t, "skipped", "no new name for this PC");
        let script;
        try {
          script = renameScript(name, { restart: job.payload.restart, delaySec: job.payload.delay_sec });
        } catch (e) {
          return this.finish(job, t, "failed", e.message);
        }
        msg = { RunPowerShell: { command_id: commandId, script } };
        ms = COMMAND_RESULT_MS * 2;
        t.message = `renaming to ${name}…`;
        break;
      }
      case "startup": {
        let script;
        try {
          script = toggleScript(job.payload);
        } catch (e) {
          return this.finish(job, t, "failed", e.message);
        }
        msg = { RunPowerShell: { command_id: commandId, script } };
        ms = COMMAND_RESULT_MS;
        break;
      }
      default:
        return this.finish(job, t, "failed", `unknown job kind ${job.kind}`);
    }
    this.save(job);
    const result = this.waitResult(agentId, commandId, ms);
    if (!this.hub.send(agentId, msg)) {
      result.cancel();
      t.state = job.wait_offline ? "waiting" : "queued";
      this.save(job);
      return this.pump();
    }
    try {
      const r = await result;
      const output = clip([r.stdout, r.stderr && `[stderr]\n${r.stderr}`].filter(Boolean).join("\n"));
      if (job.kind === "uninstall" && r.success) this.hub.send(agentId, "RequestSoftware");
      if (r.success) this.afterSuccess(job, agentId);
      if (job.kind === "task") this.record(job.payload.task, agentId, r);
      this.finish(job, t, r.success ? "succeeded" : "failed", summarize(job, r), { exit_code: r.exit_code, output });
    } catch (e) {
      this.finish(job, t, "failed", e.message);
    }
  }

  /** Keep what the master knows about the PC in line with what just changed. */
  afterSuccess(job, agentId) {
    const a = this.hub.get(agentId);
    if (!a) return;
    if (job.kind === "rename") {
      const name = job.payload.names?.[agentId];
      // Until the PC restarts and reconnects under its new name.
      a.pending_name = name && name.toUpperCase() !== String(a.hostname).toUpperCase() ? name : null;
      this.hub.save();
      this.hub.changed(a);
    } else if (job.kind === "startup" && applyToggle(a.startup, job.payload)) {
      this.hub.save();
      this.hub.changed(a);
    }
  }

  /** Keep what a performance snapshot or speed test measured. */
  record(task, agentId, r) {
    if (!this.metrics) return;
    if (task === "perf_snapshot") {
      const snap = cleanSnapshot(parseRecord(r.stdout, "FVPERF"));
      if (snap) this.metrics.addSnapshot(agentId, snap);
    } else if (task === "speed_test") {
      const sp = cleanSpeed(parseRecord(r.stdout, "FVSPEED"));
      if (sp) this.metrics.addSpeed(agentId, sp);
    } else return;
    const a = this.hub.get(agentId);
    if (a) this.hub.changed(a);
  }

  /** Mark a PC as cleaned (by a person, or as the last step of a batch). */
  markCleaned(agentId, by, note = "") {
    const a = this.hub.get(agentId);
    if (!a) return null;
    a.cleaned = { at: new Date().toISOString(), by: String(by ?? ""), note: String(note ?? "").slice(0, 300) };
    a.cleanings = [...(a.cleanings ?? []), a.cleaned].slice(-20);
    this.hub.save();
    this.hub.changed(a);
    return a.cleaned;
  }
  unmarkCleaned(agentId) {
    const a = this.hub.get(agentId);
    if (!a?.cleaned) return false;
    a.cleaned = null;
    this.hub.save();
    this.hub.changed(a);
    return true;
  }

  /** Run a script on an online PC outside any job (scheduled measurements):
   * resolves with the agent's result, rejects when offline or out of time. */
  quiet(agentId, script, ms) {
    const commandId = newId();
    const result = this.waitResult(agentId, commandId, ms);
    if (!this.hub.send(agentId, { RunPowerShell: { command_id: commandId, script } })) {
      result.cancel();
      return Promise.reject(new Error("the PC is offline"));
    }
    return result;
  }

  /** A batch on one PC: its steps one after another, each with its own result. */
  async runBatch(job, agentId, t) {
    const steps = job.payload.steps ?? [];
    if (!t.steps || t.steps.length !== steps.length) t.steps = steps.map((s) => ({ label: s.label, state: "queued", message: "" }));
    const outputs = t.output ? [t.output] : [];
    this.save(job);
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const st = t.steps[i];
      if (st.state === "succeeded") continue;
      const failedSoFar = t.steps.slice(0, i).some((x) => x.state === "failed");
      if (failedSoFar && (job.payload.stop_on_fail || s.type === "mark_cleaned")) {
        Object.assign(st, { state: "skipped", message: s.type === "mark_cleaned" ? "not marked: an earlier step failed" : "skipped: an earlier step failed" });
        continue;
      }
      t.message = `step ${i + 1} of ${steps.length}: ${s.label}`;
      Object.assign(st, { state: "running", message: "", started_at: new Date().toISOString() });
      this.save(job);
      if (s.type === "mark_cleaned") {
        this.markCleaned(agentId, job.by, s.note);
        Object.assign(st, { state: "succeeded", message: "marked as cleaned" });
        continue;
      }
      let script, minutes;
      try {
        if (s.type === "task") ({ script, minutes } = taskScript(s.task, s.options));
        else if (s.type === "saved_script") ({ script, minutes } = { script: s.script, minutes: 240 });
        else throw new Error(`unknown step ${s.type}`);
      } catch (e) {
        Object.assign(st, { state: "failed", message: e.message });
        continue;
      }
      const commandId = newId();
      t.command_id = commandId;
      const result = this.waitResult(agentId, commandId, (minutes + 10) * 60_000);
      const pause = () => {
        // Offline: the rest runs when the PC is back (or is skipped).
        Object.assign(st, { state: "queued", message: "" });
        t.state = job.wait_offline ? "waiting" : "queued";
        t.output = outputs.join("\n\n");
        this.save(job);
        setImmediate(() => this.pump());
      };
      if (!this.hub.send(agentId, { RunPowerShell: { command_id: commandId, script } })) {
        result.cancel();
        return pause();
      }
      let r;
      try {
        r = await result;
      } catch (e) {
        if (e.offline) return pause();
        Object.assign(st, { state: "failed", message: e.message });
        outputs.push(`=== ${s.label}: ${e.message}`);
        continue;
      }
      const like = s.type === "task" ? { kind: "task", payload: { task: s.task } } : { kind: "script", payload: { script_id: s.script_id } };
      Object.assign(st, { state: r.success ? "succeeded" : "failed", message: summarize(like, r), exit_code: r.exit_code });
      outputs.push(`=== ${s.label} (${r.success ? "done" : "failed"})\n${[r.stdout, r.stderr && `[stderr]\n${r.stderr}`].filter(Boolean).join("\n").trim()}`);
      if (s.type === "task") this.record(s.task, agentId, r);
    }
    const failed = t.steps.filter((x) => x.state === "failed");
    const done = t.steps.filter((x) => x.state === "succeeded").length;
    const msg = failed.length
      ? `${done} of ${steps.length} steps done — failed: ${failed.map((x) => x.label).join(", ")}`.slice(0, 300)
      : `all ${steps.length} steps done`;
    this.finish(job, t, failed.length ? "failed" : "succeeded", msg, { output: clip(outputs.join("\n\n")), exit_code: null });
  }

  /** Drop a job's password once no target can use it any more. */
  forgetSecretWhenDone(job) {
    if (!this.secrets.has(job.id)) return;
    if (Object.values(job.targets).every((x) => DONE.has(x.state))) this.secrets.delete(job.id);
  }
}

/** One line for the Activity list: what the script said, or why it failed. */
function summarize(job, r) {
  const lines = (s) => String(s ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = lines(r.stdout);
  // PowerShell errors: the message is the first line; "At C:\..." etc. follow.
  const err = lines(r.stderr).find((l) => !/^(At |\+ |CategoryInfo|FullyQualifiedErrorId)/.test(l)) ?? "";
  const last = out[out.length - 1] ?? "";
  // Ad-hoc scripts print anything; saved scripts and tasks end with a summary.
  if (r.success) return (job.kind === "script" && !job.payload?.script_id ? "done" : last || "done").slice(0, 300);
  if (job.kind === "task") {
    const meaning = TASKS[job.payload.task]?.failMeaning;
    if (r.exit_code === 1 && meaning) return meaning;
  }
  return `${err || last || "failed"}`.slice(0, 300) + (r.exit_code !== null && !err ? ` (exit ${r.exit_code})` : "");
}

function clip(s) {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… [output truncated]` : s;
}
function fmtMb(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
