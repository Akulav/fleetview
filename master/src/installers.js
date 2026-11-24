// Installer files: type detection, silent-switch presets, argument parsing,
// and the uploaded-installer library kept on the master.

import crypto from "node:crypto";
import { createWriteStream, mkdirSync, openSync, readSync, closeSync, rmSync, renameSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { JsonFile } from "./store.js";

/** Silent-install presets. `args` is the command line after the file name. */
export const PRESETS = {
  msi: { label: "MSI (Windows Installer)", args: "/qn /norestart", isMsi: true },
  inno: { label: "Inno Setup", args: "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-", isMsi: false },
  nsis: { label: "NSIS", args: "/S", isMsi: false },
  wix: { label: "WiX bundle", args: "/quiet /norestart", isMsi: false },
  installshield: { label: "InstallShield", args: "/s /v/qn", isMsi: false },
  advanced: { label: "Advanced Installer", args: "/exenoui /qn /norestart", isMsi: false },
  squirrel: { label: "Squirrel (per-user)", args: "--silent", isMsi: false },
  custom: { label: "Custom", args: "", isMsi: false },
};

export const WARNINGS = {
  custom: "Unknown installer type: enter the vendor's silent switch. A wrong switch makes the installer wait for a click nobody can give, until the 60-minute timeout.",
  squirrel: "Squirrel installers install per user; run as SYSTEM they land in the system profile. Prefer the vendor's MSI or machine-wide installer.",
};

const SCAN_BYTES = 8 * 1024 * 1024;

/** Detect the installer framework from the file name and its first bytes. */
export function detectKind(fileName, head) {
  if (/\.msi$/i.test(fileName)) return "msi";
  const has = (s) => head.includes(Buffer.from(s, "latin1"));
  const has16 = (s) => head.includes(Buffer.from(s, "utf16le"));
  // Most specific first: bundles embed the names of what they wrap.
  if (has(".wixburn")) return "wix";
  if (has("Inno Setup")) return "inno";
  if (has("Nullsoft") || has("NullsoftInst")) return "nsis";
  if (has("Advanced Installer") || has16("Advanced Installer")) return "advanced";
  if (has("InstallShield") || has16("InstallShield")) return "installshield";
  if (has("Squirrel") && has("Update.exe")) return "squirrel";
  if (has16("Inno Setup")) return "inno";
  return "custom";
}

export function detectFile(path, fileName) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(SCAN_BYTES, statSync(path).size));
    readSync(fd, buf, 0, buf.length, 0);
    return detectKind(fileName, buf);
  } finally {
    closeSync(fd);
  }
}

/** Split a command line into arguments: whitespace separates, double quotes
 * group (and are removed), so `/D="C:\Program Files\X"` stays one argument.
 * The agent re-quotes arguments that contain spaces. */
export function splitArgs(s) {
  const out = [];
  let cur = "";
  let quoted = false;
  let any = false;
  for (const ch of String(s ?? "")) {
    if (ch === '"') {
      quoted = !quoted;
      any = true;
    } else if (/\s/.test(ch) && !quoted) {
      if (any) out.push(cur);
      cur = "";
      any = false;
    } else {
      cur += ch;
      any = true;
    }
  }
  if (any) out.push(cur);
  return out;
}

/** A file name that is safe on Windows (the agent sanitizes too). */
export function safeFileName(name) {
  let n = String(name ?? "").split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/^[. ]+|[. ]+$/g, "");
  if (!n) n = "installer.exe";
  return n.slice(0, 180);
}

