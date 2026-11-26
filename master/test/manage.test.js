// PC management: rename, startup apps, saved scripts (and the debloat example).
// The API tests use a stand-in agent connection that answers RunPowerShell;
// the real agent runs these in `npm run test:e2e`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPcName, expandPattern, validateRenames, renameScript, nameStatusScript, parseNameStatus } from "../src/rename.js";
import { listScript, parseList, toggleScript, validateToggle, applyToggle, fleetSummary, entryKey } from "../src/startup.js";
import { ScriptLibrary, clean, scriptJob } from "../src/scripts.js";
import { DEBLOAT_SCRIPT } from "../src/debloat.js";
import { startMaster } from "../src/master.js";

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const isAscii = (s) => /^[\x00-\x7f]*$/.test(s);

// ------------------------------------------------------------------ rename --

test("PC names follow the NetBIOS rules", () => {
  for (const ok of ["PC-001", "a", "ACCOUNTING-PC15", "x1", "123A"]) assert.equal(checkPcName(ok), null, ok);
  assert.match(checkPcName(""), /enter a name/);
  assert.match(checkPcName("ABCDEFGHIJKLMNOP"), /15 characters/);
  assert.equal(checkPcName("ABCDEFGHIJKLMNO"), null, "exactly 15 is fine");
  assert.match(checkPcName("PC 01"), /letters, digits and hyphens/);
  assert.match(checkPcName("PC_01"), /letters, digits and hyphens/);
  assert.match(checkPcName("PC.01"), /letters, digits and hyphens/);
  assert.match(checkPcName("Calculatoră"), /letters, digits and hyphens/);
  assert.match(checkPcName("12345"), /only digits/);
  assert.match(checkPcName("-PC1"), /hyphen/);
  assert.match(checkPcName("PC1-"), /hyphen/);
});

test("rename patterns number PCs with zero padding", () => {
  assert.deepEqual(expandPattern("PC-###", 3), ["PC-001", "PC-002", "PC-003"]);
  assert.deepEqual(expandPattern("LAB#-X", 2, 9), ["LAB9-X", "LAB10-X"]);
  assert.deepEqual(expandPattern("OFF-##", 2, 99), ["OFF-99", "OFF-100"]);
  assert.deepEqual(expandPattern("SAME", 2), ["SAME", "SAME"]);
  assert.throws(() => validateRenames({ a: "SAME", b: "same" }), /both be named/);
  assert.throws(() => validateRenames({ a: "PC-0001234567890" }), /15 characters/);
  assert.throws(() => validateRenames({}), /at least one/);
  validateRenames(Object.fromEntries(expandPattern("PC-###", 3).map((n, i) => [`id${i}`, n])));
});

test("rename script: Rename-Computer -Force, optional restart, ASCII", () => {
  const s = renameScript("PC-007");
  assert.ok(isAscii(s));
  assert.match(s, /Rename-Computer -NewName \$new -Force/);
  assert.match(s, /\$new = 'PC-007'/);
  assert.match(s, /already pending restart/);
  assert.doesNotMatch(s, /shutdown\.exe/);
  const r = renameScript("PC-007", { restart: true, delaySec: 120 });
  assert.match(r, /shutdown\.exe \/r \/f \/t 120/);
  assert.ok(isAscii(r));
  assert.match(renameScript("PC-1", { restart: true, delaySec: 999999 }), /\/t 3600/, "delay capped at an hour");
  assert.throws(() => renameScript("bad name"), /letters, digits/);
  assert.throws(() => renameScript("x';rm C:"), /letters, digits/);
  assert.ok(isAscii(nameStatusScript()));
  assert.deepEqual(parseNameStatus('noise\n{"active":"OLD","pending":"NEW","domain":false}'), { active: "OLD", pending: "NEW", domain: false });
  assert.deepEqual(parseNameStatus('{"active":"OLD","pending":null,"domain":true}'), { active: "OLD", pending: null, domain: true });
});

// ----------------------------------------------------------------- startup --

