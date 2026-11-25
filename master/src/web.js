// The web console: static UI + JSON API + server-sent events.

import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { readFileSync, createReadStream, existsSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { APP_ROOT } from "./config.js";
import { PRESETS, WARNINGS } from "./installers.js";
import { taskCatalog, TASKS } from "./tasks.js";
import { ACTIONS, listScript, parseList, validate as validateAccount, actionTitle } from "./accounts.js";
import { agentConfigJson, importIdentity } from "./identity.js";
import { compareVersions, withTrailer } from "./agentpkg.js";
import { handleAgentUpgrade } from "./ws.js";
import { VaultStore } from "./vault.js";

const PUBLIC = join(APP_ROOT, "public");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const VERSION = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")).version;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function startWeb({ config, hub, jobs, library, pkg, builder, auth, identity, logs }) {
  const vault = new VaultStore(config.dataDir);
  const clients = new Set();
  const broadcast = (event, data) => {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(line);
  };
  hub.on("agent", (a) => broadcast("agent", agentSummary(a, pkg)));
  hub.on("agents", () => broadcast("reload", {}));
  jobs.on("job", (j) => broadcast("job", jobSummary(j)));
  jobs.on("progress", (j) => broadcast("job", jobSummary(j)));
  jobs.on("removed", (id) => broadcast("job-removed", { id }));
  logs.on("line", (l) => broadcast("log", l));
  builder.on("status", () => broadcast("master", masterInfo()));
  const ping = setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, 25_000);
  ping.unref();

  const audit = (user, what) => logs.write(`[${user}] ${what}`);

  async function api(req, res, url, user, sess, ip) {
    const m = req.method;
    const p = url.pathname;
    const seg = p.split("/").filter(Boolean).slice(1); // after "api"

    if (p === "/api/me" && m === "GET") return json(res, { user, mfa: sess.mfa, totp_enabled: auth.totpEnabled });

    // ---- two-step sign-in (TOTP) ----
    if (p === "/api/2fa/setup" && m === "POST") {
      if (auth.totpEnabled) throw new HttpError(409, "two-step sign-in is already on");
      const b = await body(req);
      try {
        auth.stepUp(ip, b.password);
      } catch (e) {
        throw new HttpError(401, e.message);
      }
      return json(res, auth.beginTotp());
    }
    if (p === "/api/2fa/confirm" && m === "POST") {
      const b = await body(req);
      let token;
      try {
        token = auth.confirmTotp(ip, b.code);
      } catch (e) {
        throw new HttpError(400, e.message);
      }
      audit(user, "turned on two-step sign-in");
      res.setHeader("Set-Cookie", auth.cookie(token, config.sessionHours * 3600));
      return json(res, { ok: true });
    }
    if (p === "/api/2fa/disable" && m === "POST") {
      const b = await body(req);
      let token;
      try {
        token = auth.disableTotp(ip, b.password, b.code);
      } catch (e) {
        throw new HttpError(401, e.message);
      }
      audit(user, "turned off two-step sign-in");
      res.setHeader("Set-Cookie", auth.cookie(token, config.sessionHours * 3600));
      return json(res, { ok: true });
    }

    // ---- password vault (ciphertext only; see src/vault.js) ----
    if (seg[0] === "vault") {
      if (!sess.mfa) {
        throw new HttpError(403, auth.totpEnabled ? "sign in again with your authenticator code to open the vault" : "turn on two-step sign-in (Settings → Security) to use the vault");
      }
      const ev = (event, extra = {}) => vault.audit(event, { user, ip, ...extra });
      if (seg.length === 1 && m === "GET") return json(res, { exists: vault.exists, ...(vault.get() ?? {}) });
      if (seg.length === 1 && m === "PUT") {
        const b = await body(req, 40 * 1048576);
        let revision;
        try {
          revision = vault.put(b.record, b.base_revision ?? null);
        } catch (e) {
          throw new HttpError(e.status ?? 400, e.message);
        }
        ev(b.base_revision == null ? "created" : "saved");
        return json(res, { revision });
      }
      if (seg[1] === "audit" && m === "GET") return json(res, { events: vault.recentAudit() });
      if (seg[1] === "audit" && m === "POST") {
        // Events only the browser knows about. Metadata only.
        const b = await body(req);
        if (!["unlocked", "unlock_failed", "locked", "imported", "exported_plain", "password_changed"].includes(b.event)) {
          throw new HttpError(400, "unknown vault event");
        }
        ev(b.event, { count: Number.isInteger(b.count) ? b.count : undefined });
        return json(res, { ok: true });
      }
      if (seg[1] === "backup" && m === "GET") {
        const v = vault.get();
        if (!v) throw new HttpError(404, "there is no vault yet");
        ev("backup_downloaded");
        const out = JSON.stringify({ fleetview_vault_backup: 1, exported_at: new Date().toISOString(), record: v.record }, null, 1);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="fleetview-vault-${new Date().toISOString().slice(0, 10)}.json"`,
          "Cache-Control": "no-store",
        });
        return res.end(out);
      }
      if ((seg[1] === "restore" || seg[1] === "reset") && m === "POST") {
        const b = await body(req, 40 * 1048576);
        try {
          auth.stepUp(ip, b.password, b.code);
        } catch (e) {
          throw new HttpError(401, e.message);
        }
        if (seg[1] === "reset") {
          vault.reset();
          ev("reset");
          return json(res, { ok: true });
        }
        try {
          vault.reset();
          vault.put(b.record, null);
        } catch (e) {
          throw new HttpError(e.status ?? 400, e.message);
        }
        ev("backup_restored");
        return json(res, { ok: true, revision: vault.get().revision });
      }
      throw new HttpError(404, "not found");
    }
    if (p === "/api/logout" && m === "POST") {
      res.setHeader("Set-Cookie", auth.cookie("", 0));
      return json(res, { ok: true });
    }
    if (p === "/api/state" && m === "GET") {
      return json(res, {
        master: masterInfo(),
        agents: hub.list().map((a) => agentSummary(a, pkg)),
        jobs: jobs.list().map(jobSummary),
        installers: library.list(),
        presets: PRESETS,
        warnings: WARNINGS,
        tasks: taskCatalog(),
        account_actions: ACTIONS,
        log: logs.recent(),
      });
    }
    if (p === "/api/events" && m === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      });
      res.write("retry: 3000\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    // ---- agents ----
    if (seg[0] === "agents" && seg[1]) {
      const a = hub.get(seg[1]);
      if (!a) throw new HttpError(404, "unknown PC");
      if (seg.length === 2 && m === "GET") {
        return json(res, { ...agentSummary(a, pkg), telemetry: a.telemetry, software: a.software ?? [], software_at: a.software_at ?? null, addr: a.addr ?? null, macs: a.macs ?? [] });
      }
      if (seg.length === 2 && m === "PATCH") {
        const b = await body(req);
        if (Array.isArray(b.tags)) a.tags = b.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20);
        if (typeof b.notes === "string") a.notes = b.notes.slice(0, 4000);
        hub.save();
        hub.changed(a);
        return json(res, { ok: true });
      }
      if (seg.length === 2 && m === "DELETE") {
        if (!hub.remove(a.agent_id)) throw new HttpError(409, "only offline PCs can be removed");
        audit(user, `removed ${a.hostname}`);
        return json(res, { ok: true });
      }
      if (seg[2] === "refresh" && m === "POST") {
        hub.send(a.agent_id, "RequestTelemetry");
        hub.send(a.agent_id, "RequestSoftware");
        return json(res, { ok: hub.isOnline(a.agent_id) });
      }
      if (seg[2] === "accounts" && m === "POST") {
        if (!hub.isOnline(a.agent_id)) throw new HttpError(409, "the PC is offline");
        const commandId = crypto.randomUUID();
        const result = jobs.waitResult(a.agent_id, commandId, 90_000);
        hub.send(a.agent_id, { RunPowerShell: { command_id: commandId, script: listScript() } });
        let r;
        try {
          r = await result;
        } catch (e) {
          throw new HttpError(504, e.message);
        }
        if (!r.success) throw new HttpError(502, (r.stderr || r.stdout || "the PC could not list its accounts").split(/\r?\n/)[0]);
        try {
          return json(res, { accounts: parseList(r.stdout), at: new Date().toISOString() });
        } catch (e) {
          throw new HttpError(502, e.message);
        }
      }
      if (seg[2] === "screenshot" && m === "POST") {
        if (!hub.isOnline(a.agent_id)) throw new HttpError(409, "the PC is offline");
        const commandId = crypto.randomUUID();
        const frame = await new Promise((resolve) => {
          const done = (f) => {
            clearTimeout(timer);
            hub.off("screen", onFrame);
            resolve(f);
          };
          const onFrame = (id, f) => id === a.agent_id && f.command_id === commandId && done(f);
          const timer = setTimeout(() => done(null), 20_000);
          hub.on("screen", onFrame);
          hub.send(a.agent_id, { RequestScreenshot: { command_id: commandId } });
        });
        if (!frame) throw new HttpError(504, "no screenshot — is someone logged in on that PC?");
        audit(user, `screenshot of ${a.hostname}`);
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
        return res.end(frame.jpeg);
      }
    }

    // ---- installers ----
    if (p === "/api/installers" && m === "PUT") {
      const name = url.searchParams.get("name") || "installer.exe";
      if (!/\.(exe|msi)$/i.test(name)) throw new HttpError(400, "only .exe and .msi files");
      const { item, duplicate } = await library.add(req, name, config.maxUploadMb * 1048576);
      if (!duplicate) audit(user, `uploaded ${item.file_name} (${item.kind_label})`);
      broadcast("installers", library.list());
      return json(res, { item, duplicate, warning: WARNINGS[item.kind] ?? null });
    }
    if (seg[0] === "installers" && seg[1]) {
      if (m === "PATCH") {
        const item = library.update(seg[1], await body(req));
        if (!item) throw new HttpError(404, "unknown installer");
        broadcast("installers", library.list());
        return json(res, { item });
      }
      if (m === "DELETE") {
        if (!library.remove(seg[1])) throw new HttpError(404, "unknown installer");
        broadcast("installers", library.list());
        return json(res, { ok: true });
      }
    }

    // ---- jobs ----
    if (p === "/api/jobs" && m === "POST") {
      const b = await body(req);
      const ids = resolveTargets(b.targets);
      const job = createJob(b, ids, user);
      audit(user, `${job.title} → ${ids.length} PC(s)`);
      return json(res, { job: jobSummary(job) });
    }
    if (seg[0] === "jobs" && seg[1]) {
      const job = jobs.get(seg[1]);
      if (!job) throw new HttpError(404, "unknown job");
      if (seg.length === 2 && m === "GET") return json(res, { job: jobDetail(job) });
      if (seg.length === 2 && m === "DELETE") {
        if (!jobs.remove(job.id)) throw new HttpError(409, "the job is still running");
        return json(res, { ok: true });
      }
      if (seg[2] === "cancel" && m === "POST") return json(res, { cancelled: jobs.cancel(job.id) });
      if (seg[2] === "retry" && m === "POST") {
        audit(user, `retry ${job.title}`);
        return json(res, { retried: jobs.retry(job.id) });
      }
    }

    // ---- agent package ----
    if (p === "/api/agent-package" && m === "PUT") {
      const buf = await rawBody(req, 64 * 1048576);
      const version = pkg.save(buf);
      audit(user, `agent package ${version} uploaded`);
      broadcast("master", masterInfo());
      return json(res, { version });
    }
    if (p === "/api/agent-package/build" && m === "POST") {
      builder.build();
      audit(user, "agent build started");
      return json(res, { build: builder.status() });
    }
    if (p === "/api/import-desktop-master" && m === "POST") {
      const b = await body(req, 32 * 1048576);
      let settings = b.settings;
      let known = b.known ?? null;
      try {
        if (typeof settings === "string") settings = JSON.parse(settings);
        if (typeof known === "string") known = known.trim() ? JSON.parse(known) : null;
      } catch (e) {
        throw new HttpError(400, `not valid JSON: ${e.message}`);
      }
      let id;
      try {
        id = importIdentity(config.dataDir, settings);
      } catch (e) {
        throw new HttpError(400, e.message);
      }
      const changed = id.fingerprint !== identity.fingerprint;
      if (changed) hub.useIdentity(id);
      const pcs = known ? hub.importKnown(known) : 0;
      audit(user, `imported the desktop master's identity (certificate ${id.fingerprint.slice(0, 16)}…) and ${pcs} PC(s)`);
      broadcast("master", masterInfo());
      return json(res, { fingerprint: id.fingerprint, name: id.masterName, pcs, changed });
    }
    if (p === "/api/agent-package/setup" && m === "GET") {
      if (builder.state === "building") throw new HttpError(409, "the agent is being compiled — download it when the build is done");
      const info = pkg.info();
      if (!info) {
        if (config.agentBuild) builder.ensure();
        throw new HttpError(404, builder.state === "building" ? "no agent yet — it is being compiled now" : `no agent available: ${builder.error ?? "build it in Settings"}`);
      }
      const cfg = agentConfigJson(identity, { agentAddress: config.agentAddress, emanagementUrl: config.emanagementUrl });
      const out = withTrailer(pkg.image(), cfg);
      audit(user, `downloaded agent setup ${info.version}`);
      res.writeHead(200, {
        "Content-Type": "application/vnd.microsoft.portable-executable",
        "Content-Disposition": `attachment; filename="FleetViewAgent-${info.version}.exe"`,
        "Content-Length": out.length,
        "Cache-Control": "no-store",
      });
      return res.end(out);
    }
    throw new HttpError(404, "not found");
  }

  function resolveTargets(t) {
    if (t === "all") return hub.list().map((a) => a.agent_id);
    if (t === "online") return hub.list().filter((a) => a.online).map((a) => a.agent_id);
    if (!Array.isArray(t) || !t.length) throw new HttpError(400, "choose at least one PC");
    return t.map(String);
  }

  function createJob(b, ids, user) {
    const p = b.payload ?? {};
    const base = { agentIds: ids, waitOffline: !!b.wait_offline, by: user };
    switch (b.kind) {
      case "install": {
        const item = library.get(p.installer_id);
        if (!item) throw new HttpError(400, "choose an installer");
        const args = typeof p.args === "string" ? p.args.trim() : item.args;
        if (!args && !p.allow_no_args) throw new HttpError(400, "silent switches are empty — the installer would wait for clicks");
        const isMsi = typeof p.is_msi === "boolean" ? p.is_msi : item.is_msi;
        // Remember the switches that were used for this file.
        library.update(item.id, { args, is_msi: isMsi });
        return jobs.create({
          ...base,
          kind: "install",
          title: `Install ${item.file_name}`,
          detail: `${isMsi ? "msiexec /i … " : ""}${args}`,
          payload: { installer_id: item.id, args, is_msi: isMsi, skip_if: String(p.skip_if ?? "").trim() },
        });
      }
      case "update": {
        const info = pkg.info();
        if (!info) throw new HttpError(400, "no agent package on the master");
        const targets = ids.filter((id) => compareVersions(hub.get(id)?.agent_version, info.version) < 0);
        if (!targets.length) throw new HttpError(400, `the selected PCs already run ${info.version} or newer`);
        return jobs.create({
          ...base,
          agentIds: targets,
          kind: "update",
          title: `Update agent to ${info.version}`,
          payload: { version: info.version, emanagement_url: config.emanagementUrl },
        });
      }
      case "script": {
        const script = String(p.script ?? "");
        if (!script.trim()) throw new HttpError(400, "the script is empty");
        return jobs.create({ ...base, kind: "script", title: `PowerShell: ${firstLine(script)}`, detail: script, payload: { script } });
      }
      case "uninstall": {
        const name = String(p.name ?? "");
        const uninstall = {};
        for (const id of ids) {
          const sw = (hub.get(id)?.software ?? []).find((s) => s.name === name);
          if (sw?.uninstall_string) uninstall[id] = sw.uninstall_string;
        }
        if (!Object.keys(uninstall).length) throw new HttpError(400, `${name} has no uninstaller on the selected PCs`);
        return jobs.create({ ...base, kind: "uninstall", title: `Uninstall ${name}`, payload: { name, uninstall } });
      }
      case "message": {
        const text = String(p.body ?? "").trim();
        if (!text) throw new HttpError(400, "the message is empty");
        return jobs.create({ ...base, kind: "message", title: `Message: ${firstLine(text)}`, detail: text, payload: { title: String(p.title || "FleetView"), body: text } });
      }
      case "task": {
        const t = TASKS[p.task];
        if (!t) throw new HttpError(400, "choose a task");
        const options = {};
        if (t.options) {
          if (p.options?.delay_min !== undefined) options.delay_min = Number(p.options.delay_min);
          if (typeof p.options?.message === "string") options.message = p.options.message;
        }
        return jobs.create({ ...base, kind: "task", title: t.label, detail: options.message ? `in ${options.delay_min ?? t.options.delay_min} min: ${options.message}` : t.help, payload: { task: p.task, options } });
      }
      case "account": {
        // The password is kept apart from the job (memory only, never saved).
        const password = typeof p.password === "string" ? p.password : "";
        const payload = {
          action: String(p.action ?? ""),
          user: String(p.user ?? "").trim(),
          new_name: p.new_name ? String(p.new_name).trim() : undefined,
          full_name: p.full_name ? String(p.full_name).trim().slice(0, 100) : undefined,
          admin: !!p.admin,
          must_change: !!p.must_change,
        };
        try {
          validateAccount(payload, password);
        } catch (e) {
          throw new HttpError(400, e.message);
        }
        return jobs.create({
          ...base,
          kind: "account",
          title: actionTitle(payload),
          detail: ACTIONS[payload.action].needsPassword ? "(password not stored)" : "",
          payload,
          secret: ACTIONS[payload.action].needsPassword ? password : null,
        });
      }
      case "config": {
        const allowed = ["master_address", "emanagement_url", "discovery_targets", "telemetry_interval_secs"];
        const updates = (p.updates ?? []).filter((u) => allowed.includes(u.key)).map((u) => ({ key: u.key, value: u.value === "" || u.value == null ? null : String(u.value) }));
        if (!updates.length) throw new HttpError(400, "nothing to change");
        return jobs.create({ ...base, kind: "config", title: `Agent settings: ${updates.map((u) => u.key).join(", ")}`, detail: updates.map((u) => `${u.key} = ${u.value ?? "(default)"}`).join("\n"), payload: { updates } });
      }
      default:
        throw new HttpError(400, "unknown action");
    }
  }

  function masterInfo() {
    const info = pkg.info();
    return {
      name: identity.masterName,
      version: VERSION,
      public_url: config.publicUrl,
      agent_port: config.agentPort,
      agent_address: config.agentAddress,
      discovery: config.discovery,
      fingerprint: identity.fingerprint,
      agent_package: info,
      agent_build: builder.status(),
      agents_known: hub.list().length,
    };
  }

  // ---- request handling ----

  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    if (config.secureCookies) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    const ip = config.trustProxy ? (req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress : req.socket.remoteAddress;
    try {
      if (url.pathname === "/healthz") return json(res, { ok: true });
      if (url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.headers["x-fleetview"] !== "1") throw new HttpError(403, "missing X-FleetView header");
        if (url.pathname === "/api/login" && req.method === "POST") {
          const b = await body(req);
          let r;
          try {
            r = auth.login(ip, b.user, b.password, b.code);
          } catch (e) {
            logs.write(`login failed for "${String(b.user).slice(0, 40)}" from ${ip}`);
            throw new HttpError(401, e.message);
          }
          if (r.needCode) return json(res, { need_code: true });
          logs.write(`[${b.user}] signed in from ${ip}${auth.totpEnabled ? " (with code)" : ""}`);
          res.setHeader("Set-Cookie", auth.cookie(r.token, config.sessionHours * 3600));
          return json(res, { user: b.user });
        }
        const sess = auth.session(cookies(req).fv_session);
        if (!sess) throw new HttpError(401, "sign in first");
        return await api(req, res, url, sess.user, sess, ip);
      }
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      const status = e.status ?? 500;
      if (status >= 500) logs.write(`HTTP ${req.method} ${url.pathname}: ${e.stack ?? e.message}`);
      if (!res.headersSent) json(res, { error: e.message }, status);
      else res.end();
    }
  }

  const server =
    config.httpsCert && config.httpsKey
      ? https.createServer({ cert: readFileSync(config.httpsCert), key: readFileSync(config.httpsKey) }, handle)
      : http.createServer(handle);
  server.requestTimeout = 0; // uploads of big installers
  // Agents that reach the master through its web address (wss://…/agent).
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    if (!handleAgentUpgrade(req, socket, head, { identity, hub, trustProxy: config.trustProxy, log: (m) => logs.write(m) })) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.httpPort, config.httpHost, () => {
      const addr = server.address();
      logs.write(`console on ${config.httpsCert ? "https" : "http"}://${config.httpHost}:${addr.port} (public URL ${config.publicUrl})`);
      resolve({
        server,
        port: addr.port,
        close() {
          clearInterval(ping);
          for (const c of clients) c.end();
          server.close();
        },
      });
    });
  });
}

