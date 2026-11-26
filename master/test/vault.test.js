// Password vault, two-step sign-in and the importers. Fake data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hotp, base32Encode, base32Decode, verifyTotp, counterAt } from "../src/totp.js";
import { Auth, hashPassword } from "../src/auth.js";
import { validateRecord, VaultStore } from "../src/vault.js";
import { createVault, openVault, sealVault, changeMasterPassword, checkMasterPassword, WrongPassword, generatePassword } from "../public/vault/crypto.js";
import { readKdbx } from "../public/vault/kdbx.js";
import { entriesFromCsv, entriesToCsv, parseCsv } from "../public/vault/csv.js";
import { ChaCha20 } from "../public/vault/chacha20.js";
import { qrMatrix } from "../public/qr.js";
import { writeKdbx } from "./fixtures/kdbx-writer.js";
import { startMaster } from "../src/master.js";

const tmp = (p) => mkdtempSync(join(tmpdir(), p));

// ---------------------------------------------------------------- TOTP --

test("TOTP matches RFC 6238 (SHA-1 vectors)", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(base32Decode(secret).toString(), "12345678901234567890");
  for (const [t, code] of [[59, "94287082"], [1111111109, "07081804"], [1234567890, "89005924"], [2000000000, "69279037"]]) {
    assert.equal(hotp(secret, Math.floor(t / 30), 8), code, `t=${t}`);
  }
  const now = 1_700_000_000_000;
  const c = hotp(secret, counterAt(now));
  assert.equal(verifyTotp(secret, c, { now }), counterAt(now));
  assert.equal(verifyTotp(secret, hotp(secret, counterAt(now) - 1), { now }), counterAt(now) - 1, "one step of drift");
  assert.equal(verifyTotp(secret, hotp(secret, counterAt(now) - 3), { now }), null, "too old");
  assert.equal(verifyTotp(secret, c, { now, lastCounter: counterAt(now) }), null, "no replay");
  assert.equal(verifyTotp(secret, "12345", { now }), null);
});

