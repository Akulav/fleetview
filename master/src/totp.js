// Time-based one-time passwords (RFC 6238 / RFC 4226): 6 digits, 30 s,
// HMAC-SHA1 — what Google Authenticator, Microsoft Authenticator, Aegis,
// 1Password, Bitwarden… all use.

import crypto from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newSecret() {
  return base32Encode(crypto.randomBytes(20)); // 160 bits, as RFC 4226 recommends
}

export function hotp(secret, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const code = (mac.readUInt32BE(off) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}

export const counterAt = (ms = Date.now()) => Math.floor(ms / 1000 / 30);

/**
 * Check a code, allowing one step of clock drift either way. Returns the
 * matching counter (so the caller can refuse its reuse) or null.
 */
export function verifyTotp(secret, code, { now = Date.now(), lastCounter = -1 } = {}) {
  const c = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const base = counterAt(now);
  for (const d of [0, -1, 1]) {
    const counter = base + d;
    if (counter <= lastCounter) continue; // each code works once
    const expected = hotp(secret, counter);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return counter;
  }
  return null;
}

/** otpauth:// URI for authenticator apps (QR code or tap-to-add on a phone). */
export function otpauthUri(secret, { issuer = "FleetView", account = "admin" } = {}) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
