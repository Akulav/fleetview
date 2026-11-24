// Unit tests: wire format (against bytes produced by the Rust side),
// installer detection, argument parsing, agent package, identity, auth.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mp from "../src/msgpack.js";
import { detectKind, splitArgs, uninstallScript, safeFileName, splitCommand } from "../src/installers.js";
import { findAgentVersion, withTrailer, splitTrailer, compareVersions } from "../src/agentpkg.js";
import { loadOrCreateIdentity, agentConfigJson } from "../src/identity.js";
import { signingBytes, buildBeacon, datagram, parseDatagram } from "../src/discovery.js";
import { hashPassword, verifyPassword, Auth } from "../src/auth.js";

// Produced by rmp_serde::to_vec_named on the Rust structs (shared/src/protocol.rs).
const RUST = {
  RequestTelemetry: "b05265717565737454656c656d65747279",
  HelloAck: "81a848656c6c6f41636b82a86163636570746564c3a6726561736f6ea0",
  FileChunk: "81a946696c654368756e6b82ab7472616e736665725f6964a174a464617461c4020102",
  FileBegin:
    "81a946696c65426567696e84ab7472616e736665725f6964a174a966696c655f6e616d65a161a9746f74616c5f6c656e05a972756e5f616674657283aa636f6d6d616e645f6964a163a46172677391a22f53a669735f6d7369c2",
  SetConfig: "81a9536574436f6e66696782aa636f6d6d616e645f6964a163a7757064617465739182a36b6579a16ba576616c7565c0",
  Heartbeat: "a9486561727462656174",
  Hello:
    "81a548656c6c6f86a870726f746f636f6c01a86167656e745f6964a161a8686f73746e616d65a168ad6167656e745f76657273696f6ea176b1656e726f6c6c6d656e745f736563726574a173a96167656e745f6b6579a16b",
  FileAck: "81a746696c6541636b82ab7472616e736665725f6964a174a87265636569766564ce000493e0",
};

test("master messages encode byte-for-byte like rmp-serde", () => {
  const hex = (v) => mp.encode(v).toString("hex");
  assert.equal(hex("RequestTelemetry"), RUST.RequestTelemetry);
  assert.equal(hex({ HelloAck: { accepted: true, reason: "" } }), RUST.HelloAck);
  assert.equal(hex({ FileChunk: { transfer_id: "t", data: Buffer.from([1, 2]) } }), RUST.FileChunk);
  assert.equal(
    hex({ FileBegin: { transfer_id: "t", file_name: "a", total_len: 5, run_after: { command_id: "c", args: ["/S"], is_msi: false } } }),
    RUST.FileBegin,
  );
  assert.equal(hex({ SetConfig: { command_id: "c", updates: [{ key: "k", value: null }] } }), RUST.SetConfig);
});

test("agent messages decode", () => {
  const dec = (k) => mp.variant(mp.decode(Buffer.from(RUST[k], "hex")));
  assert.deepEqual(dec("Heartbeat"), ["Heartbeat", null]);
  const [k, hello] = dec("Hello");
  assert.equal(k, "Hello");
  assert.equal(hello.protocol, 1);
  assert.equal(hello.agent_key, "k");
  const [, ack] = dec("FileAck");
  assert.equal(ack.received, 300000);
});

test("msgpack round-trips sizes and types", () => {
  const v = { s: "ă".repeat(40), n: -40000, big: 2 ** 40, f: 1.5, bin: Buffer.alloc(70000, 7), arr: Array.from({ length: 20 }, (_, i) => i), nil: null, t: true };
  const back = mp.decode(mp.encode(v));
  assert.equal(back.s, v.s);
  assert.equal(back.n, v.n);
  assert.equal(back.big, v.big);
  assert.equal(back.f, 1.5);
  assert.equal(back.bin.length, 70000);
  assert.deepEqual(back.arr, v.arr);
  assert.equal(back.nil, null);
  assert.equal(back.t, true);
});

