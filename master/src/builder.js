// Compiles the agent on the master from the Rust sources next to it (the
// repository checkout the master runs from), so no prebuilt exe is needed.
//
// The master's web address is compiled in as the agent's default master
// (FLEETVIEW_DEFAULT_MASTER_URL) and also written into each downloaded setup's
// config trailer. One build serves every download; it is redone only when the
// agent's sources (or the address) change. Cargo's target folder lives in the
// data folder, so rebuilds after a deploy are incremental.
//
// Windows hosts build natively (MSVC). Other hosts cross-compile to
// x86_64-pc-windows-gnu, which needs `rustup target add x86_64-pc-windows-gnu`
// and mingw-w64 (`apt install gcc-mingw-w64-x86-64`).

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { APP_ROOT } from "./config.js";
import { writeJsonAtomic } from "./store.js";

/** What the agent build depends on, relative to the repository root. */
const SOURCES = ["Cargo.toml", "Cargo.lock", "agent", "shared", "installer/assets"];
const LOG_LINES = 200;

export class AgentBuilder extends EventEmitter {
  constructor({ config, pkg, log }) {
    super();
    this.config = config;
    this.pkg = pkg;
    this.log = log;
    this.root = resolve(config.agentSourceDir || join(APP_ROOT, ".."));
    this.metaPath = join(config.dataDir, "agent", "build.json");
    this.state = "idle"; // idle | building | ready | failed | unavailable
    this.lines = [];
    this.error = null;
    this.startedAt = null;
    this.finishedAt = null;
    this.again = false;
    this.child = null;
    this.meta = readJson(this.metaPath);
    if (!this.available()) this.state = "unavailable";
    else if (this.upToDate()) this.state = "ready";
  }

  /** The agent's sources are next to the master. */
  available() {
    return existsSync(join(this.root, "agent", "Cargo.toml")) && existsSync(join(this.root, "Cargo.toml"));
  }

  target() {
    if (this.config.agentTarget) return this.config.agentTarget;
    return process.platform === "win32" ? "" : "x86_64-pc-windows-gnu";
  }

  /** Changes whenever a rebuild is needed. */
  fingerprint() {
    const h = crypto.createHash("sha256");
    h.update(`url=${this.config.publicUrl}\ntarget=${this.target()}\n`);
    for (const rel of SOURCES) hashTree(h, this.root, rel);
    return h.digest("hex");
  }

  upToDate() {
    return !!this.pkg.info() && this.meta?.fingerprint === this.fingerprint();
  }

  status() {
    return {
      state: this.state,
      available: this.state !== "unavailable",
      version: this.pkg.info()?.version ?? null,
      built_at: this.meta?.built_at ?? null,
      target: this.target() || "native",
      started_at: this.startedAt,
      finished_at: this.finishedAt,
      error: this.error,
      log: this.lines.slice(-40).join("\n"),
    };
  }

  /** Build if the sources changed since the last build (startup, downloads). */
  ensure() {
    if (this.state === "unavailable" || this.state === "building") return;
    if (this.upToDate()) {
      this.state = "ready";
      return;
    }
    this.build();
  }

  /** Start a build now (a running one is followed by another). */
  build() {
    if (!this.available()) {
      this.state = "unavailable";
      this.error = `agent sources not found in ${this.root}`;
      this.emit("status", this.status());
      return;
    }
    if (this.state === "building") {
      this.again = true;
      return;
    }
    const fingerprint = this.fingerprint();
    const targetDir = join(this.config.dataDir, "agent-build");
    mkdirSync(targetDir, { recursive: true });
    const target = this.target();
    this.state = "building";
    this.error = null;
    this.lines = [];
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.log(`building the agent (${target || "native"}) for ${this.config.publicUrl}`);
    this.emit("status", this.status());

    this.run({ fingerprint, targetDir, target }).catch((e) => this.finish(fingerprint, targetDir, target, e.message));
  }

