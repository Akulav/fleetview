// Reads KeePass / KeePassXC database files (KDBX 4.x) entirely in the browser:
// the KeePass master password is typed here and never leaves this page.
//
// Supported: password-only databases, KDF Argon2d / Argon2id / AES-KDF,
// cipher AES-256-CBC or ChaCha20, gzip compression. Not supported (with a
// clear message): KDBX 3.1 files, key files, Twofish.
//
// Result: { entries: [{ group: ["ANSC", "Servere cloud"], title, username,
// password, url, notes, fields: [{ name, value }] }], groups: [[…path]] }.

import { argon2 as argon2Sync, ARGON2D, ARGON2ID } from "./argon2.js";
import { ChaCha20 } from "./chacha20.js";
import { parseXml, child, kids } from "./xml.js";

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

const UUID = {
  argon2d: "ef636ddf8c29444b91f7a9a403e30a0c",
  argon2id: "9e298b1956db4773b23dfc3ec6f0a1e6",
  aesKdf: "7c02bb8279a74ac0927d114a00648238",
  aesKdf3: "c9d9f39a628a4460bf740d08c18a4fea",
  aes256: "31c1f2e6bf714350be5805216afc5aff",
  chacha20: "d6038a2b8b6f4cb5a524339a31dbb59a",
  twofish: "ad68f29f576f4bb9a36ad47af965346c",
};

export class KdbxError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};
const sha256 = async (d) => new Uint8Array(await subtle.digest("SHA-256", d));
const sha512 = async (d) => new Uint8Array(await subtle.digest("SHA-512", d));
async function hmacSha256(key, data) {
  const k = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, data));
}
const le64 = (n) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
};
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** KDBX 4 VariantDictionary → { key: value }. */
function readVariantDictionary(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 2; // version (uint16)
  const out = {};
  for (;;) {
    const type = b[p++];
    if (type === 0 || type === undefined) break;
    const klen = dv.getInt32(p, true);
    p += 4;
    const key = dec.decode(b.subarray(p, p + klen));
    p += klen;
    const vlen = dv.getInt32(p, true);
    p += 4;
    const v = b.subarray(p, p + vlen);
    p += vlen;
    const vd = new DataView(v.buffer, v.byteOffset, v.byteLength);
    switch (type) {
      case 0x04: out[key] = vd.getUint32(0, true); break;
      case 0x05: out[key] = Number(vd.getBigUint64(0, true)); break;
      case 0x08: out[key] = v[0] !== 0; break;
      case 0x0c: out[key] = vd.getInt32(0, true); break;
      case 0x0d: out[key] = Number(vd.getBigInt64(0, true)); break;
      case 0x18: out[key] = dec.decode(v); break;
      default: out[key] = v.slice(); break;
    }
  }
  return out;
}

/**
 * AES-KDF: each 16-byte half of the key is AES-256-ECB-encrypted `rounds`
 * times with `seed`, then SHA-256. WebCrypto has no ECB, but AES-CBC over a
 * run of zero blocks with a zero IV is exactly repeated ECB of the first
 * block (C₁ = E(P₁), Cᵢ = E(Cᵢ₋₁ ⊕ 0)), so the native AES does the work in
 * chunks of a million rounds.
 */
async function aesKdf(seed, rounds, composite, onProgress) {
  const key = await subtle.importKey("raw", seed, "AES-CBC", false, ["encrypt"]);
  const zeroIv = new Uint8Array(16);
  const CHUNK = 1 << 20;
  const total = rounds * 2;
  let done = 0;
  const halves = [];
  for (const start of [0, 16]) {
    let cur = composite.slice(start, start + 16);
    let left = rounds;
    while (left > 0) {
      const n = Math.min(left, CHUNK);
      const buf = new Uint8Array(n * 16);
      buf.set(cur, 0);
      const ct = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv: zeroIv }, key, buf));
      cur = ct.slice((n - 1) * 16, n * 16);
      left -= n;
      done += n;
      onProgress?.(done / total);
    }
    halves.push(cur);
  }
  return sha256(concat(halves[0], halves[1]));
}