test("installer detection", () => {
  assert.equal(detectKind("x.MSI", Buffer.alloc(0)), "msi");
  assert.equal(detectKind("x.exe", Buffer.from("MZ....This installation was built with Inno Setup.")), "inno");
  assert.equal(detectKind("x.exe", Buffer.from("MZ..Nullsoft.NSIS.exehead")), "nsis");
  assert.equal(detectKind("x.exe", Buffer.from("MZ..\0.wixburn\0 Inno Setup")), "wix");
  assert.equal(detectKind("x.exe", Buffer.concat([Buffer.from("MZ"), Buffer.from("InstallShield", "utf16le")])), "installshield");
  assert.equal(detectKind("x.exe", Buffer.from("MZ plain")), "custom");
});

test("argument splitting keeps quoted values together", () => {
  assert.deepEqual(splitArgs("/VERYSILENT  /SUPPRESSMSGBOXES /NORESTART"), ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"]);
  assert.deepEqual(splitArgs('/S /D="C:\\Program Files\\App"'), ["/S", "/D=C:\\Program Files\\App"]);
  assert.deepEqual(splitArgs('INSTALLDIR="" /qn'), ["INSTALLDIR=", "/qn"]);
  assert.deepEqual(splitArgs("   "), []);
});

test("uninstall scripts", () => {
  const s = uninstallScript("MsiExec.exe /I{12345678-ABCD-1234-ABCD-1234567890AB}");
  assert.match(s, /'msiexec.exe' -ArgumentList '\/X \{12345678-ABCD-1234-ABCD-1234567890AB\} \/qn \/norestart'/);
  const inno = uninstallScript('"C:\\Program Files\\O\'Brien\\unins000.exe"');
  assert.match(inno, /'C:\\Program Files\\O''Brien\\unins000.exe'/);
  assert.match(inno, /VERYSILENT/);
  assert.deepEqual(splitCommand("C:\\Prog Files\\x.exe /a"), ["C:\\Prog Files\\x.exe", "/a"]);
  assert.equal(safeFileName("..\\..\\evil?.exe"), "evil_.exe");
});

test("agent package: version marker and config trailer", () => {
  const exe = Buffer.concat([Buffer.from("MZ..FLEETVIEW_AGENT_VERSION=\x01junk FLEETVIEW_AGENT_VERSION=0.5.0\0rest")]);
  assert.equal(findAgentVersion(exe), "0.5.0");
  const setup = withTrailer(exe, '{"a":1}');
  const { image, config } = splitTrailer(setup);
  assert.ok(image.equals(exe));
  assert.equal(config.toString(), '{"a":1}');
  assert.ok(splitTrailer(withTrailer(setup, "{}")).image.equals(exe), "re-embedding replaces");
  assert.equal(compareVersions("0.4.1", "0.5.0"), -1);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("", "0.5.0"), -1);
});

