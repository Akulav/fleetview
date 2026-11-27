// Security baseline, adblock, Windows Update repair, performance history,
// speed tests, "cleaned" marks and batches of changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASKS, taskScript, cleanOptions } from "../src/tasks.js";
import { baselineScript, adblockScript, ADBLOCK, ASR_RULES } from "../src/hardening.js";
import { Metrics, parseRecord, cleanSnapshot, cleanSpeed, speedScript } from "../src/metrics.js";
import { listScript as accountsScript } from "../src/accounts.js";
import { uninstallScript } from "../src/installers.js";
import { startMaster } from "../src/master.js";

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const isAscii = (s) => /^[\x00-\x7f]*$/.test(s);
const hasPs = process.platform === "win32";
const HOUR = 3600_000;

test("every task script is ASCII and valid PowerShell 5.1", { skip: !hasPs && "needs Windows PowerShell" }, () => {
  const scripts = {};
  for (const id of Object.keys(TASKS)) scripts[id] = taskScript(id).script;
  for (const asr of ["off", "audit", "standard", "block"]) scripts[`baseline_${asr}`] = baselineScript({ asr, controlled_folders: asr === "block" });
  scripts.adblock_remove2 = adblockScript({ remove: true });
  scripts.accounts = accountsScript();
  scripts.uninstall = uninstallScript('"C:\\Program Files (x86)\\AnyDesk\\AnyDesk.exe" --uninstall', "AnyDesk");
  scripts.uninstall_msi = uninstallScript("MsiExec.exe /X{12345678-ABCD-1234-ABCD-1234567890AB}", "Some App");
  for (const [k, s] of Object.entries(scripts)) assert.ok(isAscii(s.replace(/^# FleetView (task|: uninstall) ?.*\n/, "")), `${k} is not ASCII`);
  const dir = tmp("fv-ps2-");
  try {
    const files = Object.entries(scripts).map(([k, s]) => {
      const f = join(dir, `${k}.ps1`);
      writeFileSync(f, s, "utf8");
      return f;
    });
    const check = join(dir, "check.ps1");
    writeFileSync(check, "$bad = 0\nforeach ($f in $args) { $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$e); foreach ($x in $e) { $bad++; [Console]::Out.WriteLine($f + ': ' + $x.Message + ' at line ' + $x.Extent.StartLineNumber) } }\nexit $bad\n");
    let out = "";
    try {
      out = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", check, ...files], { encoding: "utf8" });
    } catch (e) {
      out = e.stdout;
    }
    assert.equal(out.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows Update tasks re-enable disabled services and explain 0x80070422", () => {
  for (const id of ["check_updates", "install_updates"]) {
    const s = taskScript(id).script;
    assert.match(s, /sc\.exe config \$n start= demand/);
    assert.ok(s.indexOf("Repair-WuServices") < s.indexOf("CreateUpdateSearcher"), "services are fixed before searching");
    assert.match(s, /0x80070422/);
  }
  const r = taskScript("repair_updates").script;
  assert.match(r, /SoftwareDistribution/);
  assert.match(r, /PartOfDomain/, "domain PCs keep their update policies");
});

test("security baseline: every Defender module, options for the risky parts", () => {
  const s = baselineScript({});
  for (const k of ["DisableRealtimeMonitoring", "DisableBehaviorMonitoring", "DisableIOAVProtection", "DisableScriptScanning", "DisableBlockAtFirstSeen", "MAPSReporting", "SubmitSamplesConsent", "PUAProtection", "EnableNetworkProtection"]) {
    assert.match(s, new RegExp(`${k} = `), k);
  }
  assert.match(s, /Set-NetFirewallProfile/);
  assert.match(s, /EnableSMB1Protocol \$false/);
  assert.match(s, /passive|mode; the active antivirus/i, "leaves Defender alone behind another antivirus");
  assert.doesNotMatch(s, /EnableControlledFolderAccess Enabled/, "controlled folder access is off by default");
  assert.match(baselineScript({ controlled_folders: true }), /EnableControlledFolderAccess Enabled/);
  // standard: the three standard-protection rules block, the rest audit.
  const std = baselineScript({ asr: "standard" });
  for (const [id, , safe] of ASR_RULES) assert.ok(std.includes(`@('${id}', '${safe ? "Enabled" : "AuditMode"}')`), id);
  assert.doesNotMatch(baselineScript({ asr: "off" }), /Add-MpPreference/);
  assert.throws(() => cleanOptions("security_baseline", { asr: "everything" }), /choose off/);
  assert.deepEqual(cleanOptions("security_baseline", { asr: "audit", controlled_folders: 1, junk: 1 }), { asr: "audit", controlled_folders: true });
});

test("adblock: store extensions through policies, added next to existing entries", () => {
  const s = adblockScript();
  assert.match(s, /ddkjiahejlhfcafbddmgiahcphecmpfh;https:\/\/clients2\.google\.com\/service\/update2\/crx/);
  assert.match(s, /cimighlppcgcoapaliogpjjdehbnofhn;https:\/\/edge\.microsoft\.com\/extensionwebstorebase\/v1\/crx/);
  assert.match(s, /uBlock0@raymondhill\.net/);
  assert.match(s, /while \(\$names -contains \[string\]\$i\)/, "next free number, others' entries kept");
  assert.match(adblockScript({ remove: true }), /DeleteValue/);
  assert.equal(Object.keys(ADBLOCK).length, 4);
});

test("metrics: hourly averages, roll-up to days, before/after cleaning", () => {
  const dir = tmp("fv-metrics-");
  try {
    const m = new Metrics(dir);
    const t0 = Date.UTC(2026, 0, 1);
    // A week before cleaning at 60 % CPU / 80 % memory, a week after at 20 % / 50 %.
    for (let h = 0; h < 14 * 24; h++) {
      const before = h < 7 * 24;
      for (let k = 0; k < 3; k++) m.sample("a", before ? 60 : 20, before ? 80 : 50, t0 + h * HOUR + k * 60_000);
    }
    const cleanedAt = new Date(t0 + 7 * 24 * HOUR).toISOString();
    const c = m.compare("a", cleanedAt, t0 + 14 * 24 * HOUR);
    assert.equal(c.before.cpu, 60);
    assert.equal(c.after.cpu, 20);
    assert.equal(c.before.mem, 80);
    assert.equal(c.after.mem, 50);
    // 20 days later the oldest hours are daily buckets, and still count.
    m.sample("a", 10, 10, t0 + 20 * 24 * HOUR);
    assert.ok(m.pc("a").d.length >= 5, "old hours rolled into days");
    assert.ok(m.pc("a").h.length <= 14 * 24);
    assert.equal(m.compare("a", cleanedAt, t0 + 14 * 24 * HOUR).before.cpu, 60);
    m.sample("a", 500, -3, t0); // clamped, not trusted
    assert.ok(m.pc("a").d[0].cx <= 100);
    assert.throws(() => m.setSettings({ speed_every_h: -1 }), /0 \(off\)/);
    assert.equal(m.setSettings({ speed_every_h: 24 }).speed_every_h, 24);
    m.close();
    assert.equal(new Metrics(dir).settings.speed_every_h, 24, "saved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot and speed records are parsed defensively", () => {
  const out = 'noise\nFVPERF {"cpu_avg":12.5,"mem_pct":61,"processes":180,"boot_ms":41000,"top":{"name":"chrome","mb":900}}\nCPU 12.5% ...';
  const snap = cleanSnapshot(parseRecord(out, "FVPERF"), "2026-01-01T00:00:00.000Z");
  assert.equal(snap.cpu_avg, 12.5);
  assert.equal(snap.boot_ms, 41000);
  assert.deepEqual(snap.top, [{ name: "chrome", mb: 900 }], "one top program comes as an object");
  assert.equal(parseRecord("FVPERF {broken", "FVPERF"), null);
  assert.equal(cleanSpeed({ up_mbps: 3 }), null, "no download, no record");
  assert.equal(cleanSpeed({ down_mbps: "94.3", up_mbps: 38, ping_ms: 12, isp: "x".repeat(500) }).isp.length, 120);
  const sp = speedScript({ max_down_mb: 1000 });
  assert.match(sp, /Min\(100000000,/, "download capped at 100 MB");
});

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

test("API: a batch of changes runs in order per PC, records metrics and marks PCs cleaned", async () => {
  const dir = tmp("fv-batch-api-");
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
      for (let i = 0; i < 300; i++) {
        const j = m.jobs.get(jobId);
        if (Object.values(j.targets).every((t) => ["succeeded", "failed", "skipped", "cancelled"].includes(t.state))) return j;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("job did not finish");
    };
    await call("POST", "/api/login", { user: "admin", password: "console-pw-123" });

    const reply = (fail) => (s) =>
      s.includes("FleetView task: Performance snapshot") ? { stdout: 'FVPERF {"cpu_avg":30,"mem_pct":70,"processes":200,"boot_ms":60000}\nCPU 30%' }
      : s.includes("FleetView task: Internet speed test") ? { stdout: 'FVSPEED {"down_mbps":95.2,"up_mbps":40.1,"ping_ms":11}\nDown 95.2 Mbps' }
      : s.includes("Security baseline") && fail ? { success: false, exit_code: 1, stdout: "[FAIL] x\nSecurity baseline: 1 problem(s)" }
      : { stdout: "done\nall set" };
    const ranA = fakeAgent(m.hub, "a", "PC-A", reply(false));
    const ranB = fakeAgent(m.hub, "b", "PC-B", reply(true));
    const lib = (await call("GET", "/api/scripts")).data.scripts;

    let r = await call("POST", "/api/jobs", { kind: "batch", targets: ["a"], payload: { steps: [{ type: "task", task: "restart" }, { type: "task", task: "perf_snapshot" }] } });
    assert.match(r.data.error, /must be the last step/);
    assert.equal((await call("POST", "/api/jobs", { kind: "batch", targets: ["a"], payload: { steps: [] } })).status, 400);

    r = await call("POST", "/api/jobs", {
      kind: "batch",
      targets: ["a", "b"],
      payload: {
        name: "New PC setup",
        steps: [
          { type: "task", task: "perf_snapshot" },
          { type: "task", task: "security_baseline", options: { asr: "audit" } },
          { type: "saved_script", script_id: lib[0].id },
          { type: "task", task: "speed_test" },
          { type: "mark_cleaned", note: "first clean-up" },
        ],
      },
    });
    assert.equal(r.status, 200, r.data.error);
    assert.equal(r.data.job.title, "New PC setup");
    const j = await done(r.data.job.id);
    assert.equal(j.targets.a.state, "succeeded");
    assert.equal(j.targets.a.message, "all 5 steps done");
    assert.equal(ranA.length, 4, "four scripts, the mark is the master's");
    assert.match(ranA[1], /'AuditMode'/, "options reach the step");
    assert.match(ranA[2], /^# FleetView saved script: Debloat/);
    assert.equal(m.hub.get("a").cleaned.note, "first clean-up");
    assert.equal(m.hub.get("a").cleaned.by, "admin");
    // B: the baseline failed, so the rest ran but B is not marked cleaned.
    assert.equal(j.targets.b.state, "failed");
    assert.match(j.targets.b.message, /3 of 5 steps done — failed: Security baseline/);
    assert.equal(j.targets.b.steps[4].state, "skipped");
    assert.equal(m.hub.get("b").cleaned ?? null, null);
    assert.equal(ranB.length, 4);
    const summary = (await call("GET", "/api/state")).data.jobs.find((x) => x.id === j.id);
    assert.equal(summary.targets.b.steps.length, 5);

    // Retry picks B up at the failed step.
    ranB.length = 0;
    m.hub.get("b").conn.send = ((orig) => (msg) => {
      const ps = msg?.RunPowerShell;
      if (ps) {
        ranB.push(ps.script);
        setImmediate(() => m.hub.emit("result", "b", { command_id: ps.command_id, success: true, exit_code: 0, stdout: "fixed", stderr: "" }));
        return true;
      }
      return orig(msg);
    })(m.hub.get("b").conn.send);
    await call("POST", `/api/jobs/${j.id}/retry`);
    const j2 = await done(j.id);
    assert.equal(j2.targets.b.state, "succeeded");
    assert.equal(ranB.length, 1, "only the step that failed runs again");
    assert.ok(m.hub.get("b").cleaned);

    // Measurements were kept.
    let met = (await call("GET", "/api/agents/a/metrics")).data;
    assert.equal(met.snaps.length, 1);
    assert.equal(met.snaps[0].boot_ms, 60000);
    assert.equal(met.speed[0].down, 95.2);
    assert.equal((await call("GET", "/api/state")).data.agents.find((x) => x.id === "a").speed.down, 95.2);
    assert.ok(met.compare, "before/after once cleaned");

    // A single task records too.
    r = await call("POST", "/api/jobs", { kind: "task", targets: ["a"], payload: { task: "perf_snapshot" } });
    await done(r.data.job.id);
    met = (await call("GET", "/api/agents/a/metrics")).data;
    assert.equal(met.snaps.length, 2);
    assert.equal(met.compare.snap_before.boot_ms, 60000, "the snapshot before the mark");

    // Cleaned marks by hand.
    r = await call("POST", "/api/cleaned", { targets: ["a", "b"], cleaned: false });
    assert.equal(r.data.count, 2);
    assert.equal(m.hub.get("a").cleaned, null);
    r = await call("POST", "/api/agents/a/cleaned", { note: "by hand" });
    assert.equal(r.data.cleaned.note, "by hand");
    assert.equal(m.hub.get("a").cleanings.length, 2, "history kept");
    assert.equal((await call("GET", "/api/metrics/fleet")).data.rows.length, 1);
    assert.equal((await call("PUT", "/api/settings/metrics", { speed_every_h: 12 })).data.settings.speed_every_h, 12);
    assert.equal((await call("PUT", "/api/settings/metrics", { speed_every_h: "x" })).status, 400);

    // Telemetry feeds the hourly history.
    m.hub.emit("telemetry", "a", { cpu_usage_pct: 40, mem_used_mb: 4096, mem_total_mb: 8192 });
    assert.equal(m.metrics.pc("a").h.at(-1).n, 1);
  } finally {
    for (const a of m.hub.list()) a.conn = null;
    await m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