async function gunzip(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Parse the outer header. Exported for the tests and the import preview. */
export function readHeader(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 12 || dv.getUint32(0, true) !== 0x9aa2d903 || dv.getUint32(4, true) !== 0xb54bfb67) {
    throw new KdbxError("This is not a KeePass database (.kdbx) file.", "format");
  }
  const major = dv.getUint16(10, true);
  if (major < 4) {
    throw new KdbxError(
      "This database uses the older KDBX 3 format. In KeePassXC open Database → Database Security → Encryption Settings, choose format KDBX 4, save, then import again.",
      "version",
    );
  }
  let p = 12;
  const h = {};
  for (;;) {
    const id = b[p];
    const size = dv.getUint32(p + 1, true);
    const data = b.subarray(p + 5, p + 5 + size);
    p += 5 + size;
    if (id === 0) break;
    if (id === 2) h.cipher = hex(data);
    else if (id === 3) h.compression = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true);
    else if (id === 4) h.masterSeed = data.slice();
    else if (id === 7) h.iv = data.slice();
    else if (id === 11) h.kdf = readVariantDictionary(data);
    if (p > b.length) throw new KdbxError("The file is damaged (header).", "format");
  }
  h.headerEnd = p;
  h.kdfName = hex(h.kdf?.$UUID ?? new Uint8Array(0));
  return h;
}

/**
 * Open a KDBX 4 file with its master password.
 * `deriveKey(params)` may be given to run Argon2 elsewhere (a Web Worker);
 * it gets { password, salt, iterations, memoryKiB, parallelism, type } and
 * resolves to the 32-byte key.
 */