const SAMPLE = [
  { kind: "run", scope: "machine", sid: null, user: null, name: "SecurityHealth", command: "%windir%\\system32\\SecurityHealthSystray.exe", location: "HKLM\\...\\Run", enabled: true, can_toggle: true },
  { kind: "run", scope: "user", sid: "S-1-5-21-1-2-3-1001", user: "PC\\ana", name: "OneDrive", command: '"C:\\Users\\ana\\OneDrive.exe" /background', location: "HKU\\...\\Run", enabled: false, can_toggle: true },
  { kind: "runonce", scope: "machine", sid: null, user: null, name: "cleanup", command: "x.exe", location: "HKLM", enabled: true, can_toggle: false },
  { kind: "folder", scope: "user", sid: "S-1-5-21-1-2-3-1002", user: "PC\\ion", name: "Teams.lnk", command: "teams.exe", location: "C:\\Users\\ion\\...", enabled: null, can_toggle: false },
  { kind: "task", scope: "machine", sid: null, user: "SYSTEM", name: "Updater", task_path: "\\Vendor\\", command: "up.exe", trigger: "boot", enabled: true, can_toggle: true, microsoft: false },
];

test("startup list parses the PC's JSON (one entry, none, many)", () => {
  const list = parseList("WARNING: something\n" + JSON.stringify(SAMPLE));
  assert.equal(list.length, 5);
  assert.deepEqual(list.map((e) => e.kind), ["run", "run", "folder", "runonce", "task"]);
  assert.equal(list.find((e) => e.name === "Teams.lnk").enabled, null, "unknown stays unknown");
  assert.equal(list.find((e) => e.name === "OneDrive").key, "run|user|onedrive|");
  assert.equal(parseList(JSON.stringify(SAMPLE[0])).length, 1, "PowerShell unwraps one-item arrays");
  assert.deepEqual(parseList(""), []);
  assert.throws(() => parseList("garbage"), /no startup list/);
  assert.ok(isAscii(listScript()));
});

