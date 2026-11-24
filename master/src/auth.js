// Console login: one admin account (from the environment), scrypt password
// hash, HMAC-signed session cookie, login rate limiting.

import crypto from "node:crypto";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "./store.js";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

/** "scrypt$N$r$p$salt$hash" (base64url parts). */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64url");
  const got = crypto.scryptSync(String(password), Buffer.from(salt, "base64url"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

export class Auth {
  constructor(config, log) {
    this.config = config;
    this.user = config.adminUser;
    const secretsPath = join(config.dataDir, "console.secrets.json");
    const saved = existsSync(secretsPath) ? JSON.parse(readFileSync(secretsPath, "utf8")) : {};
    let changed = false;
    if (config.adminPasswordHash) this.hash = config.adminPasswordHash;
    else if (config.adminPassword) this.hash = hashPassword(config.adminPassword);
    else {
      if (!saved.admin_password_hash) {
        // First run without a configured password: make one and show it once.
        const pw = crypto.randomBytes(12).toString("base64url");
        saved.admin_password_hash = hashPassword(pw);
        changed = true;
        log(`no FLEETVIEW_ADMIN_PASSWORD_HASH set — generated a console password for "${this.user}": ${pw}`);
        log("set your own with `npm run hash-password` and FLEETVIEW_ADMIN_PASSWORD_HASH in .env");
      }
      this.hash = saved.admin_password_hash;
    }
    if (config.sessionSecret) this.key = Buffer.from(config.sessionSecret);
    else {
      if (!saved.session_secret) {
        saved.session_secret = crypto.randomBytes(32).toString("base64url");
        changed = true;
      }
      this.key = Buffer.from(saved.session_secret);
    }
    if (changed) writeJsonAtomic(secretsPath, saved, { private: true });
    this.failures = new Map(); // ip → { n, until }
  }

  /** Throws with a user-facing message when locked out or wrong. */
  login(ip, user, password) {
    const now = Date.now();
    const f = this.failures.get(ip);
    if (f && f.until > now) throw new Error("too many attempts — wait a few minutes");
    const okUser = crypto.timingSafeEqual(
      crypto.createHash("sha256").update(String(user)).digest(),
      crypto.createHash("sha256").update(this.user).digest(),
    );
    const okPw = verifyPassword(String(password ?? ""), this.hash);
    if (!okUser || !okPw) {
      // Count failures in a 15-minute window; 8 of them lock the IP for 10 min.
      const recent = f && f.first > now - 15 * 60_000;
      const n = (recent ? f.n : 0) + 1;
      this.failures.set(ip, { n, first: recent ? f.first : now, until: n >= 8 ? now + 10 * 60_000 : 0 });
      throw new Error("wrong user name or password");
    }
    this.failures.delete(ip);
    return this.issue(this.user);
  }

  issue(user) {
    const body = Buffer.from(
      JSON.stringify({ u: user, exp: Date.now() + this.config.sessionHours * 3600_000, n: crypto.randomBytes(8).toString("hex") }),
    ).toString("base64url");
    return `${body}.${this.sign(body)}`;
  }

  sign(body) {
    return crypto.createHmac("sha256", this.key).update(body).digest("base64url");
  }

  /** The user of a valid session token, else null. */
  check(token) {
    if (!token) return null;
    const [body, sig] = String(token).split(".");
    if (!body || !sig) return null;
    const expected = Buffer.from(this.sign(body));
    const got = Buffer.from(sig);
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, "base64url").toString());
      return p.exp > Date.now() && p.u === this.user ? p.u : null;
    } catch {
      return null;
    }
  }

  cookie(token, maxAgeSec) {
    const attrs = [`fv_session=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSec}`];
    if (this.config.secureCookies) attrs.push("Secure");
    return attrs.join("; ");
  }
}
