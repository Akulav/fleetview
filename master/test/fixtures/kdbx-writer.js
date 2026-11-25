// Test-only: writes a KDBX 4.0 file with Node's own crypto (argon2Sync,
// AES-256-CBC / ChaCha20, HMAC), so the browser reader in public/vault/kdbx.js
// is checked against an independent implementation for the Argon2 and
// ChaCha20 variants that keepassxc-cli can't create. Fake data only.

import crypto from "node:crypto";
import zlib from "node:zlib";

const UUID = {
  argon2d: "ef636ddf8c29444b91f7a9a403e30a0c",
  argon2id: "9e298b1956db4773b23dfc3ec6f0a1e6",
  aes256: "31c1f2e6bf714350be5805216afc5aff",
  chacha20: "d6038a2b8b6f4cb5a524339a31dbb59a",
};

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const field = (id, data) => Buffer.concat([Buffer.from([id]), u32(data.length), data]);
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const sha512 = (b) => crypto.createHash("sha512").update(b).digest();
const xmlEsc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function variantDict(items) {
  const parts = [Buffer.from([0x00, 0x01])];
  for (const [type, key, value] of items) {
    const k = Buffer.from(key);
    parts.push(Buffer.from([type]), u32(k.length), k, u32(value.length), value);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function chacha(key, nonce, data) {
  const iv = Buffer.concat([Buffer.alloc(4), nonce]); // 32-bit counter 0 + 96-bit nonce
  const c = crypto.createCipheriv("chacha20", key, iv);
  return Buffer.concat([c.update(data), c.final()]);
}

/** groups: { name, entries: [{title, username, password, url, notes}], groups: [...] } */
export function writeKdbx({ password, root, kdf = "argon2id", cipher = "chacha20", memoryKiB = 1024, iterations = 2, parallelism = 2 }) {
  const masterSeed = crypto.randomBytes(32);
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(cipher === "aes256" ? 16 : 12);
  const header = Buffer.concat([
    u32(0x9aa2d903),
    u32(0xb54bfb67),
    Buffer.from([0x00, 0x00, 0x04, 0x00]), // version 4.0
    field(2, Buffer.from(UUID[cipher], "hex")),
    field(3, u32(1)), // gzip
    field(4, masterSeed),
    field(7, iv),
    field(11, variantDict([
      [0x42, "$UUID", Buffer.from(UUID[kdf], "hex")],
      [0x42, "S", salt],
      [0x04, "P", u32(parallelism)],
      [0x05, "M", u64(memoryKiB * 1024)],
      [0x05, "I", u64(iterations)],
      [0x04, "V", u32(0x13)],
    ])),
    field(0, Buffer.from("\r\n\r\n")),
  ]);

  const composite = sha256(sha256(Buffer.from(password, "utf8")));
  const transformed = crypto.argon2Sync(kdf, { message: composite, nonce: salt, passes: iterations, memory: memoryKiB, parallelism, tagLength: 32 });
  const hmacBase = sha512(Buffer.concat([masterSeed, transformed, Buffer.from([1])]));
  const hmac = (index, data) => crypto.createHmac("sha256", sha512(Buffer.concat([u64(index), hmacBase]))).update(data).digest();

  // Inner stream: ChaCha20 with key/nonce from SHA-512 of a random key.
  const streamKey = crypto.randomBytes(64);
  const sk = sha512(streamKey);
  const streamCipher = crypto.createCipheriv("chacha20", sk.subarray(0, 32), Buffer.concat([Buffer.alloc(4), sk.subarray(32, 44)]));
  const protect = (s) => streamCipher.update(Buffer.from(s, "utf8")).toString("base64");

  const str = (key, value, prot = false) =>
    `<String><Key>${key}</Key>${prot ? `<Value Protected="True">${protect(value)}</Value>` : `<Value>${xmlEsc(value)}</Value>`}</String>`;
  const group = (g) =>
    `<Group><UUID>${crypto.randomBytes(16).toString("base64")}</UUID><Name>${xmlEsc(g.name)}</Name>` +
    (g.entries ?? [])
      .map((e) => `<Entry><UUID>${crypto.randomBytes(16).toString("base64")}</UUID>${str("Title", e.title)}${str("UserName", e.username)}${str("Password", e.password, true)}${str("URL", e.url ?? "")}${str("Notes", e.notes ?? "")}${(e.history ?? []).length ? `<History>${e.history.map((hh) => `<Entry>${str("Title", e.title)}${str("Password", hh, true)}</Entry>`).join("")}</History>` : ""}</Entry>`)
      .join("") +
    (g.groups ?? []).map(group).join("") +
    `</Group>`;
  const xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<KeePassFile><Meta><Generator>fleetview-test</Generator><RecycleBinEnabled>False</RecycleBinEnabled></Meta><Root>${group(root)}</Root></KeePassFile>`;

  // Inner header (stream id 3 = ChaCha20, its key, end), then the XML.
  const inner = Buffer.concat([field(1, u32(3)), field(2, streamKey), field(0, Buffer.alloc(0)), Buffer.from(xml, "utf8")]);
  const compressed = zlib.gzipSync(inner);
  const encKey = sha256(Buffer.concat([masterSeed, transformed]));
  let payload;
  if (cipher === "aes256") {
    const c = crypto.createCipheriv("aes-256-cbc", encKey, iv);
    payload = Buffer.concat([c.update(compressed), c.final()]);
  } else payload = chacha(encKey, iv, compressed);

  const out = [header, sha256(header), hmac(0xffffffffffffffffn, header)];
  const block = (i, data) => {
    const size = u32(data.length);
    return Buffer.concat([hmac(i, Buffer.concat([u64(i), size, data])), size, data]);
  };
  out.push(block(0, payload), block(1, Buffer.alloc(0)));
  return Buffer.concat(out);
}
