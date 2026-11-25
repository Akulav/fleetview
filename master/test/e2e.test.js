// End-to-end: the real Rust agent (`fleetview-agent console`, built from this
// repo) connects to this master over pinned TLS, and installers are pushed
// through the same HTTP API the console uses. Checks that:
//   1. a pushed installer arrives, runs with its silent switches and its
//      result (exit code + command line) comes back;
//   2. wrong switches fail with a readable reason instead of hanging;
//   3. an install for an offline PC waits and runs when the PC connects;
//   4. a large installer streams with flow control;
//   5. "skip if installed" is opt-in and uses a fresh program list.
//
// Needs Windows, `cargo build -p fleetview-agent` and rustc on PATH.
//   npm run test:e2e        (FLEETVIEW_AGENT_BIN to use another agent exe)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, openSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMaster } from "../src/master.js";
import { agentConfigJson } from "../src/identity.js";

const here = dirname(fileURLToPath(import.meta.url));
const agentBin = process.env.FLEETVIEW_AGENT_BIN || resolve(here, "../../target/debug/fleetview-agent.exe");
const skip = process.platform !== "win32" ? "Windows only" : !existsSync(agentBin) ? `no agent at ${agentBin} â€” run cargo build -p fleetview-agent` : false;

const work = mkdtempSync(join(tmpdir(), "fv-e2e-"));
const PASSWORD = "e2e-password-1234";
let master, base, cookie, agent, agentId;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}
async function call(method, path, body, raw) {
  const res = await fetch(base + path, {
    method,
    headers: { "X-FleetView": "1", cookie: cookie ?? "", ...(body && !raw ? { "Content-Type": "application/json" } : {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
    duplex: raw ? "half" : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.error}`);
  return { res, data };
}
function startAgent() {
  const log = openSync(join(work, "agent-stdout.log"), "a");
  agent = spawn(agentBin, ["console"], {
    env: { ...process.env, FLEETVIEW_DATA_DIR: join(work, "agent"), RUST_LOG: "info" },
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
}
function stopAgent() {
  if (!agent) return;
  try {
    execFileSync("taskkill.exe", ["/PID", String(agent.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
  agent = null;
}
async function runJob(payload, extra = {}) {
  const { data } = await call("POST", "/api/jobs", { kind: "install", targets: [agentId], payload, ...extra });
  return data.job.id;
}
async function finished(jobId, ms = 120_000) {
  return until(
    `job ${jobId}`,
    async () => {
      const { data } = await call("GET", `/api/jobs/${jobId}`);
      const t = data.job.targets[agentId];
      return ["succeeded", "failed", "skipped", "cancelled"].includes(t.state) ? t : null;
    },
    ms,
  );
}

before(async () => {
  if (skip) return;
  // A stand-in installer: needs /S, writes /MARKER=<path>.
  execFileSync("rustc", ["-O", join(here, "fixtures", "fake-installer.rs"), "-o", join(work, "FakeSetup.exe")], { stdio: "inherit" });

  master = await startMaster(
    {
      dataDir: join(work, "master"),
      httpHost: "127.0.0.1",
      httpPort: 0,
      agentHost: "127.0.0.1",
      agentPort: 0,
      discovery: false,
      publicUrl: "http://127.0.0.1",
      secureCookies: false,
      adminUser: "admin",
      adminPassword: PASSWORD,
      adminPasswordHash: "",
      agentBuild: false, // the test runs the agent exe it was given
    },
    { quiet: !process.env.E2E_VERBOSE },
  );
  base = `http://127.0.0.1:${master.web.port}`;

  // Provision the agent exactly as a downloaded installer would.
  mkdirSync(join(work, "agent"), { recursive: true });
  writeFileSync(
    join(work, "agent", "agent.config.json"),
    // The default for new installers: the master's web address (WebSocket to
    // <url>/agent, pinned TLS inside). Plain http here; https in production.
    agentConfigJson(master.identity, { agentAddress: base }),
  );
  startAgent();
  agentId = await until("the agent to connect", () => master.hub.list().find((a) => a.conn)?.agent_id, 60_000);

  const { res } = await call("POST", "/api/login", { user: "admin", password: PASSWORD });
  cookie = res.headers.get("set-cookie").split(";")[0];
});

after(async () => {
  stopAgent();
  await master?.close();
  if (!process.env.E2E_KEEP) rmSync(work, { recursive: true, force: true });
  else console.log(`kept ${work}`);
});

test("console rejects requests without a session", { skip }, async () => {
  const res = await fetch(`${base}/api/state`);
  assert.equal(res.status, 401);
  const res2 = await fetch(`${base}/api/jobs`, { method: "POST", headers: { cookie } });
  assert.equal(res2.status, 403, "mutations need the X-FleetView header (CSRF guard)");
});

let installer;
test("upload detects the installer type", { skip }, async () => {
  const body = readFileSync(join(work, "FakeSetup.exe"));
  const { data } = await call("PUT", "/api/installers?name=FakeSetup.exe", null, body);
  installer = data.item;
  assert.equal(installer.kind, "custom"); // a plain exe: the admin types the switch
  assert.equal(installer.size, body.length);
});

test("pushed installer runs silently and reports back", { skip }, async () => {
  const marker = join(work, "marker one.txt"); // a space, to exercise quoting
  const jobId = await runJob({ installer_id: installer.id, args: `/S "/MARKER=${marker}"`, is_msi: false });
  const t = await finished(jobId);
  assert.equal(t.state, "succeeded", `${t.message}\n${t.output}`);
  assert.equal(t.exit_code, 0);
  assert.ok(existsSync(marker), "the installer ran");
  assert.match(readFileSync(marker, "utf8"), /"\/S"/);
  assert.match(t.output, /ran: FakeSetup\.exe \/S "\/MARKER=/);
});

test("wrong silent switches fail with the reason", { skip }, async () => {
  const jobId = await runJob({ installer_id: installer.id, args: "/quiet", is_msi: false });
  const t = await finished(jobId);
  assert.equal(t.state, "failed");
  assert.equal(t.exit_code, 1639);
  assert.match(t.message, /invalid command-line arguments/);
});

test("skip-if-installed is opt-in and checks a fresh program list", { skip }, async () => {
  const sw = await until("the software inventory", () => master.hub.get(agentId).software?.[0]);
  const jobId = await runJob({ installer_id: installer.id, args: "/S", is_msi: false, skip_if: sw.name });
  const t = await finished(jobId);
  assert.equal(t.state, "skipped");
  assert.match(t.message, /already installed/);
  // Same file, same PC, no skip name: installs (an upgrade/repair).
  const t2 = await finished(await runJob({ installer_id: installer.id, args: "/S", is_msi: false }));
  assert.equal(t2.state, "succeeded");
});

test("a large installer streams with flow control", { skip }, async () => {
  const big = join(work, "BigSetup.exe");
  writeFileSync(big, readFileSync(join(work, "FakeSetup.exe")));
  appendFileSync(big, Buffer.alloc(40 * 1024 * 1024, 0x5a)); // overlay data: still a runnable exe
  const { data } = await call("PUT", "/api/installers?name=BigSetup.exe", null, readFileSync(big));
  const marker = join(work, "big.txt");
  const t = await finished(await runJob({ installer_id: data.item.id, args: `/S /MARKER=${marker}`, is_msi: false }));
  assert.equal(t.state, "succeeded", `${t.message}\n${t.output}`);
  assert.ok(existsSync(marker));
});

test("an offline PC gets the install when it connects", { skip }, async () => {
  stopAgent();
  await until("the agent to go offline", () => !master.hub.isOnline(agentId), 30_000);
  const marker = join(work, "later.txt");
  const jobId = await runJob({ installer_id: installer.id, args: `/S /MARKER=${marker}`, is_msi: false }, { wait_offline: true });
  const { data } = await call("GET", `/api/jobs/${jobId}`);
  assert.equal(data.job.targets[agentId].state, "waiting");
  startAgent();
  const t = await finished(jobId);
  assert.equal(t.state, "succeeded", `${t.message}\n${t.output}`);
  assert.ok(existsSync(marker));
});

test("lists the PC's local accounts", { skip }, async () => {
  const { data } = await call("POST", `/api/agents/${agentId}/accounts`);
  assert.ok(data.accounts.length > 0);
  const builtinAdmin = data.accounts.find((u) => /-500$/.test(u.sid));
  assert.ok(builtinAdmin, "the built-in Administrator (RID 500) is listed");
  assert.equal(builtinAdmin.builtin, true);
  assert.equal(typeof builtinAdmin.admin, "boolean");
});

test("account change: clear failure, and the password is never stored", { skip }, async () => {
  const password = "Fv-e2e-Secret-91f3";
  const { data } = await call("POST", "/api/jobs", {
    kind: "account",
    targets: [agentId],
    payload: { action: "set_password", user: "fv-e2e-no-such-user", password },
  });
  const t = await finished(data.job.id);
  assert.equal(t.state, "failed");
  assert.match(t.message, /fv-e2e-no-such-user/i, t.message);
  master.jobs.file.flush();
  assert.ok(!readFileSync(join(work, "master", "jobs.json"), "utf8").includes(password), "not in the job history");
  assert.ok(!readFileSync(join(work, "agent", "audit.log"), "utf8").includes(password), "not in the agent's audit log");
  assert.equal(master.jobs.secrets.size, 0, "dropped from memory once done");
});

test("a maintenance task runs and reports a summary", { skip }, async () => {
  const { data } = await call("POST", "/api/jobs", { kind: "task", targets: [agentId], payload: { task: "disk_health" } });
  const t = await finished(data.job.id);
  // Unelevated test agent: either outcome is fine, but it must say something real.
  assert.ok(["succeeded", "failed"].includes(t.state));
  assert.ok(t.message && t.message !== "done", t.message);
  assert.match(t.output, /GB/, t.output);
});

test("agents connect through the web address (WebSocket, pinned TLS inside)", { skip }, () => {
  assert.match(master.hub.get(agentId).addr, /\(web\)$/);
});

test("the direct agent port still works (LAN setups, older agents)", { skip }, async () => {
  stopAgent();
  await until("the agent to go offline", () => !master.hub.isOnline(agentId), 30_000);
  writeFileSync(
    join(work, "agent", "agent.config.json"),
    agentConfigJson(master.identity, { agentAddress: `127.0.0.1:${master.config.agentPort}` }),
  );
  startAgent();
  await until("the agent to reconnect directly", () => master.hub.isOnline(agentId), 60_000);
  assert.doesNotMatch(master.hub.get(agentId).addr, /\(web\)/);
  const marker = join(work, "direct.txt");
  const t = await finished(await runJob({ installer_id: installer.id, args: `/S /MARKER=${marker}`, is_msi: false }));
  assert.equal(t.state, "succeeded", `${t.message}
${t.output}`);
  assert.ok(existsSync(marker));
});

test("the master keeps every agent's e-Management URL in sync", { skip }, async () => {
  const cfgPath = join(work, "agent", "agent.config.json");
  const agentCfg = () => JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(agentCfg().emanagement_url ?? null, null, "starts without one (like the broken PC)");

  // Set on the master: pushed to the online agent right away.
  await call("PUT", "/api/settings/emanagement", { url: "https://documente.example.md" });
  await until("the agent's config to get the URL", () => agentCfg().emanagement_url === "https://documente.example.md", 60_000);
  await until("the sync result", () => master.hub.get(agentId).emanagement?.state === "fixed", 30_000);

  // Already in sync: nothing to change.
  await master.configSync.sync(agentId);
  assert.equal(master.hub.get(agentId).emanagement.state, "ok");

  // Removed on the PC: put back when the agent next connects.
  stopAgent();
  await until("the agent to go offline", () => !master.hub.isOnline(agentId), 30_000);
  const c = agentCfg();
  delete c.emanagement_url;
  writeFileSync(cfgPath, JSON.stringify(c, null, 2));
  startAgent();
  await until("the URL to be restored on connect", () => agentCfg().emanagement_url === "https://documente.example.md", 60_000);
});