function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
  let rel = normalize(decodeURIComponent(pathname)).replace(/^[\\/]+/, "");
  if (!rel || !extname(rel)) rel = "index.html"; // single-page app
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, "not found");
  res.writeHead(200, {
    "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    "Cache-Control": "no-cache", // small files; never serve a stale UI after an upgrade
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}

function json(res, value, status = 200) {
  const s = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(s);
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function rawBody(req, max) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > max) throw new HttpError(413, "request too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function body(req, max = 1048576) {
  const buf = await rawBody(req, max);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

function firstLine(s) {
  const l = String(s).split("\n").find((x) => x.trim()) ?? "";
  return l.length > 60 ? `${l.slice(0, 59)}…` : l;
}

export function agentSummary(a, pkg) {
  const t = a.telemetry;
  const disk = t?.disks?.length
    ? t.disks.reduce((acc, d) => ({ total: acc.total + d.total_gb, free: acc.free + d.available_gb }), { total: 0, free: 0 })
    : null;
  const pv = pkg?.info()?.version;
  return {
    id: a.agent_id,
    hostname: a.hostname,
    online: !!a.conn,
    last_seen: a.last_seen,
    first_seen: a.first_seen,
    agent_version: a.agent_version ?? "",
    outdated: !!pv && compareVersions(a.agent_version, pv) < 0,
    os: a.os ?? t?.os_version ?? "",
    user: a.user ?? t?.logged_in_user ?? null,
    ip: (a.ips ?? []).find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x)) ?? a.ips?.[0] ?? "",
    cpu: t ? Math.round(t.cpu_usage_pct) : null,
    mem: t && t.mem_total_mb ? Math.round((t.mem_used_mb / t.mem_total_mb) * 100) : null,
    disk: disk && disk.total ? Math.round(((disk.total - disk.free) / disk.total) * 100) : null,
    uptime_secs: t?.uptime_secs ?? null,
    tags: a.tags ?? [],
    notes: a.notes ?? "",
    software_count: (a.software ?? []).length,
  };
}

export function jobSummary(j) {
  const counts = {};
  const targets = {};
  for (const [id, t] of Object.entries(j.targets)) {
    counts[t.state] = (counts[t.state] ?? 0) + 1;
    targets[id] = { hostname: t.hostname, state: t.state, message: t.message, progress: t.progress, exit_code: t.exit_code ?? null, finished_at: t.finished_at ?? null };
  }
  return { id: j.id, kind: j.kind, title: j.title, detail: j.detail, by: j.by, created_at: j.created_at, wait_offline: j.wait_offline, counts, targets };
}

function jobDetail(j) {
  const s = jobSummary(j);
  for (const [id, t] of Object.entries(j.targets)) s.targets[id].output = t.output ?? "";
  return s;
}