  async run({ fingerprint, targetDir, target }) {
    const cargo = findCargo(this.config.cargo);
    const env = {
      ...process.env,
      CARGO_TARGET_DIR: targetDir,
      FLEETVIEW_DEFAULT_MASTER_URL: this.config.publicUrl,
      CARGO_TERM_COLOR: "never",
    };
    if (target) {
      // Installing the target needs no root and is instant once it's there.
      const rustup = join(dirname(cargo), process.platform === "win32" ? "rustup.exe" : "rustup");
      const r = await this.step(existsSync(rustup) ? rustup : "rustup", ["target", "add", target], env);
      if (r.error?.code === "ENOENT") {
        throw new Error(
          `rustup not found next to ${cargo}. A cargo from the system's packages (apt) can't add Windows targets: ` +
            "install Rust with rustup for the user the site runs as (curl https://sh.rustup.rs -sSf | sh), or point FLEETVIEW_CARGO at its cargo",
        );
      }
      if (r.code !== 0) throw new Error(`rustup target add ${target} failed (exit code ${r.code})`);
      // The mingw linker is a system package: it can't be installed from here.
      if (target.endsWith("-windows-gnu") && process.platform !== "win32" && !onPath("x86_64-w64-mingw32-gcc")) {
        throw new Error("the mingw-w64 linker is missing — install it on the server: sudo apt install gcc-mingw-w64-x86-64");
      }
    }
    const args = ["build", "--release", "--locked", "-p", "fleetview-agent"];
    if (target) args.push("--target", target);
    const r = await this.step(cargo, args, env);
    if (r.error) {
      throw new Error(r.error.code === "ENOENT" ? `cargo not found (${cargo}); install Rust on the master or set FLEETVIEW_CARGO` : r.error.message);
    }
    this.finish(fingerprint, targetDir, target, r.code === 0 ? null : `cargo exited with code ${r.code}${hint(this.lines, target)}`);
  }

  /** Run one command, its output going to the build log. */
  step(cmd, args, env) {
    return new Promise((resolve) => {
      this.lines.push(`$ ${[cmd, ...args].join(" ")}`);
      const child = spawn(cmd, args, { cwd: this.root, env, windowsHide: true });
      this.child = child;
      let pending = "";
      let lastEmit = 0;
      const onData = (d) => {
        pending += d.toString("utf8");
        const parts = pending.split(/\r?\n/);
        pending = parts.pop();
        for (const l of parts) if (l.trim()) this.lines.push(l);
        if (this.lines.length > LOG_LINES) this.lines.splice(0, this.lines.length - LOG_LINES);
        if (Date.now() - lastEmit > 1000) {
          lastEmit = Date.now();
          this.emit("status", this.status());
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      let settled = false;
      const end = (result) => {
        if (settled) return;
        settled = true;
        if (pending.trim()) this.lines.push(pending);
        if (this.child === child) this.child = null;
        resolve(result);
      };
      child.on("error", (error) => end({ code: null, error }));
      child.on("close", (code) => end({ code, error: null }));
    });
  }

  finish(fingerprint, targetDir, target, err) {
    if (this.state !== "building") return;
    this.finishedAt = new Date().toISOString();
    if (!err) {
      const exe = join(targetDir, target || "", "release", "fleetview-agent.exe");
      try {
        const version = this.pkg.save(readFileSync(exe));
        this.meta = { fingerprint, built_at: this.finishedAt, version, target: target || "native", url: this.config.publicUrl };
        writeJsonAtomic(this.metaPath, this.meta);
        this.state = "ready";
        this.log(`agent ${version} built`);
      } catch (e) {
        err = `the build finished but ${exe} is unusable: ${e.message}`;
      }
    }
    if (err) {
      this.state = "failed";
      this.error = err;
      this.log(`agent build failed: ${err}`);
    }
    this.emit("status", this.status());
    if (this.again) {
      this.again = false;
      this.ensure();
    }
  }
  close() {
    this.child?.kill();
    this.child = null;
  }
}

function hint(lines, target) {
  const text = lines.join("\n");
  if (/target may not be installed|can't find crate for `std`/.test(text)) return ` — run: rustup target add ${target}`;
  if (/x86_64-w64-mingw32-(gcc|dlltool)|linker .* not found/.test(text)) return " — install mingw-w64 (apt install gcc-mingw-w64-x86-64)";
  return "";
}

function onPath(exe) {
  return (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, exe)));
}

function findCargo(configured) {
  if (configured) return configured;
  const exe = process.platform === "win32" ? "cargo.exe" : "cargo";
  const home = process.env.CARGO_HOME || join(homedir(), ".cargo");
  const local = join(home, "bin", exe);
  return existsSync(local) ? local : "cargo";
}

function hashTree(h, root, rel) {
  const p = join(root, rel);
  let st;
  try {
    st = statSync(p);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(p).sort()) {
      if (name === "target" || name.startsWith(".")) continue;
      hashTree(h, root, `${rel}/${name}`);
    }
  } else {
    h.update(`${rel}\0${st.size}\0`);
    h.update(readFileSync(p));
  }
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
