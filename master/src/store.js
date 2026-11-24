// Small JSON-file persistence: atomic writes, debounced saves.

import { writeFileSync, renameSync, readFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

export function writeJsonAtomic(path, value, { private: priv = false } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: priv ? 0o600 : 0o644 });
  renameSync(tmp, path);
  if (priv && process.platform !== "win32") chmodSync(path, 0o600);
}

export function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${e.message}); fix or restore it`);
  }
}

/** A JSON file whose value is saved at most every `delayMs` after `touch()`. */
export class JsonFile {
  constructor(path, fallback, { delayMs = 500, private: priv = false } = {}) {
    this.path = path;
    this.value = readJson(path, fallback);
    this.delayMs = delayMs;
    this.priv = priv;
    this.timer = null;
  }
  touch() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
    this.timer.unref?.();
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    writeJsonAtomic(this.path, this.value, { private: this.priv });
  }
}