test("sign-in with two-step codes; enabling it signs out other sessions", () => {
  const dir = tmp("fv-2fa-");
  try {
    const a = new Auth({ dataDir: dir, adminUser: "admin", adminPasswordHash: hashPassword("pw-123456789"), sessionHours: 1 }, () => {});
    const before = a.login("1.1.1.1", "admin", "pw-123456789").token;
    assert.deepEqual(a.session(before), { user: "admin", mfa: false });
    const { secret, uri } = a.beginTotp();
    assert.match(uri, /^otpauth:\/\/totp\/FleetView:admin\?secret=[A-Z2-7]+&issuer=FleetView/);
    assert.throws(() => a.confirmTotp("1.1.1.1", "000000"), /doesn't match/);
    const { token: tok, codes } = a.confirmTotp("1.1.1.1", hotp(secret, counterAt()));
    assert.deepEqual(a.session(tok), { user: "admin", mfa: true });
    assert.equal(codes.length, 10);
    assert.equal(a.recoveryLeft, 10);
    assert.equal(a.session(before), null, "older sessions are void");
    assert.deepEqual(a.login("1.1.1.1", "admin", "pw-123456789"), { needCode: true }, "password alone is not enough");
    assert.throws(() => a.login("1.1.1.1", "admin", "pw-123456789", "111111"), /wrong or already used/);
    // The code used to confirm can't be used again.
    assert.throws(() => a.login("1.1.1.1", "admin", "pw-123456789", hotp(secret, counterAt())), /already used/);
    const next = hotp(secret, counterAt() + 1); // allowed: one step of drift
    assert.deepEqual(a.session(a.login("1.1.1.1", "admin", "pw-123456789", next).token), { user: "admin", mfa: true });
    // Persisted: a restarted master still requires the code.
    const b = new Auth({ dataDir: dir, adminUser: "admin", adminPasswordHash: hashPassword("pw-123456789"), sessionHours: 1 }, () => {});
    assert.ok(b.totpEnabled);
    assert.equal(b.recoveryLeft, 10);
    assert.ok(!readFileSync(join(dir, "console.secrets.json"), "utf8").includes(codes[0].replace(/-/g, "")), "only hashes are stored");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery codes: each signs in once, typed loosely; new ones void the old", () => {
  const dir = tmp("fv-rec-");
  try {
    const a = new Auth({ dataDir: dir, adminUser: "admin", adminPasswordHash: hashPassword("pw-123456789"), sessionHours: 1 }, () => {});
    const { secret } = a.beginTotp();
    const { codes } = a.confirmTotp("1.1.1.1", hotp(secret, counterAt()));
    assert.ok(codes.every((c) => /^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/.test(c)), codes.join());
    assert.equal(new Set(codes).size, 10);
    const r = a.login("1.1.1.1", "admin", "pw-123456789", codes[0]);
    assert.deepEqual(a.session(r.token), { user: "admin", mfa: true });
    assert.equal(r.recovery, true);
    assert.equal(r.recoveryLeft, 9);
    assert.throws(() => a.login("1.1.1.1", "admin", "pw-123456789", codes[0]), /wrong or already used/, "once only");
    // Lower case, spaces instead of dashes, O typed as 0: still accepted.
    const loose = codes[1].toLowerCase().replace(/-/g, " ").replace(/o/g, "0");
    assert.equal(a.login("1.1.1.1", "admin", "pw-123456789", loose).recovery, true);
    assert.throws(() => a.login("1.1.1.1", "admin", "pw-123456789", "AAAA-BBBB-CCCC-DDDD"), /wrong/);
    // Also accepted where a code confirms a sensitive action.
    a.stepUp("1.1.1.1", "pw-123456789", codes[2]);
    assert.equal(a.recoveryLeft, 7);
    // New codes (password + a code) void the old ones.
    assert.throws(() => a.regenerateRecovery("1.1.1.1", "wrong", codes[3]), /wrong/);
    const fresh = a.regenerateRecovery("1.1.1.1", "pw-123456789", codes[3]);
    assert.equal(a.recoveryLeft, 10);
    assert.throws(() => a.login("1.1.1.1", "admin", "pw-123456789", codes[4]), /wrong/, "old codes are void");
    assert.equal(a.login("1.1.1.1", "admin", "pw-123456789", fresh[0]).recovery, true);
    // Turning 2FA off removes them.
    a.disableTotp("1.1.1.1", "pw-123456789", fresh[1]);
    assert.equal(a.recoveryLeft, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------- vault crypto --

test("vault: encrypt, open, wrong password, change master password", async () => {
  const contents = { v: 1, groups: [{ id: "g1", name: "Servere", parent: null }], entries: [{ id: "e1", group: "g1", title: "Fake box", username: "root", password: "Fake-Secret-ăîș-42" }] };
  const { record, session } = await createVault("correct horse battery staple", contents, { iterations: 600_000 });
  validateRecord(record);
  assert.equal(record.kdf.iterations, 600_000);
  assert.ok(!JSON.stringify(record).includes("Fake"), "record holds no plaintext");
  const opened = await openVault(record, "correct horse battery staple");
  assert.deepEqual(opened.contents, contents);
  await assert.rejects(openVault(record, "wrong"), WrongPassword);
  // Sealing reuses the key with a fresh IV.
  const sealed = await sealVault(session, { ...contents, entries: [] });
  assert.notEqual(sealed.data.iv, record.data.iv);
  assert.deepEqual((await openVault(sealed, "correct horse battery staple")).contents.entries, []);
  // New master password: same data, old password no longer opens it.
  const changed = await changeMasterPassword(record, "correct horse battery staple", "new long master password");
  assert.equal(changed.record.data.ct, record.data.ct);
  assert.deepEqual((await openVault(changed.record, "new long master password")).contents, contents);
  assert.equal(await checkMasterPassword(changed.record, "correct horse battery staple"), false);
  // Tampering is detected (AES-GCM).
  const bad = structuredClone(record);
  bad.data.ct = bad.data.ct.slice(0, -4) + (bad.data.ct.endsWith("AAA=") ? "BBB=" : "AAA=");
  await assert.rejects(openVault(bad, "correct horse battery staple"));
});

test("the server refuses anything but an encrypted record", () => {
  const good = { format: "fleetview-vault-1", kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 600000, salt: Buffer.alloc(16, 1).toString("base64") }, key: { iv: Buffer.alloc(12).toString("base64"), ct: Buffer.alloc(48).toString("base64") }, data: { iv: Buffer.alloc(12).toString("base64"), ct: Buffer.alloc(40).toString("base64") } };
  validateRecord(good);
  const bad = (mut) => {
    const r = structuredClone(good);
    mut(r);
    assert.throws(() => validateRecord(r), /not an encrypted vault/);
  };
  bad((r) => (r.entries = [{ title: "x", password: "y" }]));
  bad((r) => (r.kdf.iterations = 100_000));
  bad((r) => (r.data.ct = "not base64 at all!"));
  bad((r) => (r.data.plain = "x"));
  bad((r) => (r.key.ct = Buffer.alloc(10).toString("base64")));
  bad((r) => (r.format = "x"));
});

test("password generator", () => {
  for (let i = 0; i < 50; i++) {
    const p = generatePassword({ length: 16 });
    assert.equal(p.length, 16);
    assert.match(p, /[a-z]/);
    assert.match(p, /[A-Z]/);
    assert.match(p, /\d/);
    assert.match(p, /[^A-Za-z0-9]/); // not \W: "_" is one of the symbols
  }
  assert.match(generatePassword({ length: 10, symbols: false }), /^[A-Za-z0-9]{10}$/);
});

// -------------------------------------------------------------- importers --

const PW = "fake-master-Pa55";

test("reads a real KeePassXC file (keepassxc-cli: AES-KDF, AES-256)", async () => {
  const buf = readFileSync(new URL("./fixtures/sample.kdbx", import.meta.url));
  const r = await readKdbx(buf, PW);
  assert.equal(r.entries.length, 3, "the deleted (Recycle Bin) entry is skipped");
  const web = r.entries.find((e) => e.title === "Web server");
  assert.deepEqual(web.group, ["ANSC", "Servere cloud"]);
  assert.equal(web.password, 'S3rv3r-p@ss "quoted" <tag> & ăîșț');
  assert.equal(r.entries.find((e) => e.title === "Router principal").notes, "line one\nline two");
  assert.deepEqual(r.entries.find((e) => e.title === "PC").group, ["ANSC", "Angajați", "Ion Popescu"]);
  await assert.rejects(readKdbx(buf, "wrong"), /Wrong KeePass master password/);
});

for (const [kdf, cipher] of [["argon2id", "chacha20"], ["argon2d", "aes256"], ["argon2d", "chacha20"]]) {
  test(`reads KDBX 4 with ${kdf} + ${cipher}`, async () => {
    const root = {
      name: "Root",
      entries: [{ title: "Top", username: "u0", password: "p0" }],
      groups: [{ name: "ANSC", groups: [{ name: "Rețea & Wi-Fi", entries: [{ title: "AP", username: "admin", password: "W1f1-ș", url: "https://192.0.2.5", notes: "a < b", history: ["old-1", "old-2"] }, { title: "Switch", username: "sw", password: "Sw-pass" }] }] }],
    };
    const buf = writeKdbx({ password: PW, root, kdf, cipher });
    const r = await readKdbx(buf, PW);
    assert.deepEqual(
      r.entries.map((e) => [e.group.join("/"), e.title, e.username, e.password, e.url, e.notes]),
      [["", "Top", "u0", "p0", "", ""], ["ANSC/Rețea & Wi-Fi", "AP", "admin", "W1f1-ș", "https://192.0.2.5", "a < b"], ["ANSC/Rețea & Wi-Fi", "Switch", "sw", "Sw-pass", "", ""]],
      "protected values decrypt in document order, history included",
    );
    await assert.rejects(readKdbx(buf, "nope"), /Wrong KeePass master password/);
  });
}

test("ChaCha20 matches node:crypto", () => {
  const key = crypto.randomBytes(32), nonce = crypto.randomBytes(12), data = crypto.randomBytes(1000);
  const ref = crypto.createCipheriv("chacha20", key, Buffer.concat([Buffer.alloc(4), nonce]));
  assert.deepEqual(Buffer.from(new ChaCha20(key, nonce).xor(data)), Buffer.concat([ref.update(data), ref.final()]));
});

test("CSV import (KeePassXC export format) and export round trip", () => {
  const csv = '﻿"Group","Title","Username","Password","URL","Notes","TOTP","Icon","Last Modified","Created"\r\n' +
    '"Root/ANSC/Servere cloud","Web","root","p""q,r","ssh://203.0.113.9","multi\r\nline","","0","2026-11-24","2026-11-24"\r\n' +
    '"Root/ANSC","Mail","ion@example.com","m@il","","","otpauth://totp/x","0","",""\r\n';
  const es = entriesFromCsv(csv);
  assert.equal(es.length, 2);
  assert.deepEqual(es[0].group, ["ANSC", "Servere cloud"]);
  assert.equal(es[0].password, 'p"q,r');
  assert.equal(es[0].notes, "multi\r\nline");
  assert.deepEqual(es[1].fields, [{ name: "TOTP", value: "otpauth://totp/x" }]);
  const back = entriesFromCsv(entriesToCsv(es.map((e) => ({ ...e, groupPath: e.group.join("/") }))));
  assert.deepEqual(back.map((e) => [e.group, e.title, e.password, e.notes]), es.map((e) => [e.group, e.title, e.password, e.notes]));
  assert.throws(() => entriesFromCsv("a,b\n1,2\n"), /no Title/);
  assert.deepEqual(parseCsv('a,"b\nc"\n'), [["a", "b\nc"]]);
});

test("QR: version 7 code carries the right version information", () => {
  const m = qrMatrix("x".repeat(110)); // 107–122 bytes need version 7 at level M
  const size = m.length;
  assert.equal(size, 45);
  // Version info for 7 is 0x07C94 (ISO 18004 Annex D), bottom-left copy.
  let a = 0, b = 0;
  for (let i = 0; i < 18; i++) {
    if (m[size - 11 + (i % 3)][Math.floor(i / 3)]) a |= 1 << i; // bottom-left copy
    if (m[Math.floor(i / 3)][size - 11 + (i % 3)]) b |= 1 << i; // top-right copy
  }
  assert.equal(a, 0x07c94);
  assert.equal(b, 0x07c94);
});

// ------------------------------------------------- server: ciphertext only --

test("the master stores only ciphertext, and only for 2FA sessions", async () => {
  const dir = tmp("fv-vault-srv-");
  const m = await startMaster(
    { dataDir: dir, httpHost: "127.0.0.1", httpPort: 0, agentPort: null, discovery: false, publicUrl: "http://127.0.0.1", secureCookies: false, adminUser: "admin", adminPassword: "console-pw-123", adminPasswordHash: "" },
    { quiet: true },
  );
  try {
    const base = `http://127.0.0.1:${m.web.port}`;
    let cookie = "";
    const call = async (method, path, body) => {
      const res = await fetch(base + path, { method, headers: { "X-FleetView": "1", cookie, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get("set-cookie");
      if (sc) cookie = sc.split(";")[0];
      return { status: res.status, data: await res.json() };
    };
    await call("POST", "/api/login", { user: "admin", password: "console-pw-123" });
    assert.equal((await call("GET", "/api/vault")).status, 403, "no vault without two-step sign-in");
    const setup = (await call("POST", "/api/2fa/setup", { password: "console-pw-123" })).data;
    assert.equal((await call("POST", "/api/2fa/confirm", { code: hotp(setup.secret, counterAt()) })).status, 200);
    assert.equal((await call("GET", "/api/vault")).data.exists, false);

    // A vault full of distinctive fake secrets.
    const MARK = "ZZ-plaintext-marker-" + crypto.randomBytes(4).toString("hex");
    const contents = { v: 1, groups: [{ id: "g", name: `${MARK}-group`, parent: null }], entries: Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, group: "g", title: `${MARK}-title-${i}`, username: `${MARK}-user`, password: `${MARK}-password-${i}`, notes: `${MARK}-notes` })) };
    const { record, session } = await createVault("vault master password", contents);
    const put = await call("PUT", "/api/vault", { record, base_revision: null });
    assert.equal(put.status, 200);
    assert.equal((await call("PUT", "/api/vault", { record, base_revision: null })).status, 409, "stale writer is refused");
    const sealed = await sealVault(session, contents);
    assert.equal((await call("PUT", "/api/vault", { record: sealed, base_revision: put.data.revision })).status, 200);
    assert.equal((await call("PUT", "/api/vault", { record: { ...sealed, entries: contents.entries }, base_revision: 2 })).status, 400, "plaintext is refused");
    await call("POST", "/api/vault/audit", { event: "unlocked" });
    await call("POST", "/api/vault/audit", { event: "imported", count: 50 });

    // Nothing in the data folder (vault, audit log, logs, jobs…) holds the secrets.
    const files = [];
    const walk = (d) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : files.push(join(d, f))));
    m.jobs.file.flush();
    walk(dir);
    for (const f of files) assert.ok(!readFileSync(f, "utf8").includes(MARK), `${f} must not contain plaintext`);
    const stored = JSON.parse(readFileSync(join(dir, "vault.json"), "utf8"));
    validateRecord(stored.record);
    assert.deepEqual((await openVault(stored.record, "vault master password")).contents, contents, "…yet the browser can open it");
    const events = (await call("GET", "/api/vault/audit")).data.events.map((e) => e.event);
    assert.deepEqual(events.slice(0, 4), ["imported", "unlocked", "saved", "created"]);

    // Backup is the encrypted record; restore and reset need password + code.
    const backup = await fetch(`${base}/api/vault/backup`, { headers: { cookie } });
    assert.ok(!(await backup.text()).includes(MARK));
    assert.equal((await call("POST", "/api/vault/reset", { password: "console-pw-123", code: "000000" })).status, 401);
  } finally {
    await m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vault store keeps metadata-only audit events", () => {
  const dir = tmp("fv-audit-");
  try {
    const s = new VaultStore(dir);
    s.audit("unlocked", { user: "admin", ip: "1.2.3.4" });
    assert.throws(() => s.audit("password: hunter2"), /unknown vault event/);
    assert.deepEqual(Object.keys(s.recentAudit()[0]).sort(), ["at", "event", "ip", "user"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
