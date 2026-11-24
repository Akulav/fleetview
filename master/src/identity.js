// The master's identity: what agents pin. Same shape as the desktop master's
// `master.settings.json`, so an existing fleet keeps trusting the new master
// once that file is imported (see scripts/import-desktop-master.js).
//
//   identity.signing_key_b64   Ed25519 seed (32 bytes, base64) — signs LAN beacons
//   cert_pem / key_pem         self-signed TLS certificate for the agent channel
//   cert_fingerprint           SHA-256 of the certificate DER (hex) — pinned by agents
//   enrollment_secret          shared secret every agent presents in its Hello

import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { selfSignedCert, pemToDer } from "./x509.js";
import { writeJsonAtomic } from "./store.js";

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function identityPath(dataDir) {
  return join(dataDir, "master.settings.json");
}

export function loadOrCreateIdentity(dataDir, { masterName = "", log = console.log } = {}) {
  const path = identityPath(dataDir);
  if (existsSync(path)) {
    let s;
    try {
      s = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      // Never silently regenerate: a new identity would orphan every agent.
      throw new Error(`${path} exists but cannot be parsed (${e.message}). Restore it from a backup.`);
    }
    return validate(s, path);
  }
  const cert = selfSignedCert("fleetview-master");
  const s = {
    identity: { signing_key_b64: crypto.randomBytes(32).toString("base64") },
    cert_pem: cert.certPem,
    key_pem: cert.keyPem,
    cert_fingerprint: sha256hex(cert.der),
    enrollment_secret: crypto.randomBytes(24).toString("base64url"),
    master_name: masterName || `FleetView @ ${os.hostname()}`,
    control_port: 48620,
    emanagement_url: "",
    agent_package_path: "",
  };
  writeJsonAtomic(path, s, { private: true });
  log(`created a new master identity in ${path} — back this file up`);
  return validate(s, path);
}

function validate(s, path) {
  const seed = Buffer.from(s?.identity?.signing_key_b64 ?? "", "base64");
  if (seed.length !== 32) throw new Error(`${path}: identity.signing_key_b64 must be 32 bytes`);
  for (const k of ["cert_pem", "key_pem", "enrollment_secret"]) {
    if (!s[k]) throw new Error(`${path}: missing ${k}`);
  }
  const fp = sha256hex(pemToDer(s.cert_pem));
  if (s.cert_fingerprint && s.cert_fingerprint.toLowerCase() !== fp) {
    throw new Error(`${path}: cert_fingerprint does not match cert_pem`);
  }
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicRaw = crypto
    .createPublicKey(privateKey)
    .export({ type: "spki", format: "der" })
    .subarray(-32);
  return {
    raw: s,
    certPem: s.cert_pem,
    keyPem: s.key_pem,
    fingerprint: fp,
    enrollmentSecret: s.enrollment_secret,
    masterName: s.master_name || "FleetView",
    publicKeyB64: publicRaw.toString("base64"),
    /** Base64 Ed25519 signature of `msg`. */
    sign: (msg) => crypto.sign(null, Buffer.from(msg), privateKey).toString("base64"),
  };
}

export function sha256hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Constant-time string comparison. */
export function secretsMatch(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** What the master stores for an agent's key (never the key itself). */
export function agentKeyHash(key) {
  return sha256hex(Buffer.from(String(key).trim(), "utf8"));
}

/** `agent.config.json` for new agent installers. */
export function agentConfigJson(id, { agentAddress = "", emanagementUrl = "" } = {}) {
  const v = {
    agent_id: "",
    master_public_key: id.publicKeyB64,
    master_cert_fingerprint: id.fingerprint,
    enrollment_secret: id.enrollmentSecret,
    master_address: agentAddress || null,
    discovery_targets: [],
    telemetry_interval_secs: 30,
  };
  if (emanagementUrl) v.emanagement_url = emanagementUrl;
  return JSON.stringify(v, null, 2);
}
