// The agent package: the one agent exe the master hands out — as a
// self-provisioning setup (config appended as a trailer) and as a remote
// update. Format shared with shared/src/package.rs:
//   [exe image][config json][u32 LE json length]["FVCFG001"]

import { existsSync, readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MARKER = Buffer.from("FLEETVIEW_AGENT_VERSION=");
const MAGIC = Buffer.from("FVCFG001");

export function findAgentVersion(exe) {
  let from = 0;
  for (;;) {
    const i = exe.indexOf(MARKER, from);
    if (i < 0) return null;
    const start = i + MARKER.length;
    const tail = exe.subarray(start, Math.min(exe.length, start + 32));
    const nul = tail.indexOf(0);
    if (nul > 0) {
      const v = tail.subarray(0, nul).toString("latin1");
      if (/^\d+\.\d+\.\d+([-+].*)?$/.test(v)) return v.replace(/[-+].*$/, "");
    }
    from = start;
  }
}

export function splitTrailer(exe) {
  if (exe.length < 12 || !exe.subarray(exe.length - 8).equals(MAGIC)) return { image: exe, config: null };
  const lenAt = exe.length - 12;
  const len = exe.readUInt32LE(lenAt);
  if (len > 64 * 1024 || len > lenAt) return { image: exe, config: null };
  return { image: exe.subarray(0, lenAt - len), config: exe.subarray(lenAt - len, lenAt) };
}

export function withTrailer(exe, configJson) {
  const cfg = Buffer.from(configJson, "utf8");
  JSON.parse(configJson);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(cfg.length);
  return Buffer.concat([splitTrailer(exe).image, cfg, len, MAGIC]);
}

export function compareVersions(a, b) {
  const pa = String(a ?? "").split(".").map(Number);
  const pb = String(b ?? "").split(".").map(Number);
  if (pa.length !== 3 || pa.some(Number.isNaN)) return pb.length === 3 ? -1 : 0;
  if (pb.length !== 3 || pb.some(Number.isNaN)) return 1;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** The agent exe on the master (uploaded in Settings, or FLEETVIEW_AGENT_EXE). */
export class AgentPackage {
  constructor(dataDir, envPath = process.env.FLEETVIEW_AGENT_EXE) {
    this.dir = join(dataDir, "agent");
    this.envPath = envPath || "";
    this.cache = null;
  }
  get path() {
    return this.envPath || join(this.dir, "fleetview-agent.exe");
  }
  /** { version, size } or null when no package is available. */
  info() {
    const p = this.path;
    if (!existsSync(p)) return null;
    const st = statSync(p);
    if (!this.cache || this.cache.mtime !== st.mtimeMs) {
      const image = splitTrailer(readFileSync(p)).image;
      this.cache = { mtime: st.mtimeMs, image, version: findAgentVersion(image) };
    }
    return this.cache.version ? { version: this.cache.version, size: this.cache.image.length } : null;
  }
  image() {
    return this.info() ? this.cache.image : null;
  }
  save(buf) {
    const image = splitTrailer(buf).image;
    const version = findAgentVersion(image);
    if (!version) throw new Error("this is not a FleetView agent 0.2.0 or newer (no version marker)");
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, "fleetview-agent.exe"), image);
    this.envPath = "";
    this.cache = null;
    return version;
  }
}
