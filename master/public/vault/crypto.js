// Vault encryption, done only in the browser (WebCrypto). The server stores
// what `seal` returns and never sees the master password or plaintext.
//
//   master password ──PBKDF2-SHA256 (600 000+ iter, 16-byte salt)──▶ KEK
//   random 256-bit vault key (DEK) ──AES-256-GCM(KEK)──▶ record.key
//   vault JSON ──AES-256-GCM(DEK)──▶ record.data
//
// The two-key layout lets the master password change without re-encrypting
// the data. Each encryption uses a fresh 96-bit IV; the record parts are
// bound to their role with AES-GCM additional data.

const subtle = globalThis.crypto.subtle;
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const enc = new TextEncoder();
const dec = new TextDecoder();

export const FORMAT = "fleetview-vault-1";
export const DEFAULT_ITERATIONS = 600_000;
const AAD_KEY = enc.encode("fleetview-vault-1/key");
const AAD_DATA = enc.encode("fleetview-vault-1/data");

export const b64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function kek(password, salt, iterations) {
  const base = await subtle.importKey("raw", enc.encode(password.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function gcm(op, key, iv, data, aad) {
  return new Uint8Array(await subtle[op]({ name: "AES-GCM", iv, additionalData: aad }, key, data));
}

const importDek = (raw) => subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);

/** A new vault for `password`. Returns { record, session } (session = open vault key). */
export async function createVault(password, contents, { iterations = DEFAULT_ITERATIONS } = {}) {
  const salt = rand(16);
  const raw = rand(32);
  const keyIv = rand(12);
  const wrapped = await gcm("encrypt", await kek(password, salt, iterations), keyIv, raw, AAD_KEY);
  const dek = await importDek(raw);
  raw.fill(0);
  const head = { format: FORMAT, kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: b64(salt) }, key: { iv: b64(keyIv), ct: b64(wrapped) } };
  const record = { ...head, data: await encryptData(dek, contents) };
  return { record, session: { dek, head } };
}

async function encryptData(dek, contents) {
  const iv = rand(12);
  return { iv: b64(iv), ct: b64(await gcm("encrypt", dek, iv, enc.encode(JSON.stringify(contents)), AAD_DATA)) };
}

export class WrongPassword extends Error {}

/** Open a stored record. Throws WrongPassword when the password is wrong. */
export async function openVault(record, password) {
  if (record?.format !== FORMAT) throw new Error("unknown vault format");
  let raw;
  try {
    raw = await gcm("decrypt", await kek(password, unb64(record.kdf.salt), record.kdf.iterations), unb64(record.key.iv), unb64(record.key.ct), AAD_KEY);
  } catch {
    throw new WrongPassword("Wrong master password.");
  }
  const dek = await importDek(raw);
  raw.fill(0);
  const plain = await gcm("decrypt", dek, unb64(record.data.iv), unb64(record.data.ct), AAD_DATA);
  const head = { format: record.format, kdf: record.kdf, key: record.key };
  return { contents: JSON.parse(dec.decode(plain)), session: { dek, head } };
}

/** The record to store after a change (same key, fresh IV). */
export async function sealVault(session, contents) {
  return { ...session.head, data: await encryptData(session.dek, contents) };
}

/** Re-wrap the vault key under a new master password (data unchanged). */
export async function changeMasterPassword(record, oldPassword, newPassword, { iterations = DEFAULT_ITERATIONS } = {}) {
  let raw;
  try {
    raw = await gcm("decrypt", await kek(oldPassword, unb64(record.kdf.salt), record.kdf.iterations), unb64(record.key.iv), unb64(record.key.ct), AAD_KEY);
  } catch {
    throw new WrongPassword("Wrong current master password.");
  }
  const salt = rand(16);
  const keyIv = rand(12);
  const wrapped = await gcm("encrypt", await kek(newPassword, salt, iterations), keyIv, raw, AAD_KEY);
  const dek = await importDek(raw);
  raw.fill(0);
  const head = { format: FORMAT, kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: b64(salt) }, key: { iv: b64(keyIv), ct: b64(wrapped) } };
  return { record: { ...head, data: record.data }, session: { dek, head } };
}

/** Check a password against the record without keeping anything. */
export async function checkMasterPassword(record, password) {
  try {
    await openVault(record, password);
    return true;
  } catch (e) {
    if (e instanceof WrongPassword) return false;
    throw e;
  }
}

// ---- password generator (uniform, rejection sampling) ----

export const CHARSETS = {
  lower: "abcdefghijkmnopqrstuvwxyz",
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  digits: "23456789",
  symbols: "!@#$%^&*()-_=+[]{};:,.?/",
};

export function generatePassword({ length = 20, lower = true, upper = true, digits = true, symbols = true } = {}) {
  const sets = Object.entries({ lower, upper, digits, symbols }).filter(([, on]) => on).map(([k]) => CHARSETS[k]);
  if (!sets.length) sets.push(CHARSETS.lower);
  const all = sets.join("");
  const pick = (chars) => {
    const lim = 256 - (256 % chars.length);
    for (;;) {
      const [x] = rand(1);
      if (x < lim) return chars[x % chars.length];
    }
  };
  for (;;) {
    const out = Array.from({ length: Math.max(4, length) }, () => pick(all));
    // At least one of every chosen kind.
    if (sets.every((s) => out.some((c) => s.includes(c)))) return out.join("");
  }
}