test("startup toggles are validated and change StartupApproved like Task Manager", () => {
  assert.throws(() => validateToggle({ kind: "runonce", scope: "machine", name: "x" }), /RunOnce/);
  assert.throws(() => validateToggle({ kind: "run", scope: "elsewhere", name: "x" }), /scope/);
  assert.throws(() => validateToggle({ kind: "task", scope: "user", name: "x" }), /scope/);
  assert.throws(() => validateToggle({ kind: "run", scope: "user", sid: "S-1-5-21; rm", name: "x" }), /SID/);
  assert.throws(() => validateToggle({ kind: "run", scope: "machine", name: "a\nb" }), /name/);
  assert.throws(() => validateToggle({ kind: "task", scope: "machine", name: "x", task_path: "nope" }), /task path/);
  const off = toggleScript({ kind: "run", scope: "machine", name: "It's me", enable: false });
  assert.ok(isAscii(off));
  assert.match(off, /\$name = 'It''s me'/, "names are single-quote escaped");
  assert.match(off, /\[byte\[\]\]\(@\(3,0,0,0\)/, "disabled = 03 + FILETIME");
  assert.match(off, /'Run', 'all users'/);
  assert.doesNotMatch(off, /New-Item/, "never New-Item -Force on a registry key (it wipes values)");
  const on32 = toggleScript({ kind: "run", scope: "machine32", name: "x", enable: true });
  assert.match(on32, /'Run32'/);
  assert.match(on32, /\$enable = \$true/);
  const user = toggleScript({ kind: "folder", scope: "user", name: "Teams.lnk", enable: false });
  assert.match(user, /Get-LoadedSids/, "no SID = every signed-in user who has it");
  assert.match(user, /'StartupFolder'/);
  const one = toggleScript({ kind: "run", scope: "user", sid: "S-1-5-21-1-2-3-1001", name: "OneDrive", enable: true });
  assert.match(one, /@\('S-1-5-21-1-2-3-1001'\)/);
  const task = toggleScript({ kind: "task", scope: "machine", name: "Updater", task_path: "\\Vendor\\", enable: false });
  assert.match(task, /Get-ScheduledTask -TaskPath '\\Vendor\\' -TaskName \$name/);
  assert.match(task, /Disable-ScheduledTask/);
  assert.ok(isAscii(task));

  const list = parseList(JSON.stringify(SAMPLE));
  assert.ok(applyToggle(list, { kind: "run", scope: "user", name: "OneDrive", enable: true }));
  assert.equal(list.find((e) => e.name === "OneDrive").enabled, true);
  assert.equal(applyToggle(list, { kind: "run", scope: "machine", name: "Nope", enable: true }), false);
});

test("fleet view counts each entry once per PC", () => {
  const a = parseList(JSON.stringify(SAMPLE));
  const b = parseList(JSON.stringify([SAMPLE[1], { ...SAMPLE[1], sid: "S-1-5-21-9", enabled: true }, SAMPLE[0]]));
  const f = fleetSummary([
    { agent_id: "a", hostname: "PC-A", startup: a },
    { agent_id: "b", hostname: "PC-B", startup: b },
    { agent_id: "c", hostname: "PC-C", startup: null }, // never scanned
  ]);
  assert.equal(f.scanned, 2);
  const od = f.entries.find((e) => e.name === "OneDrive");
  assert.equal(od.count, 2);
  assert.equal(od.enabled_count, 1, "PC-B: enabled for one of its two users");
  assert.equal(f.entries[0].count, 2, "most common first");
  assert.equal(f.entries.find((e) => e.key === entryKey(SAMPLE[4])).count, 1);
});

// ----------------------------------------------------------------- scripts --

test("the debloat example is conservative and ASCII", () => {
  assert.ok(isAscii(DEBLOAT_SCRIPT), "PowerShell 5.1 reads BOM-less files as ANSI");
  const remove = [...DEBLOAT_SCRIPT.match(/\$RemoveApps = @\(([\s\S]*?)\n\)/)[1].matchAll(/^\s*'([^']+)'/gm)].map((m) => m[1]);
  assert.ok(remove.length > 15);
  const like = (name, pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i").test(name);
  const vital = ["Microsoft.WindowsStore", "Microsoft.StorePurchaseApp", "Microsoft.DesktopAppInstaller", "Microsoft.SecHealthUI", "Microsoft.MicrosoftEdge.Stable", "Microsoft.VCLibs.140.00", "Microsoft.UI.Xaml.2.8", "Microsoft.NET.Native.Runtime.2.2", "Microsoft.WindowsCalculator", "Microsoft.Windows.Photos", "MSTeams", "Microsoft.WindowsTerminal", "Microsoft.ZuneMusic"];
  for (const v of vital) for (const p of remove) assert.ok(!like(v, p), `${p} would remove ${v}`);
  for (const forbidden of [/wuauserv/i, /WinDefend/i, /DisableAntiSpyware/i, /Set-MpPreference/i, /WindowsUpdate/i, /Remove-Item/i]) {
    assert.doesNotMatch(DEBLOAT_SCRIPT, forbidden);
  }
  assert.match(DEBLOAT_SCRIPT, /Remove-AppxProvisionedPackage -Online/);
  assert.match(DEBLOAT_SCRIPT, /DisableWindowsConsumerFeatures/);
  assert.match(DEBLOAT_SCRIPT, /AllowTelemetry/);
  assert.match(DEBLOAT_SCRIPT, /reg\.exe unload/);
});

test("script library: seeded once, validated, auto-run at most once per PC", () => {
  const dir = tmp("fv-scripts-");
  try {
    let lib = new ScriptLibrary(dir);
    assert.equal(lib.list().length, 1);
    assert.match(lib.list()[0].name, /Debloat/);
    lib.remove(lib.list()[0].id);
    lib.close();
    lib = new ScriptLibrary(dir);
    assert.equal(lib.list().length, 0, "a deleted example stays deleted");
    assert.throws(() => lib.create({ name: "", script: "x" }), /name/);
    assert.throws(() => lib.create({ name: "x", script: "  \n" }), /empty/);
    assert.throws(() => lib.create({ name: "x", script: "a".repeat(300 * 1024) }), /256 KB/);
    const s = lib.create({ name: "  Clean   up ", script: "Write-Output 1\r\nexit 0", auto_new: false }, "admin");
    assert.equal(s.name, "Clean up");
    assert.equal(s.script, "Write-Output 1\nexit 0");
    assert.deepEqual(lib.takeAutoRuns("pc1"), []);
    lib.update(s.id, { auto_new: true });
    assert.ok(lib.get(s.id).auto_since);
    assert.deepEqual(lib.takeAutoRuns("pc1").map((x) => x.id), [s.id]);
    assert.deepEqual(lib.takeAutoRuns("pc1"), [], "once per PC");
    assert.equal(lib.update("nope", { name: "x" }), null);
    const j = scriptJob(lib.get(s.id));
    assert.equal(j.payload.script, "Write-Output 1\nexit 0");
    assert.equal(j.title, "Script: Clean up");
    lib.close();
    assert.equal(new ScriptLibrary(dir).get(s.id).auto_done.length, 1, "persisted");
    assert.throws(() => clean({ name: "x".repeat(101), script: "x" }), /100/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------- generated PowerShell parses --

const hasPs = process.platform === "win32" ? (() => {
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})() : false;

test("every generated script is valid PowerShell 5.1", { skip: !hasPs && "needs Windows PowerShell" }, () => {
  const dir = tmp("fv-ps-");
  try {
    const scripts = {
      rename: renameScript("PC-001"),
      rename_restart: renameScript("PC-001", { restart: true, delaySec: 60 }),
      name_status: nameStatusScript(),
      startup_list: listScript(),
      toggle_machine: toggleScript({ kind: "run", scope: "machine", name: "x", enable: false }),
      toggle_folder: toggleScript({ kind: "folder", scope: "machine", name: "x.lnk", enable: true }),
      toggle_user: toggleScript({ kind: "run", scope: "user", name: "x", enable: false }),
      toggle_user_folder: toggleScript({ kind: "folder", scope: "user", sid: "S-1-5-21-1-2", name: "x.lnk", enable: false }),
      toggle_task: toggleScript({ kind: "task", scope: "machine", name: "x", task_path: "\\", enable: true }),
      debloat: DEBLOAT_SCRIPT,
    };
    const files = Object.entries(scripts).map(([k, s]) => {
      const f = join(dir, `${k}.ps1`);
      writeFileSync(f, s, "latin1"); // no BOM, like the strictest reader
      return f;
    });
    const check = join(dir, "check.ps1");
    writeFileSync(check, "$bad = 0\nforeach ($f in $args) { $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$e); foreach ($x in $e) { $bad++; [Console]::Out.WriteLine($f + ': ' + $x.Message + ' at line ' + $x.Extent.StartLineNumber) } }\nexit $bad\n");
    const out = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", check, ...files], { encoding: "utf8" });
    assert.equal(out.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------- API with a stand-in agent --

/** A fake online PC: answers RunPowerShell with `reply(script)`. */
function fakeAgent(hub, id, hostname, reply) {
  const ran = [];
  const conn = {
    closed: false,
    send(msg) {
      const ps = msg?.RunPowerShell;
      if (ps) {
        ran.push(ps.script);
        const r = reply(ps.script);
        setImmediate(() => hub.emit("result", id, { command_id: ps.command_id, success: r.success ?? true, exit_code: r.exit_code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }));
      }
      return true;
    },
    close() {},
  };
  hub.agents.set(id, { agent_id: id, hostname, first_seen: new Date().toISOString(), last_seen: new Date().toISOString(), tags: [], notes: "", software: [], telemetry: null, conn, online: true });
  return ran;
}

test("API: rename, startup and saved scripts through jobs", async () => {
  const dir = tmp("fv-manage-api-");
  const m = await startMaster(
    { dataDir: dir, httpHost: "127.0.0.1", httpPort: 0, agentPort: null, discovery: false, publicUrl: "http://127.0.0.1", secureCookies: false, adminUser: "admin", adminPassword: "console-pw-123", adminPasswordHash: "", agentBuild: false, autoScriptDelayMs: 0 },
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
    const done = async (jobId) => {
      for (let i = 0; i < 200; i++) {
        const j = m.jobs.get(jobId);
        if (Object.values(j.targets).every((t) => ["succeeded", "failed", "skipped", "cancelled"].includes(t.state))) return j;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("job did not finish");
    };
    await call("POST", "/api/login", { user: "admin", password: "console-pw-123" });

    const ranA = fakeAgent(m.hub, "a", "DESKTOP-AAA", (s) =>
      s.includes("list startup apps") ? { stdout: JSON.stringify(SAMPLE) }
      : s.includes("read this PC's name") ? { stdout: '{"active":"DESKTOP-AAA","pending":"PC-001","domain":false}' }
      : s.includes("rename this PC") ? { stdout: "Renamed: DESKTOP-AAA -> PC-001 - pending restart." }
      : { stdout: "ok\nall good" });
    fakeAgent(m.hub, "b", "DESKTOP-BBB", (s) => (s.includes("list startup apps") ? { stdout: JSON.stringify([SAMPLE[0]]) } : { stdout: "done" }));

    // ---- rename ----
    let r = await call("POST", "/api/jobs", { kind: "rename", targets: ["a", "b"], payload: { names: { a: "PC-001", b: "PC-001" } } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /both be named/);
    r = await call("POST", "/api/jobs", { kind: "rename", targets: ["a"], payload: { names: { a: "DESKTOP-BBB" } } });
    assert.match(r.data.error, /already the name of another PC/);
    r = await call("POST", "/api/jobs", { kind: "rename", targets: ["a"], payload: { names: { a: "PC 1" } } });
    assert.match(r.data.error, /letters, digits/);
    r = await call("POST", "/api/jobs", { kind: "rename", targets: ["a"], payload: { names: { a: "PC-001" }, restart: false } });
    assert.equal(r.status, 200, r.data.error);
    let j = await done(r.data.job.id);
    assert.equal(j.targets.a.state, "succeeded");
    assert.match(j.targets.a.message, /pending restart/);
    assert.match(ranA.at(-1), /Rename-Computer -NewName \$new -Force/);
    assert.equal(m.hub.get("a").pending_name, "PC-001");
    assert.equal((await call("GET", "/api/state")).data.agents.find((x) => x.id === "a").pending_name, "PC-001");
    r = await call("POST", "/api/jobs", { kind: "rename", targets: ["b"], payload: { names: { b: "pc-001" } } });
    assert.match(r.data.error, /being renamed to PC-001/, "a pending name is taken too");
    assert.deepEqual((await call("POST", "/api/agents/a/name")).data, { active: "DESKTOP-AAA", pending: "PC-001", domain: false });

    // ---- startup ----
    r = await call("POST", "/api/agents/a/startup");
    assert.equal(r.data.startup.length, 5);
    r = await call("POST", "/api/startup/scan", {});
    assert.equal(r.data.scanned, 2);
    assert.equal(r.data.entries.find((e) => e.name === "SecurityHealth").count, 2);
    r = await call("POST", "/api/jobs", { kind: "startup", targets: ["a", "b"], payload: { kind: "run", scope: "machine", name: "SecurityHealth", enable: false } });
    j = await done(r.data.job.id);
    assert.equal(j.targets.a.state, "succeeded");
    assert.equal(m.hub.get("b").startup[0].enabled, false, "the cached list follows the change");
    r = (await call("GET", "/api/startup/fleet")).data;
    assert.equal(r.entries.find((e) => e.name === "SecurityHealth").enabled_count, 0);
    assert.equal((await call("POST", "/api/jobs", { kind: "startup", targets: ["a"], payload: { kind: "runonce", scope: "machine", name: "cleanup" } })).status, 400);

    // ---- saved scripts ----
    const lib = (await call("GET", "/api/scripts")).data.scripts;
    assert.equal(lib.length, 1, "the debloat example");
    assert.equal((await call("POST", "/api/scripts", { name: "", script: "x" })).status, 400);
    const s = (await call("POST", "/api/scripts", { name: "Hello", script: "'hello'" })).data.script;
    r = await call("POST", "/api/jobs", { kind: "saved_script", targets: "online", payload: { script_id: s.id } });
    assert.equal(r.data.job.title, "Script: Hello");
    j = await done(r.data.job.id);
    assert.equal(j.targets.a.message, "all good", "a saved script's last line is its result");
    // Editing later never rewrites history.
    await call("PUT", `/api/scripts/${s.id}`, { script: "'changed'" });
    assert.equal((await call("GET", `/api/jobs/${j.id}`)).data.job.script, "'hello'");
    assert.equal((await call("POST", "/api/jobs", { kind: "saved_script", targets: ["a"], payload: { script_id: "nope" } })).status, 400);

    // "Run on new PCs": a PC that enrolls later gets it once.
    await call("PUT", `/api/scripts/${s.id}`, { auto_new: true });
    const ranC = fakeAgent(m.hub, "c", "NEW-PC", () => ({ stdout: "fresh" }));
    m.hub.emit("enrolled", "c");
    m.hub.emit("enrolled", "c");
    await new Promise((res) => setTimeout(res, 100));
    const auto = m.jobs.list().filter((x) => x.targets.c);
    assert.equal(auto.length, 1);
    assert.equal(auto[0].by, "auto (new PC)");
    await done(auto[0].id);
    assert.deepEqual(ranC, ["'changed'"]);
    assert.equal((await call("GET", "/api/scripts")).data.scripts.find((x) => x.id === s.id).auto_count, 1);

    assert.equal((await call("DELETE", `/api/scripts/${s.id}`)).status, 200);
    assert.equal((await call("DELETE", `/api/scripts/${s.id}`)).status, 404);
    m.hub.file.flush();
    assert.equal(JSON.parse(readFileSync(join(dir, "agents.json"), "utf8")).find((x) => x.agent_id === "a").pending_name, "PC-001", "kept across restarts");
  } finally {
    for (const a of m.hub.list()) a.conn = null; // fake connections: nothing to close
    await m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