test("identity: certificate, fingerprint, beacon signature", () => {
  const dir = mkdtempSync(join(tmpdir(), "fv-id-"));
  try {
    const id = loadOrCreateIdentity(dir, { log: () => {} });
    const cert = new crypto.X509Certificate(id.certPem);
    assert.match(cert.subject, /CN=fleetview-master/);
    assert.ok(cert.checkPrivateKey(crypto.createPrivateKey(id.keyPem)));
    assert.equal(id.fingerprint, crypto.createHash("sha256").update(cert.raw).digest("hex"));
    // Beacon signature verifies with the public key agents pin.
    const b = buildBeacon(id, 48620);
    const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(id.publicKeyB64, "base64")]), format: "der", type: "spki" });
    const ok = crypto.verify(null, signingBytes(1, 48620, id.fingerprint, id.masterName, b.issued_at_ms), pub, Buffer.from(b.signature, "base64"));
    assert.ok(ok);
    assert.equal(parseDatagram(datagram(b)).control_port, 48620);
    // Reloading gives the same identity.
    assert.equal(loadOrCreateIdentity(dir, { log: () => {} }).fingerprint, id.fingerprint);
    const cfg = JSON.parse(agentConfigJson(id, { agentAddress: "fleetview.akulav.com:48620" }));
    assert.equal(cfg.master_cert_fingerprint, id.fingerprint);
    assert.equal(cfg.master_address, "fleetview.akulav.com:48620");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auth: password hash and session tokens", () => {
  const h = hashPassword("correct horse battery");
  assert.ok(verifyPassword("correct horse battery", h));
  assert.ok(!verifyPassword("wrong", h));
  const dir = mkdtempSync(join(tmpdir(), "fv-auth-"));
  try {
    const a = new Auth({ dataDir: dir, adminUser: "admin", adminPasswordHash: h, sessionHours: 1, secureCookies: true }, () => {});
    const tok = a.login("1.2.3.4", "admin", "correct horse battery");
    assert.equal(a.check(tok), "admin");
    assert.equal(a.check(tok.slice(0, -2) + "xx"), null);
    assert.throws(() => a.login("1.2.3.4", "admin", "nope"), /wrong/);
    for (let i = 0; i < 8; i++) assert.throws(() => a.login("5.6.7.8", "admin", "nope"));
    assert.throws(() => a.login("5.6.7.8", "admin", "correct horse battery"), /too many/);
    assert.match(a.cookie(tok, 60), /HttpOnly; SameSite=Strict; Max-Age=60; Secure/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- maintenance tasks and local accounts -------------------------------
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { TASKS, taskScript } from "../src/tasks.js";
import { ACTIONS, actionScript, listScript, validate as validateAccount, parseList } from "../src/accounts.js";

/** Parse PowerShell with its own parser (nothing runs); returns error texts. */
function psParseErrors(scripts) {
  const dir = mkdtempSync(join(tmpdir(), "fv-ps-"));
  try {
    const files = scripts.map((s, i) => {
      const f = join(dir, `s${i}.ps1`);
      writeFileSync(f, s);
      return f;
    });
    const check = `$bad = @(); foreach ($f in $args) { $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$e); foreach ($x in $e) { $bad += (Split-Path $f -Leaf) + ': ' + $x.Message + ' @ ' + $x.Extent.StartLineNumber } }; $bad -join [char]10`;
    writeFileSync(join(dir, "check.ps1"), check);
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(dir, "check.ps1"), ...files], { encoding: "utf8" }).trim();
    return out ? out.split("\n").map((l) => `${l}\n--- ${scripts[Number(/^s(\d+)/.exec(l)[1])].slice(0, 80)}`) : [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("account actions validate names and passwords", () => {
  assert.throws(() => validateAccount({ action: "rename", user: "a", new_name: "bad/name" }), /cannot contain/);
  assert.throws(() => validateAccount({ action: "set_password", user: "itadmin" }, ""), /enter a password/);
  assert.throws(() => validateAccount({ action: "create", user: "x".repeat(21) }, "pw"), /20 characters/);
  assert.throws(() => validateAccount({ action: "nope", user: "a" }), /unknown/);
  validateAccount({ action: "set_password", user: "itadmin" }, "S3cret!");
});

test("account scripts keep the password out of the audited first line and escape quotes", () => {
  const pw = "it's \"$(Remove-Item C:\)\" `n";
  const s = actionScript({ action: "set_password", user: "O'Brien", must_change: true }, pw);
  const [first] = s.split("\n");
  assert.ok(!first.includes(pw) && !first.includes("it's"), "no password in the first line");
  assert.ok(s.includes("ConvertTo-SecureString " + "'" + pw.replace(/'/g, "''") + "' -AsPlainText"), "single-quoted: nothing expands");
  assert.match(s, /Get-LocalUser -Name 'O''Brien'/);
  assert.match(actionScript({ action: "disable", user: "x" }), /Assert-NotLastAdmin \$u\nDisable-LocalUser/);
  assert.match(actionScript({ action: "delete", user: "x" }), /Assert-NotLastAdmin \$u\nRemove-LocalUser/);
  assert.equal(parseList('[{"name":"b"},{"name":"A"}]').map((u) => u.name).join(), "A,b");
  assert.equal(parseList('noise\n{"name":"solo"}'.replace("{", "[{") + "]").length, 1);
});

test("every maintenance and account script is valid PowerShell", { skip: process.platform !== "win32" && "needs Windows PowerShell" }, () => {
  const scripts = [listScript()];
  for (const id of Object.keys(TASKS)) scripts.push(taskScript(id, { delay_min: 3, message: "Save 'your' work" }).script);
  for (const action of Object.keys(ACTIONS)) {
    scripts.push(actionScript({ action, user: "it'admin", new_name: "new name", full_name: "Full 'Name'", admin: true, must_change: true }, "p'w\"$x"));
  }
  assert.deepEqual(psParseErrors(scripts), []);
});