/** Uploaded installers, stored under <data>/installers/<id>/<file>. */
export class InstallerLibrary {
  constructor(dataDir) {
    this.dir = join(dataDir, "installers");
    mkdirSync(this.dir, { recursive: true });
    this.file = new JsonFile(join(dataDir, "installers.json"), []);
  }
  list() {
    return this.file.value;
  }
  get(id) {
    return this.file.value.find((x) => x.id === id) ?? null;
  }
  path(item) {
    return join(this.dir, item.id, item.file_name);
  }
  /** Stream an upload to disk, hashing as it goes. Rejects above maxBytes. */
  async add(stream, fileName, maxBytes) {
    const id = crypto.randomBytes(8).toString("hex");
    const name = safeFileName(fileName);
    const dir = join(this.dir, id);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, ".upload");
    const hash = crypto.createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) return cb(new Error(`file is larger than ${Math.round(maxBytes / 1048576)} MB`));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(stream, meter, createWriteStream(tmp));
      if (size === 0) throw new Error("empty file");
      renameSync(tmp, join(dir, name));
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    const sha256 = hash.digest("hex");
    // Same bytes uploaded again: keep the existing entry (and its settings).
    const dup = this.file.value.find((x) => x.sha256 === sha256 && x.file_name === name);
    if (dup) {
      rmSync(dir, { recursive: true, force: true });
      return { item: dup, duplicate: true };
    }
    const kind = detectFile(join(dir, name), name);
    const preset = PRESETS[kind];
    const item = {
      id,
      file_name: name,
      size,
      sha256,
      kind,
      kind_label: preset.label,
      args: preset.args,
      is_msi: preset.isMsi,
      uploaded_at: new Date().toISOString(),
    };
    this.file.value.unshift(item);
    this.file.flush();
    return { item, duplicate: false };
  }
  update(id, patch) {
    const item = this.get(id);
    if (!item) return null;
    if (typeof patch.args === "string") item.args = patch.args.trim();
    if (typeof patch.is_msi === "boolean") item.is_msi = patch.is_msi;
    if (typeof patch.kind === "string" && PRESETS[patch.kind]) {
      item.kind = patch.kind;
      item.kind_label = PRESETS[patch.kind].label;
    }
    this.file.flush();
    return item;
  }
  remove(id) {
    const i = this.file.value.findIndex((x) => x.id === id);
    if (i < 0) return false;
    rmSync(join(this.dir, id), { recursive: true, force: true });
    this.file.value.splice(i, 1);
    this.file.flush();
    return true;
  }
  exists(item) {
    return existsSync(this.path(item));
  }
}

// ---- uninstall ------------------------------------------------------------

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Split an UninstallString into [exe, rest]. */
export function splitCommand(cmd) {
  cmd = String(cmd ?? "").trim();
  if (cmd.startsWith('"')) {
    const end = cmd.indexOf('"', 1);
    return end > 0 ? [cmd.slice(1, end), cmd.slice(end + 1).trim()] : [cmd.slice(1), ""];
  }
  const i = cmd.toLowerCase().indexOf(".exe");
  if (i >= 0) return [cmd.slice(0, i + 4), cmd.slice(i + 4).trim()];
  const sp = cmd.indexOf(" ");
  return sp < 0 ? [cmd, ""] : [cmd.slice(0, sp), cmd.slice(sp + 1).trim()];
}

/** Best-effort silent uninstall script; exits with the uninstaller's code. */
export function uninstallScript(uninstall) {
  const [exe, rest] = splitCommand(uninstall);
  const exeName = exe.split(/[\\/]/).pop().toLowerCase();
  let file = exe;
  let args = rest;
  if (exeName.startsWith("msiexec")) {
    file = "msiexec.exe";
    const m = /\{[0-9A-Fa-f-]+\}/.exec(uninstall);
    if (m) args = `/X ${m[0]} /qn /norestart`;
    else {
      args = rest.replace(/\/I/i, "/X");
      if (!/\/q/i.test(args)) args += " /qn /norestart";
    }
  } else if (exeName.startsWith("unins")) {
    if (!/\/verysilent/i.test(args)) args += " /VERYSILENT /SUPPRESSMSGBOXES /NORESTART";
  } else if (!/\/s\b|\/quiet/i.test(args)) {
    args += " /S";
  }
  args = args.trim();
  const argList = args ? ` -ArgumentList ${psQuote(args)}` : "";
  return `$p = Start-Process -FilePath ${psQuote(file)}${argList} -Wait -PassThru -WindowStyle Hidden\nexit $p.ExitCode`;
}

/** Same table as the agent: what an installer's exit code means. */
export function exitMeaning(code) {
  const t = {
    0: "success",
    3010: "success — restart needed to finish",
    1641: "success — the installer started a restart",
    1602: "cancelled (the installer showed UI that was dismissed)",
    1603: "fatal error during installation",
    1618: "another installation was in progress",
    1619: "the package could not be opened",
    1620: "not a valid MSI",
    1625: "blocked by system policy",
    1633: "package does not support this platform (32/64-bit)",
    1638: "another version is already installed",
    1639: "invalid command-line arguments",
    1: "generic failure — often wrong silent switches",
    2: "generic failure — often wrong silent switches",
  };
  return code === null || code === undefined ? "" : (t[code] ?? "failed");
}
