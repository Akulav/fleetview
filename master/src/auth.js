// Console login: one admin account (from the environment), scrypt password
// hash, optional TOTP two-step sign-in (required for the password vault),
// HMAC-signed session cookie, login rate limiting.

import crypto from "node:crypto";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "./store.js";
import { newSecret, otpauthUri, verifyTotp } from "./totp.js";

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
    // Sessions issued before the last security change (2FA on/off) are void.
    if (!Number.isInteger(saved.session_epoch)) {
      saved.session_epoch = 1;
      changed = true;
    }
    this.secretsPath = secretsPath;
    this.saved = saved;
    if (changed) this.persist();
    this.failures = new Map(); // ip → { n, first, until }
    this.pendingTotp = null; // { secret, until } while enrolling
  }

  persist() {
    writeJsonAtomic(this.secretsPath, this.saved, { private: true });
  }

  get totpEnabled() {
    return !!this.saved.totp_secret;
  }

  lockedOut(ip) {
    const f = this.failures.get(ip);
    if (f && f.until > Date.now()) throw new Error("too many attempts — wait a few minutes");
  }

  /** Count a failure: 8 in 15 minutes lock the address for 10 minutes. */
  fail(ip) {
    const now = Date.now();
    const f = this.failures.get(ip);
    const recent = f && f.first > now - 15 * 60_000;
    const n = (recent ? f.n : 0) + 1;
    this.failures.set(ip, { n, first: recent ? f.first : now, until: n >= 8 ? now + 10 * 60_000 : 0 });
  }

  checkUserPassword(user, password) {
    const okUser = crypto.timingSafeEqual(
      crypto.createHash("sha256").update(String(user)).digest(),
      crypto.createHash("sha256").update(this.user).digest(),
    );
    const okPw = verifyPassword(String(password ?? ""), this.hash);
    return okUser && okPw;
  }

  /** A code from the authenticator, used once. */
  checkCode(code) {
    const c = verifyTotp(this.saved.totp_secret, code, { lastCounter: this.saved.totp_last_counter ?? -1 });
    if (c === null) return false;
    this.saved.totp_last_counter = c;
    this.persist();
    return true;
  }

  /**
   * Sign in. With 2FA on, a correct password without a code answers
   * `{ needCode: true }` and issues nothing. Throws on wrong input.
   */
  login(ip, user, password, code) {
    this.lockedOut(ip);
    if (!this.checkUserPassword(user, password)) {
      this.fail(ip);
      throw new Error("wrong user name or password");
    }
    if (this.totpEnabled) {
      if (!code) return { needCode: true };
      if (!this.checkCode(code)) {
        this.fail(ip);
        throw new Error("wrong or already used code — wait for the next one");
      }
    }
    this.failures.delete(ip);
    return { token: this.issue(this.user, { mfa: this.totpEnabled }) };
  }

  /** Re-check the password (and code, when 2FA is on) for sensitive actions. */
  stepUp(ip, password, code) {
    this.lockedOut(ip);
    const ok = this.checkUserPassword(this.user, password) && (!this.totpEnabled || this.checkCode(code));
    if (!ok) {
      this.fail(ip);
      throw new Error(this.totpEnabled ? "wrong password or code" : "wrong password");
    }
  }

  // ---- two-step sign-in (TOTP) ----

  beginTotp() {
    this.pendingTotp = { secret: newSecret(), until: Date.now() + 10 * 60_000 };
    return { secret: this.pendingTotp.secret, uri: otpauthUri(this.pendingTotp.secret, { account: this.user }) };
  }

  /** Turn 2FA on with a code from the newly added authenticator. */
  confirmTotp(ip, code) {
    this.lockedOut(ip);
    const p = this.pendingTotp;
    if (!p || p.until < Date.now()) throw new Error("the setup expired — start again");
    const c = verifyTotp(p.secret, code);
    if (c === null) {
      this.fail(ip);
      throw new Error("that code doesn't match — check the phone's clock and try the next code");
    }
    this.saved.totp_secret = p.secret;
    this.saved.totp_last_counter = c;
    this.saved.session_epoch += 1; // other sessions must sign in again, with a code
    this.pendingTotp = null;
    this.persist();
    return this.issue(this.user, { mfa: true });
  }

  disableTotp(ip, password, code) {
    this.stepUp(ip, password, code);
    delete this.saved.totp_secret;
    delete this.saved.totp_last_counter;
    this.saved.session_epoch += 1;
    this.persist();
    return this.issue(this.user, { mfa: false });
  }

  issue(user, { mfa = false } = {}) {
    const body = Buffer.from(
      JSON.stringify({
        u: user,
        exp: Date.now() + this.config.sessionHours * 3600_000,
        e: this.saved.session_epoch,
        mfa,
        n: crypto.randomBytes(8).toString("hex"),
      }),
    ).toString("base64url");
    return `${body}.${this.sign(body)}`;
  }

  sign(body) {
    return crypto.createHmac("sha256", this.key).update(body).digest("base64url");
  }

  /** { user, mfa } of a valid session token, else null. */
  session(token) {
    if (!token) return null;
    const [body, sig] = String(token).split(".");
    if (!body || !sig) return null;
    const expected = Buffer.from(this.sign(body));
    const got = Buffer.from(sig);
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, "base64url").toString());
      if (!(p.exp > Date.now() && p.u === this.user && p.e === this.saved.session_epoch)) return null;
      return { user: p.u, mfa: !!p.mfa && this.totpEnabled };
    } catch {
      return null;
    }
  }

  /** The user of a valid session token, else null. */
  check(token) {
    return this.session(token)?.user ?? null;
  }

  cookie(token, maxAgeSec) {
    const attrs = [`fv_session=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSec}`];
    if (this.config.secureCookies) attrs.push("Secure");
    return attrs.join("; ");
  }
}