export async function readKdbx(buf, masterPassword, { deriveKey, onProgress } = {}) {
  const b = new Uint8Array(buf);
  const h = readHeader(b);

  const isAesKdf = h.kdfName === UUID.aesKdf || h.kdfName === UUID.aesKdf3;
  if (!isAesKdf && h.kdfName !== UUID.argon2d && h.kdfName !== UUID.argon2id) throw new KdbxError("Unknown key derivation in this database.", "kdf");
  if (h.cipher !== UUID.aes256 && h.cipher !== UUID.chacha20) {
    throw new KdbxError(h.cipher === UUID.twofish ? "Twofish-encrypted databases are not supported. Switch the cipher to AES-256 in KeePassXC and save." : "Unknown cipher in this database.", "cipher");
  }

  const headerBytes = b.subarray(0, h.headerEnd);
  const storedHash = b.subarray(h.headerEnd, h.headerEnd + 32);
  const storedHmac = b.subarray(h.headerEnd + 32, h.headerEnd + 64);
  if (!equal(await sha256(headerBytes), storedHash)) throw new KdbxError("The file is damaged (header checksum).", "format");

  // Composite key: password only (key files are not supported).
  const composite = await sha256(await sha256(enc.encode(masterPassword)));
  let transformed;
  if (isAesKdf) {
    transformed = await aesKdf(h.kdf.S, h.kdf.R, composite, onProgress);
  } else {
    const params = {
      password: composite,
      salt: h.kdf.S,
      iterations: h.kdf.I,
      memoryKiB: Math.floor(h.kdf.M / 1024),
      parallelism: h.kdf.P,
      type: h.kdfName === UUID.argon2id ? ARGON2ID : ARGON2D,
    };
    if (h.kdf.V !== 0x13) throw new KdbxError("Unsupported Argon2 version.", "kdf");
    transformed = deriveKey ? await deriveKey(params) : argon2Sync({ ...params, hashLength: 32, onProgress });
  }

  const hmacBase = await sha512(concat(h.masterSeed, transformed, new Uint8Array([1])));
  const headerKey = await sha512(concat(le64(0xffffffffffffffffn), hmacBase));
  if (!equal(await hmacSha256(headerKey, headerBytes), storedHmac)) {
    throw new KdbxError("Wrong KeePass master password (or the database also needs a key file).", "password");
  }

  // HMAC-checked blocks.
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const parts = [];
  let p = h.headerEnd + 64;
  for (let i = 0n; ; i++) {
    const mac = b.subarray(p, p + 32);
    const size = dv.getInt32(p + 32, true);
    const data = b.subarray(p + 36, p + 36 + size);
    p += 36 + size;
    const key = await sha512(concat(le64(i), hmacBase));
    const sizeBytes = b.subarray(p - size - 4, p - size);
    if (!equal(await hmacSha256(key, concat(le64(i), sizeBytes, data)), mac)) throw new KdbxError("The file is damaged (block checksum).", "format");
    if (size === 0) break;
    parts.push(data);
  }
  const encrypted = concat(...parts);

  const encKey = await sha256(concat(h.masterSeed, transformed));
  let plain;
  if (h.cipher === UUID.aes256) {
    const k = await subtle.importKey("raw", encKey, "AES-CBC", false, ["decrypt"]);
    plain = new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv: h.iv }, k, encrypted));
  } else {
    plain = new ChaCha20(encKey, h.iv).xor(encrypted);
  }
  if (h.compression === 1) plain = await gunzip(plain);

  // Inner header: protected-field stream.
  const pd = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  let q = 0;
  let streamId = 0;
  let streamKey = null;
  for (;;) {
    const id = plain[q];
    const size = pd.getInt32(q + 1, true);
    const data = plain.subarray(q + 5, q + 5 + size);
    q += 5 + size;
    if (id === 0) break;
    if (id === 1) streamId = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true);
    else if (id === 2) streamKey = data.slice();
  }
  if (streamId !== 3) throw new KdbxError("Unsupported protected-field cipher in this database.", "cipher");
  const sk = await sha512(streamKey);
  const stream = new ChaCha20(sk.subarray(0, 32), sk.subarray(32, 44));

  const doc = parseXml(dec.decode(plain.subarray(q)));
  const file = child(doc, "KeePassFile");
  if (!file) throw new KdbxError("The database content is not readable.", "format");

  // Protected values are decrypted in document order, history included.
  const unprotect = (node) => {
    for (const c of node.children) {
      if (c.name === "Value" && c.attrs.Protected === "True") {
        const raw = Uint8Array.from(atob(c.text.trim()), (ch) => ch.charCodeAt(0));
        c.text = dec.decode(stream.xor(raw));
        c.attrs.Protected = "Decrypted";
      }
      unprotect(c);
    }
  };
  unprotect(file);

  const meta = child(file, "Meta");
  const recycleBin = child(meta, "RecycleBinEnabled")?.text !== "False" ? child(meta, "RecycleBinUUID")?.text.trim() : null;
  const rootGroup = child(child(file, "Root"), "Group");
  return collect(rootGroup, recycleBin);
}

const STANDARD = new Set(["Title", "UserName", "Password", "URL", "Notes"]);

function collect(rootGroup, recycleBin) {
  const entries = [];
  const groups = [];
  const walk = (g, path) => {
    for (const e of kids(g, "Entry")) {
      const s = {};
      const fields = [];
      for (const str of kids(e, "String")) {
        const k = child(str, "Key")?.text ?? "";
        const v = child(str, "Value")?.text ?? "";
        if (STANDARD.has(k)) s[k] = v;
        else if (v) fields.push({ name: k, value: v });
      }
      entries.push({ group: path, title: s.Title ?? "", username: s.UserName ?? "", password: s.Password ?? "", url: s.URL ?? "", notes: s.Notes ?? "", fields });
    }
    for (const sub of kids(g, "Group")) {
      if (recycleBin && child(sub, "UUID")?.text.trim() === recycleBin) continue;
      const p = [...path, (child(sub, "Name")?.text ?? "").trim() || "Group"];
      groups.push(p);
      walk(sub, p);
    }
  };
  // The root group's own name ("Root", the database name) is not a folder.
  walk(rootGroup, []);
  return { entries, groups };
}
