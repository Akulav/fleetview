// Password vault storage. Zero-knowledge: the browser encrypts the vault
// (PBKDF2-SHA256 ≥ 600 000 iterations → key-encryption key → AES-256-GCM, see
// public/vault/crypto.js) with a master password that never leaves it. This
// file only stores and returns what the browser sent, after checking that it
// is exactly an encrypted record — base64 salt / IVs / ciphertext and KDF
// parameters, nothing else — so plaintext can't end up on disk by mistake.
//
// The audit log records who did what and when (unlock, save, export…),
// never a secret or an entry name.

import { join } from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { writeJsonAtomic } from "./store.js";

export const MIN_ITERATIONS = 600_000;
const MAX_RECORD_BYTES = 32 * 1024 * 1024;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

const AUDIT_EVENTS = new Set([
  "created",
  "unlocked",
  "unlock_failed",
  "locked",
  "saved",
  "imported",
  "exported_plain",
  "backup_downloaded",
  "backup_restored",
  "password_changed",
  "reset",
]);

function b64(v, { min = 1, max = MAX_RECORD_BYTES } = {}) {
  if (typeof v !== "string" || !B64.test(v)) return false;
  const n = Math.floor((v.length * 3) / 4) - (v.endsWith("==") ? 2 : v.endsWith("=") ? 1 : 0);
  return n >= min && n <= max;
}

/** Throws unless `r` is exactly an encrypted vault record. */
export function validateRecord(r) {
  const fail = (m) => {
    throw Object.assign(new Error(`not an encrypted vault: ${m}`), { status: 400 });
  };
  if (!r || typeof r !== "object" || Array.isArray(r)) fail("expected an object");
  const keys = Object.keys(r).sort().join(",");
  if (keys !== "data,format,kdf,key") fail(`unexpected fields (${keys})`);
  if (r.format !== "fleetview-vault-1") fail("unknown format");
  const k = r.kdf;
  if (!k || Object.keys(k).sort().join(",") !== "hash,iterations,name,salt") fail("bad kdf");
  if (k.name !== "PBKDF2" || k.hash !== "SHA-256") fail("kdf must be PBKDF2-SHA256");
  if (!Number.isInteger(k.iterations) || k.iterations < MIN_ITERATIONS || k.iterations > 10_000_000) {
    fail(`kdf iterations must be at least ${MIN_ITERATIONS}`);
  }
  if (!b64(k.salt, { min: 16, max: 64 })) fail("bad salt");
  for (const part of ["key", "data"]) {
    const p = r[part];
    if (!p || Object.keys(p).sort().join(",") !== "ct,iv") fail(`bad ${part}`);
    if (!b64(p.iv, { min: 12, max: 12 })) fail(`bad ${part} iv`);
    // AES-GCM output = plaintext + 16-byte tag; the wrapped key is 32 + 16.
    if (!b64(p.ct, part === "key" ? { min: 48, max: 48 } : { min: 17 })) fail(`bad ${part} ciphertext`);
  }
  return r;
}

export class VaultStore {
  constructor(dataDir) {
    this.path = join(dataDir, "vault.json");
    this.auditPath = join(dataDir, "vault-audit.json");
    this.doc = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : null;
    this.auditLog = existsSync(this.auditPath) ? JSON.parse(readFileSync(this.auditPath, "utf8")) : [];
  }

  get exists() {
    return !!this.doc;
  }

  /** What the browser gets: the encrypted record and its revision. */
  get() {
    return this.doc ? { revision: this.doc.revision, updated_at: this.doc.updated_at, record: this.doc.record } : null;
  }

  /**
   * Save a new encrypted record. `baseRevision` must match the stored one
   * (null for a new vault), so two open tabs can't overwrite each other.
   */
  put(record, baseRevision) {
    validateRecord(record);
    if (JSON.stringify(record).length > MAX_RECORD_BYTES) {
      throw Object.assign(new Error("the vault is too large"), { status: 413 });
    }
    const current = this.doc?.revision ?? null;
    if ((baseRevision ?? null) !== current) {
      throw Object.assign(new Error("the vault was changed elsewhere — reload it and try again"), { status: 409 });
    }
    this.doc = { revision: (current ?? 0) + 1, updated_at: new Date().toISOString(), record };
    writeJsonAtomic(this.path, this.doc, { private: true });
    return this.doc.revision;
  }

  reset() {
    this.doc = null;
    rmSync(this.path, { force: true });
  }

  /** Append an audit event: metadata only (never secrets). */
  audit(event, { user, ip, count } = {}) {
    if (!AUDIT_EVENTS.has(event)) throw Object.assign(new Error("unknown vault event"), { status: 400 });
    const e = { at: new Date().toISOString(), event, user: String(user ?? "").slice(0, 40), ip: String(ip ?? "").slice(0, 64) };
    if (Number.isInteger(count) && count >= 0) e.count = count;
    this.auditLog.push(e);
    if (this.auditLog.length > 2000) this.auditLog.splice(0, this.auditLog.length - 2000);
    writeJsonAtomic(this.auditPath, this.auditLog, { private: true });
    return e;
  }

  recentAudit(n = 200) {
    return this.auditLog.slice(-n).reverse();
  }
}
