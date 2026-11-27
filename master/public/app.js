import { icon } from "./icons.js";

// FleetView console. Vanilla JS, no build step. All text is inserted as text
// nodes (never innerHTML), so hostnames / program names can't inject markup.

// ---------------------------------------------------------------- helpers --
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") Object.assign(el.style, v);
    else if (k === "value") el.value = v;
    else if (k === "checked" || k === "disabled" || k === "selected") el[k] = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (sel, root = document) => root.querySelector(sel);
/** Replace an element's children; like h(), skips null/false and flattens. */
function put(el, ...kids) {
  el.replaceChildren(
    ...kids
      .flat(Infinity)
      .filter((k) => k !== null && k !== undefined && k !== false)
      .map((k) => (k instanceof Node ? k : document.createTextNode(String(k)))),
  );
}
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const fmtSize = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
function ago(iso) {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
function uptime(sec) {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600);
  return d ? `${d} d ${hh} h` : `${hh} h ${Math.floor((sec % 3600) / 60)} min`;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "X-FleetView": "1", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401 && path !== "/api/login") {
    showLogin();
    throw new Error("sign in first");
  }
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("json") ? await res.json() : await res.blob();
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

function toast(text, bad = false) {
  let box = $(".toasts");
  if (!box) document.body.append((box = h("div", { class: "toasts" })));
  const t = h("div", { class: `toast${bad ? " bad" : ""}` }, text);
  box.append(t);
  setTimeout(() => t.remove(), bad ? 7000 : 3500);
}
const fail = (e) => toast(e.message ?? String(e), true);

/** A notification with a title, a result line and an optional button. */
function notify({ title, text = "", tone = "", actionLabel = "", action = null, timeout = 10_000 }) {
  let box = $(".toasts");
  if (!box) document.body.append((box = h("div", { class: "toasts" })));
  const ic = { ok: "checkCircle", bad: "alert", warn: "clock", running: "activity" }[tone] ?? "activity";
  const t = h(
    "div",
    { class: `toast rich ${tone}` },
    h("span", { class: "t-ico" }, icon(ic, 18)),
    h("div", { class: "t-body" }, h("b", {}, title), text ? h("div", { class: "t-text" }, text) : null,
      actionLabel ? h("button", { class: "t-action", onclick: () => { t.remove(); action?.(); } }, actionLabel) : null),
    h("button", { class: "t-close", title: "Close", onclick: () => t.remove() }, icon("x", 14)),
  );
  box.append(t);
  if (timeout) setTimeout(() => t.remove(), timeout);
}

const ACTIVE_STATES = ["queued", "preparing", "sending", "installing", "running"];
/** One-glance outcome of a job: { tone, headline, text, done }. */
function jobResult(j) {
  const ts = Object.values(j.targets);
  const n = ts.length;
  const c = j.counts;
  const one = n === 1 ? ts[0] : null;
  const active = ACTIVE_STATES.reduce((s, k) => s + (c[k] ?? 0), 0);
  if (active) {
    const done = (c.succeeded ?? 0) + (c.failed ?? 0);
    return { tone: "running", done: false, headline: one ? `Running on ${one.hostname}…` : `Running — ${done} of ${n} finished`, text: one?.message ?? "" };
  }
  const failed = ts.filter((t) => t.state === "failed");
  const ok = c.succeeded ?? 0;
  const waiting = c.waiting ?? 0;
  if (failed.length) {
    return {
      tone: "bad",
      done: true,
      headline: one ? `Failed on ${one.hostname}` : `Failed on ${failed.length} of ${n}${ok ? `, done on ${ok}` : ""}`,
      text: one ? one.message : `${failed[0].hostname}: ${failed[0].message}${failed.length > 1 ? ` (+${failed.length - 1} more)` : ""}`,
    };
  }
  if (waiting && !ok) return { tone: "warn", done: true, headline: `Waiting for ${plural(waiting, "offline computer")}`, text: "It runs when they connect." };
  if (ok === n) return { tone: "ok", done: true, headline: one ? `Done on ${one.hostname}` : n === 2 ? "Done on both computers" : `Done on all ${n} computers`, text: one ? one.message : "" };
  const other = n - ok - waiting;
  return {
    tone: "warn",
    done: true,
    headline: `Done on ${ok} of ${n}`,
    text: [waiting && `${waiting} waiting for the PC to connect`, other && `${other} skipped or cancelled`].filter(Boolean).join(", "),
  };
}

/** Jobs started from this browser: their result pops up when they finish. */
const WATCH = new Set();
function watchJob(job) {
  if (!job?.id) return;
  WATCH.add(job.id);
  setTimeout(() => WATCH.delete(job.id), 6 * 3600_000); // give up after 6 h
}
function checkWatch(j) {
  if (!WATCH.has(j.id)) return;
  const r = jobResult(j);
  if (!r.done) return;
  WATCH.delete(j.id);
  // The result is already on screen in its own panel.
  if (S.drawer?.jobId === j.id) return;
  notify({ title: `${j.title}: ${r.headline}`, text: r.text, tone: r.tone, actionLabel: "Show result", action: () => openJob(j.id), timeout: r.tone === "bad" ? 30_000 : 12_000 });
}

// ------------------------------------------------------------------ state --
const S = {
  user: null,
  master: null,
  agents: new Map(),
  jobs: new Map(),
  installers: [],
  presets: {},
  warnings: {},
  tasks: [],
  accountActions: {},
  scripts: [],
  log: [],
  view: "dashboard",
  filter: "all",
  query: "",
  selected: new Set(),
  drawer: null, // { kind, ... }
};

const STATE_LABEL = {
  queued: ["Queued", "", true],
  waiting: ["Waiting for PC", "warn", false],
  preparing: ["Preparing", "blue", true],
  sending: ["Sending", "blue", true],
  installing: ["Installing", "blue", true],
  running: ["Running", "blue", true],
  succeeded: ["Done", "ok", false],
  failed: ["Failed", "bad", false],
  skipped: ["Skipped", "", false],
  cancelled: ["Cancelled", "", false],
};
function statePill(state) {
  const [label, cls, spin] = STATE_LABEL[state] ?? [state, "", false];
  return h("span", { class: `pill ${cls}${spin ? " spin" : ""}` }, label);
}

// ------------------------------------------------------------------- boot --
async function boot() {
  const theme = safeGet("fv-theme");
  if (theme) document.documentElement.dataset.theme = theme;
  try {
    S.user = (await api("GET", "/api/me")).user;
  } catch {
    return;
  }
  await loadState();
  connectEvents();
  setInterval(() => renderMain(), 30_000); // refresh "x min ago"
}

function safeGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {}
}

async function loadState() {
  const st = await api("GET", "/api/state");
  S.master = st.master;
  S.agents = new Map(st.agents.map((a) => [a.id, a]));
  S.jobs = new Map(st.jobs.map((j) => [j.id, j]));
  S.installers = st.installers;
  S.presets = st.presets;
  S.warnings = st.warnings;
  S.tasks = st.tasks;
  S.accountActions = st.account_actions;
  S.scripts = st.scripts ?? [];
  S.log = st.log;
  renderShell();
}

let es = null;
function connectEvents() {
  es?.close();
  es = new EventSource("/api/events");
  es.addEventListener("agent", (e) => {
    const a = JSON.parse(e.data);
    S.agents.set(a.id, a);
    schedule();
  });
  es.addEventListener("job", (e) => {
    const j = JSON.parse(e.data);
    S.jobs.set(j.id, j);
    checkWatch(j);
    schedule();
  });
  es.addEventListener("job-removed", (e) => {
    S.jobs.delete(JSON.parse(e.data).id);
    schedule();
  });
  es.addEventListener("installers", (e) => {
    S.installers = JSON.parse(e.data);
  });
  es.addEventListener("scripts", (e) => {
    S.scripts = JSON.parse(e.data);
    if (S.view === "scripts") renderScripts($("#main"), true);
  });
  es.addEventListener("master", (e) => {
    S.master = JSON.parse(e.data);
    const card = document.getElementById("agent-card");
    if (card) fillAgentCard(card, card._pkgInput);
    schedule();
  });
  es.addEventListener("log", (e) => {
    S.log.push(JSON.parse(e.data));
    if (S.log.length > 300) S.log.shift();
    if (S.view === "activity") schedule();
  });
  es.addEventListener("reload", () => loadState().catch(fail));
  es.onerror = () => {
    // EventSource reconnects by itself; a 401 means the session ended.
    api("GET", "/api/me").catch(() => {});
  };
}

let pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    renderMain();
    refreshDrawer();
    renderTabs();
  });
}

// ------------------------------------------------------------------ login --
function showLogin() {
  es?.close();
  S.user = null;
  const err = h("div", { class: "err" });
  const user = h("input", { type: "text", autocomplete: "username", value: "admin" });
  const pw = h("input", { type: "password", autocomplete: "current-password" });
  const code = h("input", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", placeholder: "123456", class: "code-input" });
  const codeLabel = h("label", { class: "field" }, "Code from your authenticator app");
  const useRecovery = h(
    "a",
    {
      href: "#",
      class: "sub",
      onclick: (e) => {
        e.preventDefault();
        const toRecovery = code.getAttribute("maxlength") === "6";
        code.value = "";
        code.classList.toggle("code-input", !toRecovery); // sized for 6 digits
        code.style.width = toRecovery ? "100%" : "";
        if (toRecovery) {
          code.removeAttribute("maxlength");
          code.setAttribute("inputmode", "text");
          code.setAttribute("autocomplete", "off");
          code.placeholder = "XXXX-XXXX-XXXX-XXXX";
          codeLabel.textContent = "Recovery code (each one works once)";
          useRecovery.textContent = "Use the authenticator app instead";
        } else {
          code.setAttribute("maxlength", "6");
          code.setAttribute("inputmode", "numeric");
          code.setAttribute("autocomplete", "one-time-code");
          code.placeholder = "123456";
          codeLabel.textContent = "Code from your authenticator app";
          useRecovery.textContent = "Lost your phone? Use a recovery code";
        }
        code.focus();
      },
    },
    "Lost your phone? Use a recovery code",
  );
  const codeRow = h("div", { class: "hidden" }, codeLabel, code, h("div", { style: { marginTop: "6px" } }, useRecovery));
  const btn = h("button", { class: "btn primary big", type: "submit" }, "Sign in");
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        err.textContent = "";
        try {
          const r = await api("POST", "/api/login", { user: user.value, password: pw.value, code: code.value.trim() || undefined });
          if (r.need_code) {
            codeRow.classList.remove("hidden");
            btn.disabled = false;
            btn.textContent = "Verify";
            setTimeout(() => code.focus(), 0);
            return;
          }
          S.user = r.user;
          await loadState();
          connectEvents();
          if (r.used_recovery) {
            toast(
              r.recovery_left
                ? `Signed in with a recovery code — ${plural(r.recovery_left, "code")} left. If you lost your phone, set up two-step sign-in again in Settings.`
                : "That was your last recovery code. Make new ones in Settings → Security now.",
              true,
            );
          }
        } catch (ex) {
          err.textContent = ex.message;
          btn.disabled = false;
        }
      },
    },
    h("label", { class: "field" }, "User"),
    user,
    h("label", { class: "field" }, "Password"),
    pw,
    codeRow,
    err,
    h("div", { style: { marginTop: "12px" } }, btn),
  );
  put($("#app"),
    h("div", { class: "login" },
      h("div", { class: "login-art" },
        h("div", { class: "login-brand" }, h("img", { src: "/favicon.png", alt: "" }), "FleetView"),
        h("div", { class: "login-pitch" },
          h("h2", {}, "Every computer in the office, from one place."),
          h("ul", {},
            [["download", "Install software silently on one PC or all of them"], ["shieldCheck", "Security baseline, updates and health checks"], ["layers", "Apply many changes to many PCs at once"], ["key", "A shared, end-to-end encrypted password vault"]]
              .map(([ic, t]) => h("li", {}, h("span", { class: "li-ico" }, icon(ic, 16)), t)))),
        h("div", { class: "login-foot" }, location.host)),
      h("div", { class: "login-panel" },
        h("div", { class: "login-box" }, h("img", { class: "login-logo", src: "/favicon.png", alt: "" }), h("h1", {}, "Sign in"), h("p", {}, "Use your FleetView administrator account."), form))),
  );
  setTimeout(() => pw.focus(), 0);
}

// ------------------------------------------------------------------ shell --
// ------------------------------------------------------------------ shell --
// Sidebar navigation, a header with the page title and search (Ctrl+K), and
// the page. Pages have their own address (#/computers…), so Back works and
// pages can be bookmarked.
const VIEWS = {
  dashboard: { label: "Home", icon: "home", section: "" },
  computers: { label: "Computers", icon: "monitor", section: "Devices" },
  apply: { label: "Apply changes", icon: "layers", section: "Devices" },
  cleaning: { label: "Cleaning", icon: "sparkles", section: "Devices" },
  activity: { label: "Activity", icon: "activity", section: "Devices" },
  scripts: { label: "Scripts", icon: "terminal", section: "Configure" },
  startup: { label: "Startup apps", icon: "zap", section: "Configure" },
  vault: { label: "Passwords", icon: "key", section: "Security" },
  settings: { label: "Settings", icon: "settings", section: "Admin" },
};
/** The page in the address: #/computers, or #/pc/<id>/<tab> for one PC. */
function viewFromHash() {
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  if (parts[0] === "pc" && parts[1]) {
    S.pcId = decodeURIComponent(parts[1]);
    S.pcTab = parts[2] || "overview";
    return "pc";
  }
  return VIEWS[parts[0]] ? parts[0] : "dashboard";
}
window.addEventListener("hashchange", () => {
  if (!S.user) return;
  const v = viewFromHash();
  if (v === S.view && v !== "pc") return;
  S.view = v;
  closeDrawer();
  renderTabs();
  renderMain(true);
});
function themeNow() {
  return document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
function toggleTheme() {
  const next = themeNow() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  safeSet("fv-theme", next);
  renderTabs();
}

function renderShell() {
  S.view = viewFromHash();
  const collapsed = safeGet("fv-side") === "collapsed";
  put(
    $("#app"),
    h(
      "div",
      { class: `shell${collapsed ? " collapsed" : ""}`, id: "shell" },
      h("aside", { class: "side", id: "side" }),
      h("div", { class: "side-scrim", onclick: () => $("#shell").classList.remove("nav-open") }),
      h(
        "div",
        { class: "content" },
        h(
          "header",
          { class: "hdr" },
          h("button", { class: "icon-btn only-sm", title: "Menu", onclick: () => $("#shell").classList.add("nav-open") }, icon("menu")),
          h("div", { class: "hdr-title", id: "hdr-title" }),
          h("div", { class: "spacer" }),
          h("button", { class: "search-trigger", onclick: () => openPalette() }, icon("search", 16), h("span", { class: "grow" }, "Search computers, pages, actions…"), h("kbd", {}, "Ctrl K")),
          h("button", { class: "icon-btn only-sm", title: "Search (Ctrl+K)", onclick: () => openPalette() }, icon("search")),
          h("div", { id: "hdr-running" }),
          h("button", { class: "btn primary", onclick: () => openInstall() }, icon("download", 16), h("span", { class: "hide-sm" }, "Install software")),
        ),
        h("main", { id: "main" }),
      ),
    ),
    h("div", { id: "drawer-root" }),
  );
  renderTabs();
  renderMain(true);
}

/** Sidebar and header: navigation, counts, user. (Name kept: called on every update.) */
function renderTabs() {
  const side = $("#side");
  if (!side) return;
  const running = [...S.jobs.values()].filter((j) => ["queued", "preparing", "sending", "installing", "running"].some((s) => j.counts[s])).length;
  const agents = [...S.agents.values()];
  const attention = agents.filter((a) => issuesOf(a).length).length;
  const counts = { computers: attention ? { n: attention, cls: "warn", title: `${attention} need attention` } : null, activity: running ? { n: running, cls: "blue", title: `${running} running` } : null };
  const item = (id) => {
    const v = VIEWS[id];
    const c = counts[id];
    return h(
      "a",
      { href: `#/${id}`, class: `nav-item${S.view === id || (id === "computers" && S.view === "pc") ? " active" : ""}`, title: v.label, onclick: (e) => { e.preventDefault(); go(id); } },
      icon(v.icon, 18),
      h("span", { class: "nav-label" }, v.label),
      c ? h("span", { class: `nav-count ${c.cls}`, title: c.title }, c.n) : null,
    );
  };
  const sections = [...new Set(Object.values(VIEWS).map((v) => v.section))];
  const dark = themeNow() === "dark";
  put(
    side,
    h(
      "div",
      { class: "side-brand" },
      h("img", { src: "/favicon.png", alt: "" }),
      h("div", { class: "nav-label brand-text" }, h("b", {}, "FleetView"), h("small", {}, S.master?.name ?? "")),
    ),
    h(
      "nav",
      { class: "side-nav" },
      sections.map((sec) => [
        sec ? h("div", { class: "nav-section" }, h("span", { class: "nav-label" }, sec)) : null,
        Object.keys(VIEWS).filter((id) => VIEWS[id].section === sec).map(item),
      ]),
    ),
    h(
      "div",
      { class: "side-foot" },
      h("div", { class: "side-user", title: S.user ?? "" }, h("span", { class: "avatar sm" }, (S.user ?? "?").slice(0, 1).toUpperCase()), h("span", { class: "nav-label grow" }, S.user)),
      h(
        "div",
        { class: "side-tools" },
        h("button", { class: "icon-btn", title: dark ? "Light theme" : "Dark theme", onclick: toggleTheme }, icon(dark ? "sun" : "moon")),
        h("button", {
          class: "icon-btn",
          title: "Sign out",
          onclick: async () => {
            lockVault();
            await api("POST", "/api/logout").catch(() => {});
            showLogin();
          },
        }, icon("logout")),
        h("button", {
          class: "icon-btn collapse-btn",
          title: "Collapse / expand the menu",
          onclick: () => {
            const s = $("#shell");
            s.classList.toggle("collapsed");
            safeSet("fv-side", s.classList.contains("collapsed") ? "collapsed" : "open");
          },
        }, icon("panel")),
      ),
    ),
  );
  const title = $("#hdr-title");
  const pcName = S.view === "pc" ? S.agents.get(S.pcId)?.hostname ?? "Computer" : null;
  if (title) {
    put(title, h("span", { class: "crumb-root" }, "FleetView"), icon("chevronRight", 14),
      pcName
        ? [h("a", { href: "#/computers", class: "crumb-link", onclick: (e) => { e.preventDefault(); go("computers"); } }, "Computers"), icon("chevronRight", 14), h("b", {}, pcName)]
        : h("b", {}, VIEWS[S.view]?.label ?? ""));
  }
  const run = $("#hdr-running");
  if (run) put(run, running ? h("button", { class: "run-pill", onclick: () => go("activity"), title: "Actions in progress" }, h("span", { class: "pulse" }), `${running} running`) : null);
  document.title = `${pcName ?? VIEWS[S.view]?.label ?? "FleetView"} · FleetView`;
}

function go(view) {
  if (!VIEWS[view]) view = "dashboard";
  $("#shell")?.classList.remove("nav-open");
  S.view = view;
  if (location.hash !== `#/${view}`) history.pushState(null, "", `#/${view}`);
  renderTabs();
  renderMain(true);
  $("#main")?.scrollTo?.(0, 0);
  window.scrollTo(0, 0);
}

function renderMain(full = false) {
  const main = $("#main");
  if (!main) return;
  if (S.view !== "vault") main.dataset.view = S.view;
  if (S.view !== "pc") S.page = null;
  if (S.view === "pc") {
    if (full || !S.page || S.page.id !== S.pcId) return mountDevice(main, S.pcId, S.pcTab);
    return S.page.live();
  }
  if (S.view === "dashboard") return renderDashboard(main);
  if (S.view === "computers") return renderComputers(main, full);
  if (S.view === "activity") return renderActivity(main);
  if (S.view === "settings") return renderSettings(main, full);
  if (S.view === "scripts") return renderScripts(main, full);
  if (S.view === "startup") return renderStartupView(main, full);
  if (S.view === "apply") return renderApply(main, full);
  if (S.view === "cleaning") return renderCleaning(main, full);
  if (S.view === "vault" && full) return renderVaultView(main);
}

// The password vault lives in its own module (public/vault/ui.js), loaded on
// first use. It only ever sends ciphertext to the server.
let vaultModule = null;
async function renderVaultView(main) {
  main.dataset.view = "vault";
  vaultModule ??= await import("./vault/ui.js");
  if (S.view !== "vault") return;
  vaultModule.renderVault(main, { h, put, api, toast, fail, openDrawer, closeDrawer, openSecurity: () => go("settings") });
}
function lockVault() {
  vaultModule?.lockVault("signed out");
}

/** A page title row: title, optional subtitle, buttons on the right. */
function pageHead(title, sub, ...tools) {
  return h("div", { class: "page-head" }, h("div", { class: "page-titles" }, h("h1", {}, title), sub ? h("p", { class: "page-sub" }, sub) : null), h("div", { class: "spacer" }), ...tools);
}

// --------------------------------------------------------- command palette --
function openPalette(initial = "") {
  if ($(".pal-scrim")) return;
  let q = initial;
  let idx = 0;
  let shown = [];
  const close = () => {
    root.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const runItem = (it) => {
    close();
    it?.run();
  };
  const input = h("input", { type: "text", class: "pal-input", value: q, placeholder: "Search computers, pages and actions…", autocomplete: "off", spellcheck: "false", oninput: (e) => { q = e.target.value; idx = 0; paint(); } });
  const list = h("div", { class: "pal-list" });
  const root = h(
    "div",
    { class: "pal-scrim", onclick: (e) => e.target === root && close() },
    h("div", { class: "palette", role: "dialog", "aria-label": "Search" },
      h("div", { class: "pal-top" }, icon("search", 18), input, h("kbd", {}, "Esc")),
      list,
      h("div", { class: "pal-foot" }, h("span", {}, h("kbd", {}, "↑"), h("kbd", {}, "↓"), " move"), h("span", {}, h("kbd", {}, "Enter"), " open"), h("span", {}, h("kbd", {}, "Esc"), " close"))),
  );
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); idx = Math.min(shown.length - 1, idx + 1); mark(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); idx = Math.max(0, idx - 1); mark(); }
    else if (e.key === "Enter") { e.preventDefault(); runItem(shown[idx]); }
  };
  const items = () => [
    ...Object.entries(VIEWS).map(([id, v]) => ({ group: "Pages", icon: v.icon, label: v.label, sub: "", run: () => go(id) })),
    { group: "Actions", icon: "download", label: "Install software", sub: "push an .exe or .msi", run: () => openInstall() },
    { group: "Actions", icon: "layers", label: "Apply changes", sub: "several changes on many PCs", run: () => openApply() },
    { group: "Actions", icon: "wrench", label: "Maintenance", sub: "updates, repair, cleanup, restart…", run: () => openTasks() },
    { group: "Actions", icon: "shieldCheck", label: "Security check on all online PCs", sub: "read-only", run: () => openTasks({ task: "security_status" }) },
    { group: "Actions", icon: "terminal", label: "New saved script", sub: "", run: () => { go("scripts"); openScriptEditor(); } },
    { group: "Actions", icon: themeNow() === "dark" ? "sun" : "moon", label: `Switch to ${themeNow() === "dark" ? "light" : "dark"} theme`, sub: "", run: toggleTheme },
    ...[...S.agents.values()]
      .sort((a, b) => (b.online - a.online) || a.hostname.localeCompare(b.hostname))
      .map((a) => ({ group: "Computers", icon: "monitor", online: a.online, label: a.hostname, sub: [a.user?.split("\\").pop(), a.ip, a.online ? "online" : `offline · ${ago(a.last_seen)}`, ...(a.tags ?? [])].filter(Boolean).join(" · "), run: () => openDevice(a.id) })),
  ];
  const mark = () => {
    list.querySelectorAll(".pal-item").forEach((el, i) => el.classList.toggle("active", i === idx));
    list.querySelector(".pal-item.active")?.scrollIntoView({ block: "nearest" });
  };
  function paint() {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (it) => words.every((w) => `${it.label} ${it.sub} ${it.group}`.toLowerCase().includes(w));
    const all = items().filter(hit);
    // Computers first when searching; pages and actions first otherwise.
    const order = words.length ? ["Computers", "Actions", "Pages"] : ["Pages", "Actions", "Computers"];
    const caps = { Computers: words.length ? 12 : 6, Actions: 8, Pages: 8 };
    shown = [];
    const groups = order.map((g) => {
      const its = all.filter((x) => x.group === g).slice(0, caps[g]);
      if (!its.length) return null;
      return h("div", { class: "pal-group" }, h("div", { class: "pal-gtitle" }, g), its.map((it) => {
        const i = shown.push(it) - 1;
        return h("button", { class: "pal-item", onmouseenter: () => { idx = i; mark(); }, onclick: () => runItem(it) },
          h("span", { class: "pal-ico" }, icon(it.icon, 16)),
          it.group === "Computers" ? h("span", { class: `dot${it.online ? " on" : ""}` }) : null,
          h("span", { class: "grow" }, h("b", {}, it.label), it.sub ? h("span", { class: "sub" }, ` ${it.sub}`) : null),
          h("span", { class: "pal-go" }, icon("chevronRight", 14)));
      }));
    });
    put(list, shown.length ? groups : h("div", { class: "pal-empty" }, `Nothing matches “${q}”`));
    idx = Math.min(idx, Math.max(0, shown.length - 1));
    mark();
  }
  document.body.append(root);
  document.addEventListener("keydown", onKey, true);
  paint();
  input.focus();
}
document.addEventListener("keydown", (e) => {
  if (!S.user) return;
  const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
  if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
    // The vault has its own Ctrl+K (search) while it is open.
    if (S.view === "vault" && !S.drawer) return;
    e.preventDefault();
    openPalette();
  } else if (e.key === "/" && !typing && !S.drawer && S.view !== "vault") {
    e.preventDefault();
    openPalette();
  }
});

// Open dropdown menus close when clicking anywhere else.
document.addEventListener("click", (e) => {
  for (const m of document.querySelectorAll("details.menu[open]")) if (!m.contains(e.target)) m.open = false;
});

// ----------------------------------------------------------- quick menus --
/** A small menu floating next to `anchor` (outside any scrolling table). */
function popMenu(anchor, items) {
  $(".pop-menu")?.remove();
  const close = () => {
    menu.remove();
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", esc, true);
    window.removeEventListener("scroll", close, true);
  };
  const outside = (e) => { if (!menu.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  const menu = h("div", { class: "card pop-menu", role: "menu" },
    items.map((it) => (it === "-" ? h("div", { class: "pop-sep" }) : it.title
      ? h("div", { class: "pop-title" }, it.title)
      : h("button", { class: `menu-item${it.danger ? " danger" : ""}`, disabled: !!it.disabled, title: it.hint ?? "", onclick: () => { close(); it.run(); } }, icon(it.icon ?? "play", 16), h("span", { class: "grow" }, it.label), it.sub ? h("span", { class: "sub" }, it.sub) : null))));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth, hgt = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`;
  menu.style.top = `${r.bottom + hgt + 8 > innerHeight ? Math.max(8, r.top - hgt - 4) : r.bottom + 4}px`;
  setTimeout(() => {
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", esc, true);
    window.addEventListener("scroll", close, true);
  }, 0);
}
/** One click from the Computers list to the usual tasks on that PC. */
function pcQuickMenu(anchor, a) {
  const off = !a.online;
  const hint = off ? "The PC is offline" : "";
  const t = (task, label, ic) => ({ label, icon: ic, disabled: off, hint, run: () => quickTask([a.id], task) });
  popMenu(anchor, [
    { title: a.hostname },
    t("check_updates", "Check for Windows updates", "refresh"),
    t("install_updates", "Install Windows updates", "download"),
    t("security_status", "Security check", "shieldCheck"),
    t("speed_test", "Internet speed test", "wifi"),
    t("perf_snapshot", "Performance snapshot", "gauge"),
    t("cleanup", "Clean up temporary files", "sparkles"),
    "-",
    { label: "Maintenance…", icon: "wrench", run: () => openDevice(a.id, "maintenance") },
    { label: "Apply changes…", icon: "layers", run: () => openApply([a.id]) },
    { label: "Install software…", icon: "package", run: () => openInstall({ ids: [a.id] }) },
    { label: "Restart…", icon: "power", run: () => openTasks({ ids: [a.id], task: "restart" }) },
    "-",
    { label: "Open", icon: "monitor", run: () => openDevice(a.id) },
  ]);
}

// ------------------------------------------------------------ attention --
/** What needs a look on a PC, most serious first. */
function issuesOf(a) {
  const out = [];
  const days = (iso) => (Date.now() - Date.parse(iso)) / 86400_000;
  if (!a.online && a.last_seen && days(a.last_seen) > 7) out.push({ level: 1, icon: "wifiOff", text: `Offline for ${Math.floor(days(a.last_seen))} days` });
  if (a.disk != null && a.disk >= 90) out.push({ level: 2, icon: "hardDrive", text: `Disk ${a.disk}% full` });
  if (a.online && a.mem != null && a.mem >= 92) out.push({ level: 1, icon: "gauge", text: `Memory ${a.mem}% used` });
  if (a.emanagement && ["error", "unsupported"].includes(a.emanagement.state)) out.push({ level: 2, icon: "alert", text: "MoldSign bridge not working" });
  if (a.outdated) out.push({ level: 0, icon: "download", text: "Agent update available" });
  if (a.pending_name) out.push({ level: 0, icon: "refresh", text: `Restart needed to become ${a.pending_name}` });
  if ((a.speed?.loss_gw ?? 0) >= 2) out.push({ level: 1, icon: "wifiOff", text: `${a.speed.loss_gw}% packet loss on the local network / Wi-Fi` });
  else if ((a.speed?.loss ?? 0) >= 2) out.push({ level: 1, icon: "wifi", text: `${a.speed.loss}% packet loss on the internet line` });
  const sec = lastRun(a.id, "Security check");
  if (sec?.state === "failed") out.push({ level: 1, icon: "shield", text: sec.message?.replace(/^Off: /, "Protection off: ") || "Security check found protection off", job: sec.job.id });
  for (const j of S.jobs.values()) {
    const t = j.targets[a.id];
    if (t?.state === "failed" && t.finished_at && days(t.finished_at) < 1 && j.title !== "Security check") {
      out.push({ level: 2, icon: "alert", text: `Failed: ${j.title}`, job: j.id });
      break;
    }
  }
  return out.sort((x, y) => y.level - x.level);
}

// -------------------------------------------------------------- dashboard --
function renderDashboard(main) {
  const agents = [...S.agents.values()];
  const online = agents.filter((a) => a.online).length;
  const flagged = agents.map((a) => ({ a, issues: issuesOf(a) })).filter((x) => x.issues.length).sort((x, y) => y.issues[0].level - x.issues[0].level || x.a.hostname.localeCompare(y.a.hostname));
  const jobs = [...S.jobs.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const running = jobs.filter((j) => ["queued", "preparing", "sending", "installing", "running"].some((s) => j.counts[s])).length;
  const cleaned = agents.filter((a) => a.cleaned).length;
  const speeds = agents.map((a) => a.speed?.down).filter((x) => x != null);
  const avgDown = speeds.length ? Math.round(speeds.reduce((s, x) => s + x, 0) / speeds.length) : null;
  const secChecked = agents.map((a) => lastRun(a.id, "Security check")).filter((r) => r && ["succeeded", "failed"].includes(r.state));
  const secOk = secChecked.filter((r) => r.state === "succeeded").length;
  const current = agents.filter((a) => !a.outdated).length;
  const hr = new Date().getHours();
  const hello = hr < 5 ? "Good evening" : hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
  const showComputers = (filter) => { S.filter = filter; go("computers"); };

  const kpi = (ic, tone, label, value, foot, onclick) =>
    h("button", { class: `kpi ${tone}`, onclick }, h("span", { class: "kpi-ico" }, icon(ic, 20)), h("span", { class: "kpi-body" }, h("span", { class: "kpi-label" }, label), h("b", { class: "kpi-value" }, value), h("span", { class: "kpi-foot" }, foot)));
  const health = (label, n, total, tone, onclick) => {
    const pct = total ? Math.round((n / total) * 100) : 0;
    return h("button", { class: "health-row", onclick }, h("div", { class: "row" }, h("span", { class: "grow" }, label), h("b", {}, total ? `${n} / ${total}` : "—"), h("span", { class: "sub" }, total ? ` ${pct}%` : "")), h("div", { class: `hbar ${tone}` }, h("i", { style: { width: `${pct}%` } })));
  };

  put(
    main,
    pageHead(`${hello}, ${S.user ?? ""}`, `${new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })} · ${plural(agents.length, "computer")} in ${S.master?.name || "this fleet"}`,
      h("button", { class: "btn", onclick: () => openApply() }, icon("layers", 16), "Apply changes"),
      h("button", { class: "btn", onclick: () => openTasks() }, icon("wrench", 16), "Maintenance")),
    h(
      "div",
      { class: "kpis" },
      kpi("monitor", "blue", "Online now", `${online} / ${agents.length}`, agents.length - online ? `${agents.length - online} offline` : "all online", () => showComputers("online")),
      kpi("alert", flagged.length ? "warn" : "ok", "Need attention", flagged.length, flagged.length ? "see the list below" : "nothing to fix", () => showComputers("attention")),
      kpi("activity", "violet", "Actions running", running, `${jobs.filter((j) => j.counts.failed).length} recent with failures`, () => go("activity")),
      kpi("sparkles", "ok", "Cleaned", `${cleaned} / ${agents.length}`, agents.length - cleaned ? `${agents.length - cleaned} not yet` : "all cleaned", () => showComputers("dirty")),
      kpi("wifi", "teal", "Internet (avg ↓)", avgDown != null ? `${avgDown} Mbps` : "—", speeds.length ? `from ${plural(speeds.length, "PC")}` : "no speed tests yet", () => go("apply")),
    ),
    h(
      "div",
      { class: "dash-grid" },
      h(
        "section",
        { class: "card dash-attn" },
        h("div", { class: "card-head" }, h("h3", {}, "Needs attention"), h("span", { class: "spacer" }), flagged.length ? h("button", { class: "btn ghost small", onclick: () => showComputers("attention") }, "View all", icon("chevronRight", 14)) : null),
        flagged.length
          ? h("div", { class: "attn-list" }, flagged.slice(0, 8).map(({ a, issues }) =>
              h("button", { class: "attn", onclick: () => (issues[0].job && issues[0].level >= 2 ? openJob(issues[0].job) : openDevice(a.id)) },
                h("span", { class: `attn-ico lvl${issues[0].level}` }, icon(issues[0].icon, 16)),
                h("span", { class: "grow" }, h("b", {}, a.hostname), h("span", { class: "sub" }, issues[0].text), issues.length > 1 ? h("span", { class: "sub" }, ` · +${issues.length - 1} more`) : null),
                h("span", { class: `dot${a.online ? " on" : ""}` }),
                icon("chevronRight", 14, "dim"))))
          : h("div", { class: "empty-state" }, h("span", { class: "es-ico ok" }, icon("checkCircle", 28)), h("b", {}, "All good"), h("span", {}, "No computer needs attention right now.")),
      ),
      h(
        "section",
        { class: "card dash-health" },
        h("div", { class: "card-head" }, h("h3", {}, "Fleet health")),
        health("Online", online, agents.length, "blue", () => showComputers("online")),
        health("Cleaned", cleaned, agents.length, "ok", () => showComputers("dirty")),
        health("Security check passed", secOk, secChecked.length, secChecked.length && secOk < secChecked.length ? "warn" : "ok", () => openTasks({ task: "security_status" })),
        health("Agent up to date", current, agents.length, "violet", () => showComputers("outdated")),
        secChecked.length < agents.length ? h("div", { class: "sub", style: { marginTop: "8px" } }, `${agents.length - secChecked.length} PC(s) never had a security check. `, h("a", { href: "#", onclick: (e) => { e.preventDefault(); openTasks({ task: "security_status" }); } }, "Run it")) : null,
      ),
      h(
        "section",
        { class: "card dash-activity" },
        h("div", { class: "card-head" }, h("h3", {}, "Recent activity"), h("span", { class: "spacer" }), h("button", { class: "btn ghost small", onclick: () => go("activity") }, "All activity", icon("chevronRight", 14))),
        jobs.length
          ? jobs.slice(0, 7).map((j) => h("button", { class: "act-row", onclick: () => openJob(j.id) },
              h("span", { class: "grow" }, h("b", {}, j.title), jobResultLine(j), h("span", { class: "sub" }, `${ago(j.created_at)} · ${plural(Object.keys(j.targets).length, "computer")}${j.by ? ` · ${j.by}` : ""}`)),
              summaryBar(j, false),
              statePill(overallState(j))))
          : h("div", { class: "empty-state" }, h("span", { class: "es-ico" }, icon("activity", 28)), h("b", {}, "Nothing yet"), h("span", {}, "Installs, tasks and scripts show up here with a result per computer.")),
      ),
      h(
        "section",
        { class: "card dash-quick" },
        h("div", { class: "card-head" }, h("h3", {}, "Quick actions")),
        h("div", { class: "quick-grid" },
          [
            ["download", "Install software", "Push an .exe or .msi silently", () => openInstall()],
            ["layers", "New PC setup", "Baseline, adblock, debloat, updates", () => { AP.steps = []; APPLY_PRESETS[0].steps.forEach(apAdd); AP.name = "New PC setup"; openApply(); }],
            ["shieldCheck", "Health check", "Security, updates, disks, speed", () => { AP.steps = []; APPLY_PRESETS.find((p) => p.id === "health").steps.forEach(apAdd); AP.name = "Health check"; openApply(); }],
            ["refresh", "Fix Windows Update", "Repair, then install updates", () => { AP.steps = []; APPLY_PRESETS.find((p) => p.id === "updates").steps.forEach(apAdd); AP.name = "Fix & install updates"; openApply(); }],
          ].map(([ic, t, s, fn]) => h("button", { class: "quick", onclick: fn }, h("span", { class: "quick-ico" }, icon(ic, 18)), h("b", {}, t), h("span", { class: "sub" }, s)))),
      ),
    ),
  );
}

// --------------------------------------------------------------- cleaning --
// Which PCs are cleaned, and whether it helped: CPU and memory averages for the
// 7 days before the mark against the time since, boot time from snapshots.
const CL = { filter: "all", data: null, loading: false, selected: new Set() };
async function loadCleaning() {
  if (CL.loading) return;
  CL.loading = true;
  try {
    CL.data = await api("GET", "/api/metrics/fleet");
  } catch {
    CL.data = null;
  }
  CL.loading = false;
  if (S.view === "cleaning") renderCleaning($("#main"), true);
}
function renderCleaning(main, full) {
  // Live updates refresh the data (a PC may just have been marked).
  const key = [...S.agents.values()].map((a) => `${a.id}:${a.cleaned?.at ?? ""}`).join(",");
  if (!full && CL.key === key) return;
  if (CL.key !== key) {
    CL.key = key;
    if (!full || !CL.data) loadCleaning();
  }
  const agents = [...S.agents.values()];
  const rows = new Map((CL.data?.rows ?? []).map((r) => [r.id, r]));
  const cleaned = agents.filter((a) => a.cleaned);
  const dirty = agents.filter((a) => !a.cleaned);
  const f = CL.data;
  const pct = (x) => (x == null ? "—" : `${r1(x)}%`);
  const list = agents
    .filter((a) => (CL.filter === "cleaned" ? a.cleaned : CL.filter === "dirty" ? !a.cleaned : true))
    .sort((a, b) => (!!a.cleaned - !!b.cleaned) || String(b.cleaned?.at ?? "").localeCompare(String(a.cleaned?.at ?? "")) || a.hostname.localeCompare(b.hostname));
  for (const id of [...CL.selected]) if (!S.agents.has(id)) CL.selected.delete(id);
  const sel = [...CL.selected];
  const seg = (id, label, n) => h("button", { class: CL.filter === id ? "active" : "", onclick: () => { CL.filter = id; renderCleaning(main, true); } }, label, h("span", { class: "seg-n" }, n));
  const cleanUp = (ids) => { AP.steps = []; APPLY_PRESETS.find((p) => p.id === "clean").steps.forEach(apAdd); AP.name = "Clean-up"; openApply(ids); };
  const kpi = (ic, tone, label, value, foot) => h("div", { class: `kpi ${tone}` }, h("span", { class: "kpi-ico" }, icon(ic, 20)), h("span", { class: "kpi-body" }, h("span", { class: "kpi-label" }, label), h("b", { class: "kpi-value" }, value), h("span", { class: "kpi-foot" }, foot)));
  put(
    main,
    pageHead("Cleaning", "Which computers are cleaned, and whether it made them faster.",
      h("button", { class: "btn", onclick: () => cleanUp(dirty.map((a) => a.id)) , disabled: !dirty.length }, icon("sparkles", 16), "Clean-up (debloat, temp files)…"),
      h("button", { class: "btn primary", disabled: !dirty.length, onclick: () => runMissing(dirty.map((a) => a.id)) }, icon("play", 16), `Finish the checklist on ${dirty.length} PC(s)…`)),
    h("div", { class: "note info ck-rule" }, "A PC is marked cleaned by itself when: the security baseline is applied, a security check was done, the adblocker is installed, Windows Update was repaired, checked and installed, the clean-up ran, and it has exactly two accounts besides Windows' own, one of them named Admin. Hover a checklist count for what's missing."),
    h(
      "div",
      { class: "kpis" },
      kpi("sparkles", "ok", "Cleaned", `${cleaned.length} / ${agents.length}`, dirty.length ? `${dirty.length} still to do` : "all done"),
      kpi("cpu", "blue", "CPU before → after", f?.measured ? `${pct(f.cpu_before)} → ${pct(f.cpu_after)}` : "—", f?.measured ? `average of ${plural(f.measured, "PC")}` : "needs a few days of data"),
      kpi("gauge", "violet", "Memory before → after", f?.measured ? `${pct(f.mem_before)} → ${pct(f.mem_after)}` : "—", f?.measured ? `average of ${plural(f.measured, "PC")}` : "needs a few days of data"),
    ),
    h(
      "div",
      { class: "card grid-card" },
      h("div", { class: "toolbar" },
        h("div", { class: "seg" }, seg("all", "All", agents.length), seg("dirty", "Not cleaned", dirty.length), seg("cleaned", "Cleaned", cleaned.length)),
        h("span", { class: "spacer" }),
        sel.length
          ? [h("span", { class: "sub" }, `${sel.length} chosen`),
             h("button", { class: "btn small primary", onclick: () => runMissing(sel) }, icon("play", 14), "Run what's missing…"),
             h("button", { class: "btn small", onclick: () => cleanUp(sel) }, icon("sparkles", 14), "Clean up…"),
             h("button", { class: "btn small", onclick: () => setCleaned(sel, true).then(() => CL.selected.clear()) }, icon("check", 14), "Mark cleaned"),
             h("button", { class: "icon-btn", title: "Clear the selection", onclick: () => { CL.selected.clear(); renderCleaning(main, true); } }, icon("x", 16))]
          : h("span", { class: "sub" }, "Tick computers to clean them up or mark them.")),
      h("div", { class: "table-wrap" },
        h("table", { class: "grid" },
          h("thead", {}, h("tr", {},
            h("th", { class: "cb" }, h("input", { type: "checkbox", checked: list.length > 0 && list.every((a) => CL.selected.has(a.id)), onclick: (e) => { list.forEach((a) => (e.target.checked ? CL.selected.add(a.id) : CL.selected.delete(a.id))); renderCleaning(main, true); } })),
            h("th", {}, "Computer"), h("th", {}, "Cleaned"), h("th", {}, "Checklist"), h("th", { class: "hide-sm" }, "CPU before → after"), h("th", { class: "hide-sm" }, "Memory before → after"), h("th", { class: "hide-md" }, "Boot"), h("th", { class: "act" }))),
          h("tbody", {},
            list.length
              ? list.map((a) => {
                  const r = rows.get(a.id);
                  const both = (b, x) => (b == null && x == null ? h("span", { class: "sub" }, "—") : [`${pct(b)} → ${pct(x)} `, delta(b, x) ?? ""]);
                  return h("tr", { class: CL.selected.has(a.id) ? "selected" : "", onclick: (e) => { if (e.target.type !== "checkbox" && !e.target.closest("button")) openDevice(a.id); } },
                    h("td", { class: "cb" }, h("input", { type: "checkbox", checked: CL.selected.has(a.id), onclick: (e) => { e.stopPropagation(); e.target.checked ? CL.selected.add(a.id) : CL.selected.delete(a.id); renderCleaning(main, true); } })),
                    h("td", { class: "name-cell" }, h("div", { class: "pc-name" }, h("span", { class: `dot${a.online ? " on" : ""}` }), h("span", { class: "grow" }, h("b", {}, a.hostname), h("span", { class: "sub pc-meta" }, a.user ? a.user.split("\\").pop() : a.online ? "online" : `offline · ${ago(a.last_seen)}`)))),
                    h("td", {}, a.cleaned
                      ? h("span", { class: "status-cell" }, h("span", { class: "badge ok" }, icon("sparkles", 12), new Date(a.cleaned.at).toLocaleDateString()), h("span", { class: "sub" }, `${ago(a.cleaned.at)}${a.cleaned.by ? ` · ${a.cleaned.by}` : ""}${a.cleaned.note ? ` · ${a.cleaned.note}` : ""}`))
                      : h("span", { class: "badge warn" }, "Not cleaned")),
                    h("td", {}, a.clean
                      ? h("span", { class: `ck-count small${a.clean.ok ? " ok" : ""}`, title: a.clean.items.map((i) => `${i.ok ? "✓" : "✗"} ${i.label}${i.ok ? "" : ` — ${i.detail}`}`).join("\n") }, `${a.clean.done}/${a.clean.total}`)
                      : h("span", { class: "sub" }, "—")),
                    h("td", { class: "hide-sm" }, a.cleaned ? both(r?.before?.cpu, r?.after?.cpu) : h("span", { class: "sub" }, "—")),
                    h("td", { class: "hide-sm" }, a.cleaned ? both(r?.before?.mem, r?.after?.mem) : h("span", { class: "sub" }, "—")),
                    h("td", { class: "hide-md" }, r && (r.boot_before || r.boot_after) ? [`${r.boot_before ? Math.round(r.boot_before / 1000) : "—"} → ${r.boot_after ? Math.round(r.boot_after / 1000) : "—"} s `, delta(r.boot_before && r.boot_before / 1000, r.boot_after && r.boot_after / 1000, " s") ?? ""] : h("span", { class: "sub" }, "—")),
                    h("td", { class: "act" }, a.cleaned
                      ? h("span", { class: "row-go" }, icon("chevronRight", 16))
                      : h("button", { class: "btn small", onclick: (e) => { e.stopPropagation(); runMissing([a.id]); } }, "Run what's missing…")),
                  );
                })
              : h("tr", { class: "empty-row" }, h("td", { colspan: 8 }, h("div", { class: "empty-state" }, h("span", { class: "es-ico ok" }, icon("sparkles", 28)), h("b", {}, CL.filter === "dirty" ? "Every computer is cleaned" : "Nothing here yet"), h("span", {}, "Run a Clean-up (snapshot → debloat → temp files → mark) from Apply changes."))))),
        ),
      ),
    ),
    h("p", { class: "sub", style: { marginTop: "12px" } }, "Averages are taken while each PC was on: the 7 days before the mark against the time since (up to 7 days). How a PC is used matters too — compare several PCs, not one. Boot times come from performance snapshots taken before and after the mark."),
  );
}

// -------------------------------------------------------------- computers --
const SORTS = {
  name: (a, b) => a.hostname.localeCompare(b.hostname),
  status: (a, b) => (b.online - a.online) || issuesOf(b).length - issuesOf(a).length,
  user: (a, b) => String(a.user ?? "~").localeCompare(String(b.user ?? "~")),
  cpu: (a, b) => (a.online ? a.cpu ?? -1 : -1) - (b.online ? b.cpu ?? -1 : -1),
  mem: (a, b) => (a.mem ?? -1) - (b.mem ?? -1),
  disk: (a, b) => (a.disk ?? -1) - (b.disk ?? -1),
  net: (a, b) => (a.speed?.down ?? -1) - (b.speed?.down ?? -1),
  agent: (a, b) => String(a.agent_version).localeCompare(String(b.agent_version), undefined, { numeric: true }),
  seen: (a, b) => (a.online - b.online) || String(a.last_seen ?? "").localeCompare(String(b.last_seen ?? "")),
};
S.sort = { key: "status", dir: 1 };
S.tag = "";

function filteredAgents() {
  const q = S.query.trim().toLowerCase();
  const sort = SORTS[S.sort.key] ?? SORTS.status;
  return [...S.agents.values()]
    .filter((a) => {
      if (S.filter === "online" && !a.online) return false;
      if (S.filter === "offline" && a.online) return false;
      if (S.filter === "outdated" && !a.outdated) return false;
      if (S.filter === "dirty" && a.cleaned) return false;
      if (S.filter === "cleaned" && !a.cleaned) return false;
      if (S.filter === "attention" && !issuesOf(a).length) return false;
      if (S.tag && !(a.tags ?? []).includes(S.tag)) return false;
      if (!q) return true;
      return [a.hostname, a.user, a.ip, a.os, ...(a.tags ?? [])].some((x) => String(x ?? "").toLowerCase().includes(q));
    })
    .sort((a, b) => S.sort.dir * sort(a, b) || a.hostname.localeCompare(b.hostname));
}

function renderComputers(main, full) {
  const agents = [...S.agents.values()];
  if (full || !$("#devtable")) {
    const count = (f) => agents.filter(f).length;
    const seg = (id, label, n) => h("button", { class: S.filter === id ? "active" : "", onclick: () => { S.filter = id; renderComputers(main, true); } }, label, n != null ? h("span", { class: "seg-n" }, n) : null);
    const tags = [...new Set(agents.flatMap((a) => a.tags ?? []))].sort();
    const th = (key, label, cls = "") =>
      h("th", { class: `sortable ${cls}${S.sort.key === key ? " sorted" : ""}`, onclick: () => { S.sort = { key, dir: S.sort.key === key ? -S.sort.dir : key === "name" || key === "user" ? 1 : -1 }; renderComputers(main, true); } },
        h("span", { class: "th-in" }, label, icon(S.sort.key === key ? (S.sort.dir > 0 ? "chevronUp" : "chevronDown") : "sort", 13)));
    put(
      main,
      pageHead("Computers", `${count((a) => a.online)} of ${agents.length} online`,
        h("button", { class: "btn", onclick: () => openTasks() }, icon("wrench", 16), "Maintenance"),
        h("button", { class: "btn", onclick: () => openApply() }, icon("layers", 16), "Apply changes")),
      h(
        "div",
        { class: "card grid-card" },
        h(
          "div",
          { class: "toolbar" },
          h("div", { class: "input-ico" }, icon("search", 16), h("input", { type: "search", class: "search", placeholder: "Search name, user, IP, tag…", value: S.query, oninput: (e) => { S.query = e.target.value; renderRows(); } })),
          h("div", { class: "seg seg-filter" },
            seg("all", "All", agents.length),
            seg("online", "Online", count((a) => a.online)),
            seg("offline", "Offline", count((a) => !a.online)),
            seg("attention", "Needs attention", count((a) => issuesOf(a).length)),
            seg("dirty", "Not cleaned", count((a) => !a.cleaned)),
            seg("cleaned", "Cleaned", count((a) => a.cleaned)),
            count((a) => a.outdated) ? seg("outdated", "Agent outdated", count((a) => a.outdated)) : null),
          tags.length
            ? h("select", { class: "tag-select", title: "Only computers with this tag", onchange: (e) => { S.tag = e.target.value; renderRows(); } }, h("option", { value: "" }, "All tags"), tags.map((t) => h("option", { value: t, selected: S.tag === t }, t)))
            : null,
          h("span", { class: "spacer" }),
          h("span", { class: "sub", id: "rowcount" }),
        ),
        h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            { id: "devtable", class: "grid" },
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                h("th", { class: "cb" }, h("input", { type: "checkbox", id: "selall", title: "Select all shown", onclick: (e) => {
                  const ids = filteredAgents().map((a) => a.id);
                  if (e.target.checked) ids.forEach((id) => S.selected.add(id));
                  else ids.forEach((id) => S.selected.delete(id));
                  renderRows();
                } })),
                th("name", "Computer"),
                th("status", "Status"),
                th("user", "User", "hide-sm"),
                th("cpu", "CPU", "hide-md"),
                th("mem", "Memory", "hide-md"),
                th("disk", "Disk", "hide-sm"),
                th("net", "Internet", "hide-md"),
                th("agent", "Agent", "hide-lg"),
                h("th", { class: "act" }),
              ),
            ),
            h("tbody", { id: "devrows" }),
          ),
        ),
      ),
      h("div", { id: "selbar-root" }),
    );
  }
  renderRows();
}

function meter(pct) {
  if (pct == null) return h("span", { class: "sub" }, "—");
  const m = h("span", { class: `meter${pct >= 90 ? " hot" : pct >= 75 ? " warm" : ""}` }, h("i", { style: { width: `${Math.min(100, pct)}%` } }));
  return h("span", { class: "meter-cell" }, m, h("span", { class: "meter-n" }, `${pct}%`));
}

function renderRows() {
  const tbody = $("#devrows");
  if (!tbody) return;
  const list = filteredAgents();
  for (const id of [...S.selected]) if (!S.agents.has(id)) S.selected.delete(id);
  const rc = $("#rowcount");
  if (rc) rc.textContent = list.length === S.agents.size ? plural(list.length, "computer") : `${list.length} of ${S.agents.size}`;
  if (!list.length) {
    put(tbody,
      h("tr", { class: "empty-row" }, h("td", { colspan: 10 },
        h("div", { class: "empty-state" },
          h("span", { class: "es-ico" }, icon("monitor", 28)),
          S.agents.size
            ? [h("b", {}, "No computers match"), h("span", {}, "Try another search or filter."), h("button", { class: "btn small", onclick: () => { S.query = ""; S.filter = "all"; S.tag = ""; renderComputers($("#main"), true); } }, "Clear filters")]
            : [h("b", {}, "No computers yet"), h("span", {}, "Download the agent installer in Settings and run it on each PC. They appear here within seconds."), h("button", { class: "btn primary small", onclick: () => go("settings") }, "Get the agent")]))),
    );
  } else {
    put(tbody,
      ...list.map((a) => {
        const issues = issuesOf(a);
        return h(
          "tr",
          { class: S.selected.has(a.id) ? "selected" : "", onclick: (e) => { if (e.target.type !== "checkbox") openDevice(a.id); } },
          h("td", { class: "cb" }, h("input", { type: "checkbox", checked: S.selected.has(a.id), onclick: (e) => {
            e.stopPropagation();
            e.target.checked ? S.selected.add(a.id) : S.selected.delete(a.id);
            renderRows();
          } })),
          h("td", { class: "name-cell" },
            h("div", { class: "pc-name" },
              h("span", { class: "pc-ico" }, icon("monitor", 16)),
              h("span", { class: "grow" },
                h("span", { class: "pc-line" }, h("b", {}, a.hostname), (a.tags ?? []).slice(0, 2).map((t) => h("span", { class: "tag" }, t))),
                h("span", { class: "sub pc-meta" }, [a.ip, a.os?.replace(/^Microsoft /, "")].filter(Boolean).join(" · ") || "—")))),
          h("td", {},
            h("div", { class: "status-cell" },
              h("span", { class: `status ${a.online ? "on" : "off"}` }, h("span", { class: "sdot" }), a.online ? "Online" : `Offline · ${ago(a.last_seen)}`),
              a.cleaned ? h("span", { class: "badge ok", title: `Cleaned ${new Date(a.cleaned.at).toLocaleString()} by ${a.cleaned.by || "—"}${a.cleaned.note ? ` — ${a.cleaned.note}` : ""}` }, icon("sparkles", 12), "Cleaned") : null,
              a.pending_name ? h("span", { class: "badge warn", title: "The new name takes effect when the PC restarts" }, `→ ${a.pending_name}`) : null,
              issues.length ? h("span", { class: `badge ${issues[0].level >= 2 ? "bad" : "warn"}`, title: issues.map((i) => i.text).join("\n") }, icon("alert", 12), issues.length === 1 ? issues[0].text : `${issues.length} issues`) : null)),
          h("td", { class: "hide-sm" }, a.user ? h("span", { class: "user-cell" }, icon("user", 14, "dim"), a.user.split("\\").pop()) : h("span", { class: "sub" }, "—")),
          h("td", { class: "hide-md" }, a.online ? meter(a.cpu) : h("span", { class: "sub" }, "—")),
          h("td", { class: "hide-md" }, meter(a.mem)),
          h("td", { class: "hide-sm" }, meter(a.disk)),
          h("td", { class: "hide-md" }, a.speed?.down != null ? h("span", { class: "net-cell", title: `${ago(a.speed.at)}${a.speed.ping != null ? ` · ${r1(a.speed.ping)} ms` : ""}` }, h("b", {}, Math.round(a.speed.down)), h("span", { class: "sub" }, ` / ${Math.round(a.speed.up ?? 0)} Mbps`),
            Math.max(a.speed.loss ?? 0, a.speed.loss_gw ?? 0) > 0 ? h("span", { class: `badge ${lossTone(Math.max(a.speed.loss ?? 0, a.speed.loss_gw ?? 0)) === "bad" ? "bad" : "warn"}`, style: { marginLeft: "6px" }, title: `Packet loss: internet ${a.speed.loss ?? "—"}%, router ${a.speed.loss_gw ?? "—"}%` }, `${r1(Math.max(a.speed.loss ?? 0, a.speed.loss_gw ?? 0))}% loss`) : null) : h("span", { class: "sub" }, "—")),
          h("td", { class: "hide-lg" }, h("span", { class: "mono" }, a.agent_version || "—"), a.outdated ? h("span", { class: "badge warn", style: { marginLeft: "6px" } }, "update") : null),
          h("td", { class: "act" }, h("button", { class: "icon-btn row-menu", title: "Quick actions", onclick: (e) => { e.stopPropagation(); pcQuickMenu(e.currentTarget, a); } }, icon("more", 18))),
        );
      }),
    );
  }
  const all = $("#selall");
  if (all) all.checked = list.length > 0 && list.every((a) => S.selected.has(a.id));
  renderSelbar();
}

function renderSelbar() {
  const root = $("#selbar-root");
  if (!root) return;
  const n = S.selected.size;
  if (!n) return put(root, );
  const ids = [...S.selected];
  put(root, 
    h(
      "div",
      { class: "selbar" },
      h("span", { class: "sel-count" }, h("b", {}, n), n === 1 ? " computer" : " computers"),
      h("span", { class: "sel-sep" }),
      h("button", { class: "btn primary", onclick: () => openApply(ids) }, icon("layers", 16), "Apply changes"),
      h("button", { class: "btn", onclick: () => openInstall({ mode: "selected" }) }, icon("download", 16), "Install"),
      h("button", { class: "btn", onclick: () => openTasks({ ids }) }, icon("wrench", 16), "Maintenance"),
      h("button", { class: "btn", onclick: () => openRunScript({ ids }) }, icon("terminal", 16), "Run script"),
      h("button", { class: "btn", onclick: () => setCleaned(ids, true) }, icon("sparkles", 16), "Mark cleaned"),
      h("details", { class: "menu sel-more" },
        h("summary", { class: "btn" }, icon("more", 16), "More"),
        h("div", { class: "card menu-list menu-up" },
          [["users", "Accounts", () => openAccountsBulk(ids)], ["terminal", "PowerShell", () => openScript(ids)], ["edit", "Rename", () => openRename(ids)], ["message", "Message the user", () => openMessage(ids)], ["settings", "Agent settings", () => openAgentSettings(ids)]]
            .map(([ic, l, fn]) => h("button", { class: "menu-item", onclick: (e) => { e.target.closest("details").open = false; fn(); } }, icon(ic, 16), l)))),
      h("button", { class: "icon-btn", title: "Clear the selection", onclick: () => { S.selected.clear(); renderRows(); } }, icon("x", 18)),
    ),
  );
}

// ---------------------------------------------------------------- drawers --
function openDrawer(d) {
  S.drawer = d;
  const root = $("#drawer-root");
  const close = () => closeDrawer();
  const header = h("header", {}, h("h2", { class: "grow" }, d.title), h("div", { class: "spacer" }), d.headTools?.(), h("button", { class: "btn ghost", onclick: close, title: "Close (Esc)" }, "✕"));
  d.body = h("div", { class: "body" });
  d.footer = h("footer", {});
  put(root, h("div", { class: "scrim", onclick: close }), h("aside", { class: `drawer${d.wide ? " wide" : ""}` }, header, d.body, d.footer));
  d.render();
}
function closeDrawer() {
  S.drawer = null;
  $("#drawer-root")?.replaceChildren();
}
function refreshDrawer() {
  S.drawer?.live?.();
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && S.drawer) return closeDrawer();
  // Drawer shortcuts (moving between PCs), never while typing.
  const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
  const target = S.drawer ?? (S.view === "pc" ? S.page : null);
  if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && target?.onKey?.(e)) e.preventDefault();
});

// ---- shared: which computers an action goes to ----
// tg = { mode: "these" | "selected" | "online" | "all", ids: [...] }
function newTargets(ids, mode) {
  return { mode: mode ?? (ids?.length ? "these" : S.selected.size ? "selected" : "online"), ids: ids ?? [] };
}
function targetIds(tg) {
  if (tg.mode === "these") return tg.ids;
  if (tg.mode === "selected") return [...S.selected];
  if (tg.mode === "online") return [...S.agents.values()].filter((a) => a.online).map((a) => a.id);
  return [...S.agents.keys()];
}
/** What the API gets: "online"/"all" are resolved on the server at send time. */
function targetParam(tg) {
  return tg.mode === "online" || tg.mode === "all" ? tg.mode : targetIds(tg);
}
function targetPicker(tg, onChange) {
  const all = S.agents.size;
  const online = [...S.agents.values()].filter((a) => a.online).length;
  const b = (mode, label, n, disabled) =>
    h("button", { class: tg.mode === mode ? "active" : "", disabled, onclick: () => { tg.mode = mode; onChange(); } }, `${label} (${n})`);
  return h(
    "div",
    { class: "seg", id: "target-seg" },
    tg.ids.length
      ? b("these", tg.ids.length === 1 ? S.agents.get(tg.ids[0])?.hostname ?? "This PC" : "These", tg.ids.length, false)
      : b("selected", "Selected", S.selected.size, !S.selected.size),
    b("online", "All online", online, !online),
    b("all", "All computers", all, !all),
  );
}
function offlineNote(tg, waitOffline) {
  const off = targetIds(tg).filter((id) => !S.agents.get(id)?.online).length;
  return off ? `${off} offline — ${waitOffline ? "they get it when they connect" : "they will be skipped"}` : "";
}

// ---- install ----
function openInstall({ mode, ids, installerId } = {}) {
  const st = {
    installer: installerId ? S.installers.find((i) => i.id === installerId) ?? null : null,
    args: "",
    isMsi: false,
    kind: "custom",
    mode: mode ?? (ids ? "these" : S.selected.size ? "selected" : "online"),
    ids: ids ?? [],
    waitOffline: true,
    skip: false,
    skipName: "",
    upload: null,
    showLib: false,
  };
  const pick = (item) => {
    st.installer = item;
    st.args = item.args;
    st.isMsi = item.is_msi;
    st.kind = item.kind;
    st.skipName = "";
  };
  if (st.installer) pick(st.installer);

  const targets = () => targetIds(st);

  const d = {
    title: "Install software",
    render() {
      put(d.body, stepFile(), stepTargets(), stepOptions());
      d.footerRender();
    },
    footerRender() {
      const ids = targets();
      const off = ids.filter((id) => !S.agents.get(id)?.online).length;
      const go = h(
        "button",
        {
          class: "btn primary big",
          disabled: !st.installer || !ids.length || st.upload,
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              const { job } = await api("POST", "/api/jobs", {
                kind: "install",
                targets: targetParam(st),
                wait_offline: st.waitOffline,
                payload: { installer_id: st.installer.id, args: st.args, is_msi: st.isMsi, skip_if: st.skip ? st.skipName : "" },
              });
              S.jobs.set(job.id, job);
              toast(`Installing ${st.installer.file_name} on ${plural(ids.length, "computer")}`);
              openJob(job.id);
            } catch (ex) {
              fail(ex);
              e.target.disabled = false;
            }
          },
        },
        ids.length ? `Install on ${plural(ids.length, "computer")}` : "Choose computers",
      );
      put(d.footer, 
        go,
        h("span", { class: "sub" }, off ? `${off} offline — ${st.waitOffline ? "they get it when they connect" : "they will be skipped"}` : ""),
      );
    },
    live() {
      // Only the counts change with live updates; keep the form as it is.
      d.footerRender();
      const seg = $("#target-seg", d.body);
      if (seg) seg.replaceWith(targetSeg());
    },
  };

  function stepFile() {
    const wrap = h("div", { class: "step" }, h("div", { class: "step-title" }, h("span", { class: "step-num" }, "1"), "Installer"));
    if (st.upload) {
      const bar = h("i");
      bar.style.width = `${Math.round(st.upload.pct * 100)}%`;
      wrap.append(h("div", { class: "chosen" }, h("b", {}, st.upload.name), h("div", { class: "sub" }, `uploading… ${Math.round(st.upload.pct * 100)}%`), h("div", { class: "upbar" }, bar)));
      return wrap;
    }
    if (st.installer && !st.showLib) {
      const i = st.installer;
      const presetSel = h(
        "select",
        {
          onchange: (e) => {
            st.kind = e.target.value;
            const p = S.presets[st.kind];
            if (st.kind !== "custom") st.args = p.args;
            st.isMsi = p.isMsi;
            d.render();
          },
        },
        Object.entries(S.presets).map(([k, p]) => h("option", { value: k, selected: k === st.kind }, p.label)),
      );
      const args = h("input", {
        type: "text",
        class: "mono",
        value: st.args,
        placeholder: "silent switches, e.g. /S",
        oninput: (e) => {
          st.args = e.target.value;
          if (st.kind !== "custom" && st.args !== S.presets[st.kind]?.args) {
            st.kind = "custom";
            presetSel.value = "custom";
          }
        },
      });
      wrap.append(
        h(
          "div",
          { class: "chosen" },
          h(
            "div",
            { class: "row" },
            h("div", { class: "grow" }, h("b", {}, i.file_name), h("div", { class: "sub" }, `${fmtSize(i.size)} · detected: ${i.kind_label}`)),
            h("button", { class: "btn small", onclick: () => { st.showLib = true; d.render(); } }, "Change"),
          ),
          h("div", { class: "grid2", style: { marginTop: "10px" } }, h("div", {}, h("label", { class: "field" }, "Installer type"), presetSel), h("div", {}, h("label", { class: "field" }, "Silent switches"), args)),
          h("div", { class: "sub", style: { marginTop: "8px" } }, "Runs as: ", h("code", {}, st.isMsi ? `msiexec /i "${i.file_name}" ${st.args}` : `"${i.file_name}" ${st.args}`), " — as SYSTEM, with no window."),
          S.warnings[st.kind] ? h("div", { class: "note" }, S.warnings[st.kind]) : null,
        ),
      );
      return wrap;
    }
    const input = h("input", { type: "file", accept: ".exe,.msi", class: "hidden", onchange: (e) => e.target.files[0] && upload(e.target.files[0]) });
    const drop = h(
      "div",
      {
        class: "drop",
        onclick: () => input.click(),
        ondragover: (e) => { e.preventDefault(); drop.classList.add("over"); },
        ondragleave: () => drop.classList.remove("over"),
        ondrop: (e) => {
          e.preventDefault();
          drop.classList.remove("over");
          const f = e.dataTransfer.files[0];
          if (f) upload(f);
        },
      },
      h("b", {}, "Drop an .exe or .msi here"),
      h("div", {}, "or click to choose — its silent switches are detected for you"),
      input,
    );
    wrap.append(drop);
    if (S.installers.length) {
      wrap.append(
        h("label", { class: "field" }, "Or use one you uploaded before"),
        h(
          "div",
          { class: "lib" },
          S.installers.slice(0, 8).map((i) =>
            h(
              "button",
              { class: `lib-item${st.installer?.id === i.id ? " active" : ""}`, onclick: () => { pick(i); st.showLib = false; d.render(); } },
              h("span", { class: "name" }, i.file_name),
              h("span", { class: "pill blue" }, i.kind_label),
              h("span", { class: "sub" }, fmtSize(i.size)),
            ),
          ),
        ),
      );
    }
    return wrap;
  }

  function upload(file) {
    if (!/\.(exe|msi)$/i.test(file.name)) return fail(new Error("Choose an .exe or .msi file"));
    st.upload = { name: file.name, pct: 0 };
    st.showLib = false;
    d.render();
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/installers?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("X-FleetView", "1");
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      st.upload.pct = e.loaded / e.total;
      const bar = $(".upbar i", d.body);
      const txt = $(".chosen .sub", d.body);
      if (bar) bar.style.width = `${Math.round(st.upload.pct * 100)}%`;
      if (txt) txt.textContent = `uploading… ${Math.round(st.upload.pct * 100)}%`;
    };
    xhr.onload = () => {
      st.upload = null;
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status !== 200) {
        fail(new Error(data.error ?? `upload failed (${xhr.status})`));
        return d.render();
      }
      if (!S.installers.some((i) => i.id === data.item.id)) S.installers.unshift(data.item);
      pick(data.item);
      if (data.duplicate) toast("Same file as before — using the saved one");
      d.render();
    };
    xhr.onerror = () => {
      st.upload = null;
      fail(new Error("upload failed — connection lost"));
      d.render();
    };
    xhr.send(file);
  }

  function targetSeg() {
    return targetPicker(st, () => d.render());
  }

  function stepTargets() {
    return h("div", { class: "step" }, h("div", { class: "step-title" }, h("span", { class: "step-num" }, "2"), "Computers"), targetSeg());
  }

  function stepOptions() {
    const skipInput = h("input", {
      type: "text",
      placeholder: "program name as in Apps & features, e.g. MoldSign",
      value: st.skipName,
      oninput: (e) => (st.skipName = e.target.value),
    });
    skipInput.classList.toggle("hidden", !st.skip);
    return h(
      "div",
      { class: "step" },
      h("div", { class: "step-title" }, h("span", { class: "step-num" }, "3"), "Options"),
      h(
        "label",
        { class: "check" },
        h("input", { type: "checkbox", checked: st.waitOffline, onchange: (e) => { st.waitOffline = e.target.checked; d.footerRender(); } }),
        h("span", {}, "Install on offline computers when they come back", h("small", {}, "Otherwise offline computers are skipped.")),
      ),
      h(
        "label",
        { class: "check" },
        h("input", { type: "checkbox", checked: st.skip, onchange: (e) => { st.skip = e.target.checked; skipInput.classList.toggle("hidden", !st.skip); if (st.skip) skipInput.focus(); } }),
        h("span", {}, "Skip computers that already have it", h("small", {}, "Off = always install (use this to upgrade or repair). The computer's program list is refreshed first.")),
      ),
      skipInput,
    );
  }

  openDrawer(d);
}

// ---- job detail ----
function openJob(id) {
  const open = new Set();
  const closed = new Set();
  const d = {
    title: "Result",
    jobId: id,
    async render() {
      const j = S.jobs.get(id);
      if (!j) return closeDrawer();
      try {
        d.detail = (await api("GET", `/api/jobs/${id}`)).job;
      } catch {}
      d.paint();
    },
    paint() {
      const j = S.jobs.get(id);
      if (!j) return;
      const det = d.detail ?? j;
      const rows = Object.entries(j.targets).sort(([, a], [, b]) => order(a.state) - order(b.state) || a.hostname.localeCompare(b.hostname));
      const res = jobResult(j);
      // Output shown without a click when there is one PC, or for failures.
      const isOpen = (aid, t) => open.has(aid) || (!closed.has(aid) && (rows.length === 1 || t.state === "failed"));
      put(d.body,
        h("div", { class: `result-banner ${res.tone}` },
          h("span", { class: "rb-ico" }, icon({ ok: "checkCircle", bad: "alert", warn: "clock", running: "activity" }[res.tone] ?? "activity", 26)),
          h("div", { class: "grow" },
            h("div", { class: "rb-title" }, res.headline),
            res.text ? h("div", { class: "rb-text" }, res.text) : null,
            h("div", { class: "rb-meta" }, j.title, " · ", new Date(j.created_at).toLocaleString(), " · by ", j.by || "—"))),
        summaryBar(j, true),
        j.detail ? h("details", { style: { marginTop: "12px" } }, h("summary", { class: "sub" }, "What was sent"), h("pre", { class: "mono script-view" }, j.detail)) : null,
        det.script ? h("details", { style: { marginTop: "6px" } }, h("summary", { class: "sub" }, "Script that ran"), h("pre", { class: "mono script-view" }, det.script)) : null,
        h(
          "div",
          { class: "card card-pad", style: { marginTop: "14px" } },
          rows.map(([aid, t]) => {
            const out = det.targets[aid]?.output;
            const pr = h("div", { class: "progress" }, h("i", { style: { width: `${Math.round((t.progress ?? 0) * 100)}%` } }));
            return h(
              "div",
              { class: `target t-${t.state}` },
              h(
                "div",
                { class: "head" },
                h("b", { class: "grow host-link", title: "Open this computer", onclick: () => openDevice(aid) }, t.hostname),
                h("span", { class: "spacer" }),
                t.exit_code != null ? h("span", { class: "sub mono" }, `exit ${t.exit_code}`) : null,
                statePill(t.state),
              ),
              t.message ? h("div", { class: "msg" }, t.message) : null,
              t.steps ? h("ol", { class: "job-steps" }, t.steps.map((st) => h("li", { class: `st-${st.state}` }, h("span", { class: "grow" }, h("b", {}, st.label), st.message ? h("span", { class: "sub" }, ` — ${st.message}`) : null), statePill(st.state)))) : null,
              t.state === "sending" ? pr : null,
              out
                ? h("div", {},
                    h("button", { class: "btn ghost small", style: { marginTop: "6px" }, onclick: () => {
                      if (isOpen(aid, t)) { open.delete(aid); closed.add(aid); } else { closed.delete(aid); open.add(aid); }
                      d.paint();
                    } }, isOpen(aid, t) ? "Hide full output" : "Show full output"),
                    isOpen(aid, t) ? h("pre", { class: "out" }, out) : null)
                : null,
            );
          }),
        ),
      );
      const failed = (j.counts.failed ?? 0) + (j.counts.skipped ?? 0) + (j.counts.cancelled ?? 0);
      const waiting = (j.counts.queued ?? 0) + (j.counts.waiting ?? 0);
      const active = ["preparing", "sending", "installing", "running"].some((s) => j.counts[s]);
      put(d.footer, 
        failed ? h("button", { class: "btn primary", onclick: () => api("POST", `/api/jobs/${id}/retry`).then((r) => toast(`Retrying on ${plural(r.retried, "computer")}`)).catch(fail) }, `Retry ${failed} not done`) : null,
        waiting ? h("button", { class: "btn", onclick: () => api("POST", `/api/jobs/${id}/cancel`).then((r) => toast(`Cancelled on ${plural(r.cancelled, "computer")}`)).catch(fail) }, `Cancel ${waiting} waiting`) : null,
        h("span", { class: "spacer" }),
        !active && !waiting ? h("button", { class: "btn ghost danger", onclick: () => api("DELETE", `/api/jobs/${id}`).then(closeDrawer).catch(fail) }, "Delete from history") : null,
      );
    },
    live() {
      const j = S.jobs.get(id);
      if (!j) return;
      // Fetch outputs again once something finishes.
      const finished = Object.values(j.targets).filter((t) => t.finished_at).length;
      if (finished !== d.finished) {
        d.finished = finished;
        api("GET", `/api/jobs/${id}`).then((r) => { d.detail = r.job; d.paint(); }).catch(() => {});
      } else d.paint();
    },
  };
  openDrawer(d);
}
const ORDER = ["failed", "sending", "installing", "running", "preparing", "queued", "waiting", "skipped", "cancelled", "succeeded"];
const order = (s) => ORDER.indexOf(s);

function summaryBar(j, withText) {
  const c = j.counts;
  const total = Object.values(c).reduce((a, b) => a + b, 0) || 1;
  const seg = (cls, n) => (n ? h("i", { class: cls, style: { width: `${(n / total) * 100}%` } }) : null);
  const ok = c.succeeded ?? 0;
  const bad = c.failed ?? 0;
  const run = (c.sending ?? 0) + (c.installing ?? 0) + (c.running ?? 0) + (c.preparing ?? 0);
  const wait = (c.queued ?? 0) + (c.waiting ?? 0);
  const bar = h("div", { class: "bar" }, seg("s-ok", ok), seg("s-bad", bad), seg("s-run", run), seg("s-wait", wait));
  if (!withText) return bar;
  const parts = [ok && `${ok} done`, bad && `${bad} failed`, run && `${run} in progress`, wait && `${wait} waiting`, c.skipped && `${c.skipped} skipped`, c.cancelled && `${c.cancelled} cancelled`].filter(Boolean);
  return h("div", { class: "row", style: { marginTop: "14px" } }, bar, h("span", { class: "sub" }, parts.join(" · ")));
}

// ---- device ----
// The PC page: a wide panel with the computer list on the left (click, ↑/↓ or
// J/K, or ◀ ▶ in the header to move between PCs) and the PC on the right.
const NAV = { query: "" };
function navList() {
  const q = NAV.query.trim().toLowerCase();
  return filteredAgents().filter((a) => !q || [a.hostname, a.user, a.ip, ...(a.tags ?? [])].some((x) => String(x ?? "").toLowerCase().includes(q)));
}
function pcNav(currentId, onPick) {
  const list = navList();
  const search = h("input", {
    type: "search",
    class: "nav-search",
    placeholder: `Find a PC (${list.length})`,
    value: NAV.query,
    oninput: (e) => {
      NAV.query = e.target.value;
      const items = $(".pcnav-list");
      if (items) put(items, ...navItems(navList(), currentId, onPick));
    },
  });
  return h("nav", { class: "pcnav" }, search, h("div", { class: "pcnav-list" }, navItems(list, currentId, onPick)));
}
function navItems(list, currentId, onPick) {
  if (!list.length) return [h("div", { class: "sub", style: { padding: "10px" } }, "No computers match")];
  return list.map((a) =>
    h(
      "button",
      { class: `pcnav-item${a.id === currentId ? " active" : ""}`, onclick: () => onPick(a.id), title: [a.user, a.ip].filter(Boolean).join(" · ") },
      h("span", { class: `dot${a.online ? " on" : ""}` }),
      h("span", { class: "gname" }, a.hostname),
      a.cleaned ? h("span", { class: "cleaned-tick", title: `Cleaned ${ago(a.cleaned.at)}` }, "✓") : null,
    ),
  );
}

/** Start a task on PCs without leaving the page. */
async function quickTask(ids, task, options = {}) {
  try {
    const { job } = await api("POST", "/api/jobs", { kind: "task", targets: ids, wait_offline: false, payload: { task, options } });
    S.jobs.set(job.id, job);
    watchJob(job);
    notify({ title: `${job.title}: started`, text: `on ${ids.length === 1 ? S.agents.get(ids[0])?.hostname ?? "1 computer" : plural(ids.length, "computer")} — the result pops up here when it's done`, tone: "running", actionLabel: "Follow", action: () => openJob(job.id), timeout: 5000 });
    schedule();
    return job;
  } catch (e) {
    fail(e);
  }
}
async function setCleaned(ids, cleaned, note = "") {
  try {
    await api("POST", "/api/cleaned", { targets: ids, cleaned, note });
    toast(cleaned ? `Marked ${ids.length === 1 ? S.agents.get(ids[0])?.hostname : plural(ids.length, "computer")} as cleaned` : "Cleaned mark removed");
  } catch (e) {
    fail(e);
  }
}
/** The newest job on a PC whose title (or a batch step) is `label`. */
function lastRun(id, label) {
  for (const j of S.jobs.values()) {
    const t = j.targets[id];
    if (!t) continue;
    if (j.title === label) return { job: j, state: t.state, message: t.message, at: t.finished_at ?? j.created_at };
    const st = t.steps?.find((s) => s.label === label && s.state !== "queued");
    if (st) return { job: j, state: st.state, message: st.message, at: t.finished_at ?? j.created_at };
  }
  return null;
}
const RUNNING = new Set(["queued", "waiting", "preparing", "sending", "installing", "running"]);
/** Packet loss: 0 is fine, under 2 % worth watching, 2 % and up is a problem. */
const lossTone = (x) => (x == null ? "" : x >= 2 ? "bad" : x > 0 ? "warn" : "ok");
/** One line saying where the loss is: local network / Wi-Fi or the provider. */
function lossVerdict(sp) {
  const lan = sp.loss_gw ?? null;
  const wan = sp.loss ?? null;
  if (lan == null && wan == null) return null;
  if ((lan ?? 0) >= 2) return h("div", { class: "note" }, `Packets are lost already on the way to the office router (${r1(lan)}%): a cable, switch or Wi-Fi problem near this PC.`);
  if ((wan ?? 0) >= 2) return h("div", { class: "note" }, `The local network is fine but ${r1(wan)}% of packets are lost beyond the router: the internet line or provider.`);
  if ((lan ?? 0) > 0 || (wan ?? 0) > 0) return h("div", { class: "sub" }, "A little packet loss — fine for browsing, can stutter calls and remote desktop.");
  return h("div", { class: "run-status done" }, icon("checkCircle", 14), "No packet loss.");
}
const r1 = (x) => (x == null ? "—" : String(Math.round(Number(x) * 10) / 10));
function fmtPct(x) {
  return x == null ? "—" : `${Math.round(x)}%`;
}
function delta(before, after, unit = "%", lowerIsBetter = true) {
  if (before == null || after == null) return null;
  const d = Math.round((after - before) * 10) / 10;
  if (Math.abs(d) < 0.5) return h("span", { class: "delta" }, "no change");
  const good = lowerIsBetter ? d < 0 : d > 0;
  return h("span", { class: `delta ${good ? "good" : "worse"}` }, `${d > 0 ? "+" : ""}${d}${unit}`);
}

const SVG = "http://www.w3.org/2000/svg";
function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, String(v));
  for (const k of kids) if (k) el.append(k);
  return el;
}
/** CPU (blue) and memory (amber) per hour over the last days, 0–100 %. */
function sparkChart(hours, days = 7) {
  const W = 600, H = 110, now = Date.now(), from = now - days * 86400_000;
  const pts = hours.filter((p) => Date.parse(p.t) >= from);
  if (pts.length < 2) return h("div", { class: "sub spark-empty" }, "Not enough history yet — it builds up while the PC is on.");
  const x = (t) => ((Date.parse(t) - from) / (now - from)) * W;
  const y = (v) => H - 4 - (Math.max(0, Math.min(100, v)) / 100) * (H - 8);
  // Break the line where the PC was off (gap of more than 2 hours).
  const path = (key) => {
    let d = "", prev = 0;
    for (const p of pts) {
      const t = Date.parse(p.t);
      d += `${!d || t - prev > 2 * 3600_000 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`;
      prev = t;
    }
    return d;
  };
  const grid = [25, 50, 75].map((v) => svg("line", { x1: 0, x2: W, y1: y(v), y2: y(v), class: "spark-grid" }));
  const dayLines = [];
  for (let i = 1; i < days; i++) dayLines.push(svg("line", { x1: (i / days) * W, x2: (i / days) * W, y1: 0, y2: H, class: "spark-grid" }));
  return h(
    "div",
    { class: "spark-wrap" },
    svg("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", class: "spark", role: "img", "aria-label": "CPU and memory, last 7 days" }, ...grid, ...dayLines, svg("path", { d: path("mem"), class: "spark-mem" }), svg("path", { d: path("cpu"), class: "spark-cpu" })),
    h("div", { class: "spark-legend sub" }, h("span", { class: "key cpu" }), "CPU", h("span", { class: "key mem" }), "Memory", h("span", { class: "grow" }), `last ${days} days · hourly averages`),
  );
}

/** Go to a PC's page (#/pc/<id>/<tab>). */
function openDevice(id, tab = "overview") {
  closeDrawer();
  const path = `#/pc/${encodeURIComponent(id)}${tab && tab !== "overview" ? `/${tab}` : ""}`;
  if (location.hash !== path) history.pushState(null, "", path);
  S.view = "pc";
  S.pcId = id;
  S.pcTab = tab;
  renderTabs();
  renderMain(true);
  window.scrollTo(0, 0);
}

/** A PC's page, full width: the computer list on the left, the PC on the right. */
function mountDevice(mainEl, id, startTab = "overview") {
  let tab = startTab;
  let detail = null;
  let shot = null;
  let swQuery = "";
  let swReloading = false;
  let met = null; // /api/agents/:id/metrics
  let metKey = "";
  // Accounts tab: { list, at, loading, error, form }
  const acc = { list: null, at: null, loading: false, error: "", form: null };
  // Startup tab. pending: job id → { key, sid, enable } while a toggle runs.
  const su = { list: null, at: null, loading: false, error: "", showMs: false, pending: new Map() };
  su.load = async () => {
    su.loading = true;
    su.error = "";
    d.paint();
    try {
      const online = S.agents.get(id)?.online;
      const r = online ? await api("POST", `/api/agents/${id}/startup`) : await api("GET", `/api/agents/${id}/startup`);
      su.list = r.startup;
      su.at = r.at;
    } catch (e) {
      su.error = e.message;
    }
    su.loading = false;
    d.paint();
  };
  su.toggle = async (e, enable) => {
    try {
      const { job } = await api("POST", "/api/jobs", { kind: "startup", targets: [id], payload: { kind: e.kind, scope: e.scope, sid: e.sid, name: e.name, task_path: e.task_path, enable } });
      S.jobs.set(job.id, job);
      su.pending.set(job.id, { key: e.key, sid: e.sid, enable, entry: e });
      d.paint();
    } catch (ex) {
      fail(ex);
    }
  };
  /** Pick up the outcome of toggles (from the live job updates). */
  const settleToggles = () => {
    let changed = false;
    for (const [jid, p] of su.pending) {
      const t = S.jobs.get(jid)?.targets[id];
      if (!t || !["succeeded", "failed", "skipped", "cancelled"].includes(t.state)) continue;
      su.pending.delete(jid);
      changed = true;
      if (t.state === "succeeded") {
        p.entry.enabled = p.enable;
        toast(`${p.enable ? "Enabled" : "Disabled"} ${p.entry.name}`);
      } else toast(`${p.entry.name}: ${t.message || t.state}`, true);
    }
    return changed;
  };
  async function loadAccounts() {
    acc.loading = true;
    acc.error = "";
    d.paint();
    try {
      const r = await api("POST", `/api/agents/${id}/accounts`);
      acc.list = r.accounts;
      acc.at = r.at;
    } catch (e) {
      acc.error = e.message;
    }
    acc.loading = false;
    d.paint();
  }
  async function loadMetrics() {
    try {
      met = await api("GET", `/api/agents/${id}/metrics`);
    } catch {
      met = null;
    }
    if (tab === "overview") d.paint();
  }
  /** Refetch the history when something that feeds it changed. */
  function metricsKey(a) {
    const finished = [...S.jobs.values()].filter((j) => j.targets[id]?.finished_at).length;
    return [a.speed?.at, a.cleaned?.at, finished].join("|");
  }
  function accountsTab(a) {
    if (acc.form) {
      const st = acc.form;
      return [
        accountForm(st, () => d.paint()),
        h(
          "div",
          { class: "actions" },
          h("button", { class: "btn primary", onclick: () => submitAccount(st, [id], false).catch(fail) }, "Apply"),
          h("button", { class: "btn ghost", onclick: () => { acc.form = null; d.paint(); } }, "Back"),
        ),
      ];
    }
    const head = h(
      "div",
      { class: "row", style: { marginBottom: "8px" } },
      h("span", { class: "sub grow" }, acc.loading ? "Asking the PC…" : acc.at ? `Read ${ago(acc.at)}` : ""),
      h("button", { class: "btn small", disabled: !a.online || acc.loading, onclick: loadAccounts }, "Reload"),
      h("button", { class: "btn small primary", disabled: !a.online, onclick: () => { acc.form = newAccountState("create"); acc.form.fixedUser = false; d.paint(); } }, "New account"),
    );
    if (!a.online && !acc.list) return [head, h("div", { class: "empty" }, "The PC is offline. Use Accounts in the selection bar to queue a change for when it's back.")];
    if (acc.error) return [head, h("div", { class: "note" }, acc.error)];
    if (!acc.list) return [head];
    const act = (u, action) => () => { acc.form = newAccountState(action, u.name); d.paint(); };
    // People's accounts first, then what Windows creates by itself.
    const isDefault = (u) => !!(u.default_kind ?? (u.builtin ? "builtin" : null));
    const people = acc.list.filter((u) => !isDefault(u));
    const defaults = acc.list.filter(isDefault);
    const row = (u) => {
      const kind = u.default_kind ?? (u.builtin ? "builtin" : null);
      return h(
        "div",
        { class: `sw${kind ? " is-default" : ""}` },
        h(
          "div",
          { class: "grow" },
          h("b", {}, u.name),
          " ",
          kind === "builtin"
            ? h("span", { class: "pill", title: "Created by Windows itself (well-known account)" }, "Windows default")
            : kind === "setup"
              ? h("span", { class: "pill warn", title: "Left over from Windows setup; usually safe to delete" }, "Setup leftover")
              : h("span", { class: "pill blue", title: "Created by a person or a program after Windows was installed" }, "Added"),
          " ",
          u.admin ? h("span", { class: "pill blue" }, "Administrator") : null,
          " ",
          !u.enabled ? h("span", { class: "pill" }, "Disabled") : null,
          h("div", { class: "sub" }, [u.full_name || u.description, u.last_logon ? `last sign-in ${ago(u.last_logon)}` : "never signed in", u.password_last_set ? `password set ${ago(u.password_last_set)}` : null].filter(Boolean).join(" · ")),
        ),
        h("button", { class: "btn small", onclick: act(u, "set_password") }, "Password"),
        h("button", { class: "btn small", onclick: act(u, "rename") }, "Rename"),
        h("button", { class: "btn small", onclick: act(u, u.enabled ? "disable" : "enable") }, u.enabled ? "Disable" : "Enable"),
        h("button", { class: "btn small", onclick: act(u, u.admin ? "remove_admin" : "add_admin") }, u.admin ? "Not admin" : "Make admin"),
        kind === "builtin" ? null : h("button", { class: "btn small ghost danger", onclick: act(u, "delete") }, "Delete"),
      );
    };
    return [
      head,
      h("div", { class: "acc-head" }, `People and programs (${people.length})`),
      people.length ? people.map(row) : h("div", { class: "sub" }, "Only Windows' own accounts on this PC."),
      h("div", { class: "acc-head" }, `Windows defaults (${defaults.length})`),
      defaults.map(row),
    ];
  }

  function overview(a) {
    const t = detail?.telemetry;
    const disks = t?.disks?.map((x) => `${x.mount} ${Math.round(x.total_gb - x.available_gb)}/${Math.round(x.total_gb)} GB`).join(", ");
    const kv = (k, v) => [h("span", {}, k), h("b", {}, v ?? "—")];
    const card = (title, tools, ...body) => h("section", { class: "card pc-card" }, h("div", { class: "pc-card-head" }, h("h3", {}, title), h("span", { class: "spacer" }), ...[tools].flat()), ...body);

    const status = card(
      "This PC",
      null,
      h(
        "div",
        { class: "kv" },
        kv("Status", a.online ? "Online" : `Offline — seen ${ago(a.last_seen)}`),
        a.pending_name ? kv("Rename", `to ${a.pending_name} — pending restart`) : null,
        kv("User", a.user),
        kv("Windows", a.os),
        kv("IP address", a.ip),
        kv("CPU", t ? `${t.cpu_name} · ${t.cpu_cores} cores` : null),
        kv("Memory", t ? `${Math.round(t.mem_total_mb / 1024)} GB` : null),
        kv("Disks", disks),
        kv("Uptime", uptime(a.uptime_secs)),
        kv("Agent", a.agent_version + (a.outdated ? " (update available)" : "")),
        kv("MoldSign bridge", emgText(a.emanagement)),
        kv("MAC", detail?.macs?.join(", ")),
      ),
      a.tags?.length ? h("div", { class: "pcs-chips", style: { marginTop: "10px" } }, a.tags.map((x) => h("span", { class: "pill" }, x))) : null,
    );

    // ---- performance ----
    const snap = met?.snaps?.at(-1);
    const snapRun = lastRun(id, "Performance snapshot");
    const perf = card(
      "Performance",
      h("button", { class: "btn small", disabled: !a.online || (snapRun && RUNNING.has(snapRun.state)), onclick: () => quickTask([id], "perf_snapshot") }, snapRun && RUNNING.has(snapRun.state) ? "Measuring… (30 s)" : "Take snapshot"),
      h(
        "div",
        { class: "big-stats" },
        h("div", {}, h("span", {}, "CPU now"), h("b", {}, a.online ? fmtPct(a.cpu) : "—"), meter(a.online ? a.cpu : null)),
        h("div", {}, h("span", {}, "Memory now"), h("b", {}, fmtPct(a.mem)), meter(a.mem)),
        h("div", {}, h("span", {}, "CPU · 7-day avg"), h("b", {}, fmtPct(met?.week?.cpu))),
        h("div", {}, h("span", {}, "Memory · 7-day avg"), h("b", {}, fmtPct(met?.week?.mem))),
      ),
      met ? sparkChart(met.hours ?? []) : h("div", { class: "sub" }, "Loading history…"),
      snap
        ? h(
            "div",
            { class: "snap" },
            h("div", { class: "sub" }, `Snapshot ${ago(snap.at)}: CPU ${fmtPct(snap.cpu_avg)} over 30 s · ${snap.processes ?? "?"} processes · commit ${snap.commit_mb ? `${(snap.commit_mb / 1024).toFixed(1)} GB` : "?"}${snap.boot_ms ? ` · boot ${Math.round(snap.boot_ms / 1000)} s` : ""}`),
            snap.top?.length ? h("div", { class: "sub" }, "Most memory: ", snap.top.map((p) => `${p.name} ${p.mb} MB`).join(", ")) : null,
          )
        : null,
    );

    // ---- cleaning ----
    const c = met?.compare;
    const cmpRow = (label, b, aft, unit, fmt = (x) => `${x}${unit}`) =>
      h("tr", {}, h("td", {}, label), h("td", {}, b == null ? "—" : fmt(b)), h("td", {}, aft == null ? "—" : fmt(aft)), h("td", {}, delta(b, aft, unit) ?? ""));
    const cleaning = card(
      "Cleaning",
      a.cleaned
        ? [h("button", { class: "btn small", onclick: () => setCleaned([id], true) }, "Cleaned again today"), h("button", { class: "btn small ghost", onclick: () => confirm(`Remove the cleaned mark from ${a.hostname}?`) && setCleaned([id], false) }, "Clear mark")]
        : h("button", { class: "btn small primary", onclick: () => setCleaned([id], true) }, "Mark as cleaned"),
      a.cleaned
        ? h("div", {}, h("span", { class: "pill ok" }, "✓ Cleaned"), " ", h("span", { class: "sub" }, `${new Date(a.cleaned.at).toLocaleDateString()} (${ago(a.cleaned.at)}) by ${a.cleaned.by || "—"}${a.cleaned.note ? ` — ${a.cleaned.note}` : ""}`))
        : h("div", {}, h("span", { class: "pill warn" }, "Not cleaned yet"), " ", h("span", { class: "sub" }, "Marked by itself when the checklist below is complete.")),
      cleanChecklist(a),
      c
        ? h(
            "table",
            { class: "cmp" },
            h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, "7 days before"), h("th", {}, "since"), h("th", {}, ""))),
            h(
              "tbody",
              {},
              cmpRow("CPU (avg)", c.before?.cpu, c.after?.cpu, "%"),
              cmpRow("Memory (avg)", c.before?.mem, c.after?.mem, "%"),
              c.snap_before || c.snap_after ? cmpRow("Boot time", c.snap_before?.boot_ms != null ? Math.round(c.snap_before.boot_ms / 1000) : null, c.snap_after?.boot_ms != null ? Math.round(c.snap_after.boot_ms / 1000) : null, " s") : null,
              c.snap_before || c.snap_after ? cmpRow("Processes", c.snap_before?.processes, c.snap_after?.processes, "") : null,
            ),
          )
        : null,
      c && !c.after ? h("div", { class: "sub" }, "The “since” column fills in as the PC runs after the mark.") : null,
      c && c.after && !c.snap_after ? h("div", { class: "sub" }, "Take a snapshot after a restart for the boot time and process count.") : null,
    );

    // ---- internet ----
    const speeds = (met?.speed ?? []).filter((s) => s.down != null);
    const sp = a.speed?.down != null ? a.speed : speeds.at(-1);
    const spRun = lastRun(id, "Internet speed test");
    const maxDown = Math.max(1, ...speeds.map((s) => s.down));
    const internet = card(
      "Internet",
      h("button", { class: "btn small", disabled: !a.online || (spRun && RUNNING.has(spRun.state)), onclick: () => quickTask([id], "speed_test") }, spRun && RUNNING.has(spRun.state) ? "Testing… (~30 s)" : "Test now"),
      sp
        ? h(
            "div",
            { class: "big-stats" },
            h("div", {}, h("span", {}, "Download"), h("b", {}, `${r1(sp.down)} Mbps`)),
            h("div", {}, h("span", {}, "Upload"), h("b", {}, `${r1(sp.up)} Mbps`)),
            h("div", {}, h("span", {}, "Latency"), h("b", {}, `${r1(sp.ping)} ms`)),
          )
        : h("div", { class: "sub" }, a.speed?.error ? `Last test failed: ${a.speed.error}` : "No speed test yet."),
      sp && (sp.loss != null || sp.loss_gw != null)
        ? h(
            "div",
            { class: "big-stats" },
            h("div", { class: `loss ${lossTone(sp.loss)}`, title: "Pings to 1.1.1.1 before the speed test" }, h("span", {}, "Packet loss · internet"), h("b", {}, sp.loss != null ? `${r1(sp.loss)}%` : "—"), h("span", { class: "sub" }, sp.icmp != null ? `${r1(sp.icmp)} ms, jitter ${r1(sp.icmp_jitter)} ms` : "no ping reply")),
            h("div", { class: `loss ${lossTone(sp.loss_gw)}`, title: "Pings to the office router: loss here means the local network or Wi-Fi" }, h("span", {}, "Packet loss · router"), h("b", {}, sp.loss_gw != null ? `${r1(sp.loss_gw)}%` : "—"), h("span", { class: "sub" }, sp.gw_ms != null ? `${r1(sp.gw_ms)} ms` : "router doesn't answer pings")),
          )
        : null,
      sp ? lossVerdict(sp) : null,
      sp ? h("div", { class: "sub" }, `${ago(sp.at)}${sp.isp ? ` · ${sp.isp}` : ""}${sp.colo ? ` · via ${sp.colo}` : ""}${sp.scheduled ? " · scheduled" : ""}`) : null,
      speeds.length > 1
        ? h("div", { class: "speed-bars", title: "Download speed, oldest to newest (red: packet loss)" }, speeds.slice(-30).map((s) => h("i", { class: (s.loss ?? 0) >= 2 || (s.loss_gw ?? 0) >= 2 ? "lossy" : "", title: `${new Date(s.at).toLocaleString()}: ↓ ${r1(s.down)} ↑ ${r1(s.up)} Mbps, ${r1(s.ping)} ms${s.loss != null ? `, loss ${r1(s.loss)}%` : ""}${s.loss_gw != null ? ` (router ${r1(s.loss_gw)}%)` : ""}`, style: { height: `${Math.max(4, (s.down / maxDown) * 100)}%` } })))
        : null,
    );

    // ---- security ----
    const sec = lastRun(id, "Security check");
    const base = lastRun(id, "Security baseline (turn on all protection)");
    const adb = lastRun(id, "Install adblocker in all browsers");
    const line = (label, r) =>
      h("div", { class: "sec-line" }, h("span", { class: "grow" }, label), r ? [statePill(r.state), h("span", { class: "sub" }, ` ${ago(r.at)}`)] : h("span", { class: "sub" }, "never run"));
    const security = card(
      "Security",
      [
        h("button", { class: "btn small", disabled: !a.online, onclick: () => quickTask([id], "security_status") }, "Check"),
        h("button", { class: "btn small", onclick: () => openTasks({ ids: [id], task: "security_baseline" }) }, "Apply baseline…"),
      ],
      line("Security check", sec),
      sec?.message ? h("div", { class: `sub sec-msg${sec.state === "failed" ? " bad" : ""}` }, sec.message) : null,
      line("Baseline applied", base),
      line("Adblocker", adb),
      sec ? h("button", { class: "btn ghost small", onclick: () => openJob(sec.job.id) }, "Details") : null,
    );

    // ---- recent ----
    const js = [...S.jobs.values()].filter((j) => j.targets[id]).slice(0, 6);
    const recent = card(
      "Recent actions",
      h("button", { class: "btn small ghost", onclick: () => { tab = "history"; d.paint(); } }, "All"),
      js.length
        ? js.map((j) => h("div", { class: "mini-job", onclick: () => openJob(j.id) }, h("div", { class: "grow" }, h("div", { class: "title" }, j.title), h("div", { class: "sub" }, `${ago(j.created_at)} · ${j.targets[id].message || ""}`)), statePill(j.targets[id].state)))
        : h("div", { class: "sub" }, "Nothing done on this computer yet."),
    );

    return [
      h("div", { class: "pc-grid" }, status, perf, cleaning, internet, security, recent),
      shot ? h("img", { class: "shot", src: shot, alt: "screenshot" }) : null,
      !a.online ? h("div", { style: { marginTop: "16px" } }, h("button", { class: "btn danger", onclick: () => confirm(`Remove ${a.hostname} from the list? It reappears if its agent connects again.`) && api("DELETE", `/api/agents/${id}`).then(() => go("computers")).catch(fail) }, "Remove from list")) : null,
    ];
  }

  const go2 = (nid) => {
    if (nid && nid !== id) openDevice(nid, tab);
  };
  /** How a task last went on this PC: green done, amber "found something", red failed. */
  const runState = (label, failMeaning = null) => {
    // The result kept with the PC (survives the Activity history being trimmed);
    // the history only for something still running or newer.
    const live = lastRun(id, label);
    const tid = S.tasks.find((t) => t.label === label)?.id;
    const kept = tid ? S.agents.get(id)?.task_runs?.[tid] : null;
    let r = live;
    if (kept && !(live && RUNNING.has(live.state)) && (!live || String(kept.at) >= String(live.at))) r = { state: kept.state, at: kept.at, message: kept.message, job: live?.job ?? null };
    if (!r) return { r: null, cls: "", text: "Never run on this PC", ic: null };
    if (RUNNING.has(r.state)) return { r, cls: "running", text: `${STATE_LABEL[r.state]?.[0] ?? r.state}…`, ic: "clock" };
    if (r.state === "succeeded") return { r, cls: "done", text: `Done ${ago(r.at)}`, ic: "checkCircle" };
    if (r.state === "failed") return { r, cls: failMeaning ? "warn" : "bad", text: `${failMeaning ? "Needs attention" : "Failed"} ${ago(r.at)}`, ic: "alert" };
    return { r, cls: "", text: `${STATE_LABEL[r.state]?.[0] ?? r.state} ${ago(r.at)}`, ic: null };
  };
  const statusLine = (label, failMeaning = null) => {
    const s = runState(label, failMeaning);
    return h("span", { class: `run-status ${s.cls}` }, s.ic ? icon(s.ic, 14) : null, h("span", {}, s.text, s.r?.message ? h("span", { class: "run-msg" }, ` — ${s.r.message}`) : null));
  };
  const taskFail = (taskId) => S.tasks.find((t) => t.id === taskId)?.fail_meaning ?? null;
  const showTab = (k) => {
    tab = k;
    S.pcTab = k;
    history.replaceState(null, "", `#/pc/${encodeURIComponent(id)}${k === "overview" ? "" : `/${k}`}`);
    if (k === "accounts" && !acc.list && !acc.loading) loadAccounts();
    if (k === "startup" && !su.list && !su.loading) su.load();
    d.paint();
    window.scrollTo(0, 0);
  };
  /** Every maintenance task for this PC, with how it last went here. */
  function maintenanceTab(a) {
    const offline = !a.online;
    const groups = [...new Set(S.tasks.map((t) => t.group))];
    const row = (t) => {
      const s = runState(t.label, t.fail_meaning);
      const running = s.cls === "running";
      // Tasks with options (baseline, restart…) open the form; the rest run at once.
      const withForm = !!t.options;
      return h(
        "div",
        { class: `set-row mt-row ${s.cls}` },
        h("span", { class: `mt-mark ${s.cls}` }, icon(s.cls === "done" ? "check" : s.cls === "running" ? "clock" : s.cls ? "alert" : "wrench", 15)),
        h("div", { class: "grow" },
          h("b", {}, t.label),
          h("div", {}, statusLine(t.label, t.fail_meaning)),
          h("div", { class: "sub mt-help", title: t.help }, t.help)),
        h("div", { class: "set-btns" },
          s.r?.job ? h("button", { class: "btn small ghost", onclick: () => openJob(s.r.job.id) }, "Details") : null,
          h("button", {
            class: `btn small${!s.r && !withForm ? " primary" : ""}`,
            disabled: running || (offline && !withForm),
            title: offline && !withForm ? "The PC is offline" : "",
            onclick: () => (withForm ? openTasks({ ids: [id], task: t.id }) : quickTask([id], t.id)),
          }, running ? "Running…" : withForm ? "Run…" : s.r ? "Run again" : "Run")),
      );
    };
    const done = S.tasks.filter((t) => runState(t.label, t.fail_meaning).cls === "done").length;
    return [
      h("section", { class: "card set-card ck-card" }, h("div", { class: "set-head" }, h("h3", {}, "Clean checklist"), h("p", { class: "sub" }, "When all of these hold, the PC is marked cleaned by itself.")), cleanChecklist(a)),
      h("div", { class: "mt-summary" },
        h("span", { class: "run-status done" }, icon("checkCircle", 15), `${done} of ${S.tasks.length} done on this PC`),
        h("span", { class: "spacer" }),
        h("button", { class: "btn small", onclick: () => openApply([id]) }, icon("layers", 14), "Run several in order…")),
      offline ? h("div", { class: "note" }, "This PC is offline: tasks can't start now. Use Apply changes to queue them for when it connects.") : null,
      h("div", { class: "set-grid" }, groups.map((g) => h("section", { class: "card set-card" }, h("div", { class: "set-head" }, h("h3", {}, g)), S.tasks.filter((t) => t.group === g).map(row)))),
    ];
  }
  /** Everything that can be set or done for this one PC, in one place. */
  function settingsTab(a) {
    const section = (title, desc, ...body) =>
      h("section", { class: "card set-card" }, h("div", { class: "set-head" }, h("h3", {}, title), desc ? h("p", { class: "sub" }, desc) : null), ...body);
    const row = (label, value, ...btns) =>
      h("div", { class: "set-row" }, h("div", { class: "grow" }, h("b", {}, label), value ? h("div", { class: "sub" }, value) : null), h("div", { class: "set-btns" }, ...btns));
    const btn = (label, fn, opts = {}) => h("button", { class: `btn small${opts.primary ? " primary" : ""}${opts.danger ? " danger" : ""}`, disabled: !!opts.disabled, title: opts.title ?? "", onclick: fn }, opts.icon ? icon(opts.icon, 14) : null, label);
    const saveTags = (tags) => {
      const list = [...new Set(tags)];
      return api("PATCH", `/api/agents/${id}`, { tags: list })
        .then(() => {
          const cur = S.agents.get(id);
          if (cur) cur.tags = list;
          d.paint();
          $(".pc-page .tag-input")?.focus();
        })
        .catch(fail);
    };
    const tagInput = h("input", {
      type: "text",
      class: "tag-input",
      placeholder: "Add a tag, press Enter",
      onkeydown: (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const add = e.target.value.split(",").map((x) => x.trim()).filter(Boolean);
        if (add.length) saveTags([...(a.tags ?? []), ...add]);
      },
    });
    const notes = h("textarea", { class: "notes-input", rows: 3, placeholder: "Anything worth knowing: where it is, who uses it, warranty, quirks…", value: a.notes ?? "" });
    const offline = !a.online;
    const offTip = offline ? "The PC is offline" : "";
    return h(
      "div",
      { class: "set-grid" },
      section(
        "General",
        "Name, tags and notes for this computer.",
        row("Computer name", a.pending_name ? `${a.hostname} → ${a.pending_name} after a restart` : a.hostname, btn("Rename…", () => openRename([id]), { icon: "edit" })),
        h("div", { class: "set-row col" },
          h("b", {}, "Tags"),
          h("div", { class: "sub" }, "Group PCs (office, department…) to filter and select them together."),
          h("div", { class: "tag-edit" }, (a.tags ?? []).map((t) => h("span", { class: "tag removable" }, t, h("button", { title: `Remove ${t}`, onclick: () => saveTags(a.tags.filter((x) => x !== t)) }, icon("x", 12)))), tagInput)),
        h("div", { class: "set-row col" },
          h("b", {}, "Notes"),
          notes,
          h("div", {}, btn("Save notes", () => api("PATCH", `/api/agents/${id}`, { notes: notes.value }).then(() => toast("Notes saved")).catch(fail)))),
      ),
      section(
        "Maintenance",
        "The state of this PC and the usual fixes.",
        row("Cleaned", a.cleaned ? `${new Date(a.cleaned.at).toLocaleString()} by ${a.cleaned.by || "—"}${a.cleaned.note ? ` — ${a.cleaned.note}` : ""}` : "Not marked as cleaned yet",
          a.cleaned ? btn("Clear mark", () => confirm(`Remove the cleaned mark from ${a.hostname}?`) && setCleaned([id], false)) : null,
          btn(a.cleaned ? "Mark again" : "Mark as cleaned", () => { const note = prompt("Note (optional), e.g. removed bloat, new SSD", ""); if (note !== null) setCleaned([id], true, note); }, { primary: !a.cleaned, icon: "sparkles" })),
        row("Security", h("span", { class: "status-stack" }, h("span", {}, "Baseline: ", statusLine("Security baseline (turn on all protection)")), h("span", {}, "Check: ", statusLine("Security check", taskFail("security_status")))),
          btn("Check", () => quickTask([id], "security_status"), { disabled: offline, title: offTip }),
          btn("Apply…", () => openTasks({ ids: [id], task: "security_baseline" }), { icon: "shield" })),
        row("Adblocker", statusLine("Install adblocker in all browsers"),
          btn("Install", () => quickTask([id], "adblock"), { disabled: offline, title: offTip }),
          btn("Remove", () => quickTask([id], "adblock_remove"), { disabled: offline, title: offTip })),
        row("Windows Update", h("span", { class: "status-stack" }, h("span", {}, "Check: ", statusLine("Check for Windows updates", taskFail("check_updates"))), h("span", {}, "Install: ", statusLine("Install Windows updates"))),
          btn("Check", () => quickTask([id], "check_updates"), { disabled: offline, title: offTip }),
          btn("Install", () => quickTask([id], "install_updates"), { disabled: offline, title: offTip }),
          btn("Repair", () => quickTask([id], "repair_updates"), { disabled: offline, title: offTip })),
        row("Clean-up", statusLine("Clean up temporary files"),
          btn("Temp files", () => quickTask([id], "cleanup"), { disabled: offline, title: offTip }),
          btn("Startup apps", () => { tab = "startup"; history.replaceState(null, "", `#/pc/${encodeURIComponent(id)}/startup`); if (!su.list && !su.loading) su.load(); d.paint(); })),
        row("Performance", "A 30-second snapshot and an internet speed test",
          btn("Snapshot", () => quickTask([id], "perf_snapshot"), { disabled: offline, title: offTip }),
          btn("Speed test", () => quickTask([id], "speed_test"), { disabled: offline, title: offTip })),
        row("All maintenance tasks", "sfc, DISM, Defender scan, disk health, group policy, DNS…", btn("Open", () => showTab("maintenance"), { icon: "wrench" })),
      ),
      section(
        "Remote",
        "Reach the PC and its user.",
        row("Screenshot", "The signed-in user is notified", btn("Take", takeShot, { disabled: offline, title: offTip, icon: "camera" })),
        row("Message", "Show a message on the user's screen", btn("Send…", () => openMessage([id]), { icon: "message" })),
        row("PowerShell", "Run a command as SYSTEM", btn("Open…", () => openScript([id]), { icon: "terminal" })),
        row("Saved script", "Run one of the scripts from the Scripts page", btn("Run…", () => openRunScript({ ids: [id] }), { icon: "play" })),
        row("Install software", "Push an .exe or .msi silently", btn("Install…", () => openInstall({ ids: [id] }), { icon: "download" })),
        row("Local accounts", "Users, passwords, administrators", btn("Open", () => { tab = "accounts"; history.replaceState(null, "", `#/pc/${encodeURIComponent(id)}/accounts`); if (!acc.list && !acc.loading) loadAccounts(); d.paint(); }, { icon: "users" })),
      ),
      section(
        "Power",
        "The signed-in user gets a warning first.",
        row("Restart", "With a warning and a delay you choose", btn("Restart…", () => openTasks({ ids: [id], task: "restart" }), { icon: "refresh" })),
        row("Shut down", "With a warning and a delay you choose", btn("Shut down…", () => openTasks({ ids: [id], task: "shutdown" }), { icon: "power" })),
        row("Cancel", "Cancel a restart or shutdown that is counting down", btn("Cancel", () => quickTask([id], "cancel_power"), { disabled: offline, title: offTip })),
      ),
      section(
        "Agent",
        "The FleetView agent on this PC.",
        row("Version", `${a.agent_version || "—"}${a.outdated ? " — an update is available" : " — up to date"}`, a.outdated ? btn("Update agent", () => createJob({ kind: "update", targets: [id], wait_offline: true, payload: {} }), { primary: true }) : null),
        row("MoldSign bridge", emgText(a.emanagement)),
        row("Agent settings", "Master address, e-Management URL, report interval", btn("Edit…", () => openAgentSettings([id]), { icon: "settings" })),
        row("Refresh data", "Ask the PC for fresh hardware and program lists now", btn("Refresh", () => api("POST", `/api/agents/${id}/refresh`).then(() => { toast("Asked the PC for fresh data"); setTimeout(() => d.render(), 1500); }).catch(fail), { disabled: offline, title: offTip, icon: "refresh" })),
        row("Identity", `id ${id} · first seen ${a.first_seen ? new Date(a.first_seen).toLocaleDateString() : "—"} · last seen ${a.online ? "now" : ago(a.last_seen)}`),
      ),
      section(
        "Danger zone",
        null,
        row("Remove from the list", a.online ? "Only offline PCs can be removed (it comes back if its agent connects)." : "It comes back if its agent connects again.",
          btn("Remove", () => confirm(`Remove ${a.hostname} from the list? It reappears if its agent connects again.`) && api("DELETE", `/api/agents/${id}`).then(() => go("computers")).catch(fail), { danger: true, disabled: a.online, icon: "trash" })),
      ),
    );
  }
  const step = (dir) => {
    const list = navList();
    const i = list.findIndex((x) => x.id === id);
    const n = list[(i < 0 ? 0 : i + dir + list.length) % list.length];
    if (n) go2(n.id);
  };
  const d = {
    id,
    onKey(e) {
      if (e.key === "ArrowDown" || e.key === "j") step(1);
      else if (e.key === "ArrowUp" || e.key === "k") step(-1);
      else return false;
      return true;
    },
    async render() {
      d.paint();
      $(".pcnav-item.active")?.scrollIntoView({ block: "nearest" });
      if (tab === "startup" && !su.list && !su.loading) su.load();
      if (tab === "accounts" && !acc.list && !acc.loading) loadAccounts();
      metKey = metricsKey(S.agents.get(id) ?? {});
      loadMetrics();
      try {
        detail = await api("GET", `/api/agents/${id}`);
      } catch (e) {
        return fail(e);
      }
      d.paint();
    },
    paint() {
      const a = S.agents.get(id);
      if (!a) return go("computers");
      const titles = { overview: "Overview", maintenance: "Maintenance", software: `Programs (${detail?.software?.length ?? a.software_count})`, startup: "Startup apps", accounts: "Accounts", history: "History", settings: "Settings" };
      const tabIcons = { overview: "home", maintenance: "wrench", software: "package", startup: "zap", accounts: "users", history: "activity", settings: "settings" };
      const sub = h("div", { class: "subtabs pc-tabs" }, Object.keys(titles).map((k) => h("button", { class: tab === k ? "active" : "", onclick: () => {
        tab = k;
        S.pcTab = k;
        history.replaceState(null, "", `#/pc/${encodeURIComponent(id)}${k === "overview" ? "" : `/${k}`}`);
        if (k === "accounts" && !acc.list && !acc.loading) loadAccounts();
        if (k === "startup" && !su.list && !su.loading) su.load();
        d.paint();
      } }, icon(tabIcons[k], 15), titles[k])));
      const menuItem = (ic, label, fn, disabled = false) => h("button", { class: "menu-item", disabled, onclick: (e) => { e.target.closest("details").open = false; fn(); } }, icon(ic, 16), label);
      const actions = h(
        "div",
        { class: "pc-hero" },
        h("span", { class: "pc-ico lg" }, icon("monitor", 22)),
        h(
          "div",
          { class: "grow pc-hero-text" },
          h("h2", {}, a.hostname, a.cleaned ? h("span", { class: "badge ok", title: `Cleaned ${new Date(a.cleaned.at).toLocaleString()}` }, icon("sparkles", 12), "Cleaned") : null),
          h("div", { class: "pc-hero-meta" },
            h("span", { class: `status ${a.online ? "on" : "off"}` }, h("span", { class: "sdot" }), a.online ? "Online" : `Offline · ${ago(a.last_seen)}`),
            a.user ? h("span", {}, icon("user", 14, "dim"), a.user.split("\\").pop()) : null,
            a.ip ? h("span", {}, icon("globe", 14, "dim"), a.ip) : null,
            a.os ? h("span", { class: "hide-sm" }, icon("monitor", 14, "dim"), a.os.replace(/^Microsoft /, "")) : null),
        ),
        h(
          "div",
          { class: "pc-hero-actions" },
          h("div", { class: "pc-step" },
            h("button", { class: "icon-btn", title: "Previous computer (↑ or K)", onclick: () => step(-1) }, icon("chevronLeft", 18)),
            h("button", { class: "icon-btn", title: "Next computer (↓ or J)", onclick: () => step(1) }, icon("chevronRight", 18))),
          h("button", { class: "btn primary", onclick: () => openApply([id]) }, icon("layers", 16), "Apply changes"),
          h("button", { class: "btn", onclick: () => openInstall({ ids: [id] }) }, icon("download", 16), "Install"),
          h("button", { class: `btn${tab === "maintenance" ? " active-btn" : ""}`, onclick: () => showTab("maintenance") }, icon("wrench", 16), "Maintenance"),
          h("details", { class: "menu" },
            h("summary", { class: "btn" }, icon("more", 16), "More"),
            h("div", { class: "card menu-list" },
              menuItem("terminal", "Run saved script", () => openRunScript({ ids: [id] })),
              menuItem("terminal", "PowerShell", () => openScript([id])),
              menuItem("edit", "Rename PC", () => openRename([id])),
              menuItem("camera", "Screenshot", takeShot, !a.online),
              menuItem("message", "Message the user", () => openMessage([id])),
              menuItem("settings", "Agent settings", () => openAgentSettings([id])),
              menuItem("refresh", "Refresh data", () => api("POST", `/api/agents/${id}/refresh`).then(() => setTimeout(() => d.render(), 1500)).catch(fail), !a.online),
              menuItem("settings", "All settings for this PC", () => { tab = "settings"; history.replaceState(null, "", `#/pc/${encodeURIComponent(id)}/settings`); d.paint(); }))),
        ),
      );
      let content;
      if (tab === "overview") {
        content = overview(a);
      } else if (tab === "settings") {
        content = settingsTab(a);
      } else if (tab === "maintenance") {
        content = maintenanceTab(a);
      } else if (tab === "accounts") {
        content = accountsTab(a);
      } else if (tab === "startup") {
        content = startupTab(a, su, () => d.paint());
      } else if (tab === "software") {
        const list = (detail?.software ?? []).filter((s) => !swQuery || s.name.toLowerCase().includes(swQuery.toLowerCase())).sort((x, y) => x.name.localeCompare(y.name));
        content = [
          h("input", { type: "search", class: "sw-search", placeholder: "Search programs…", value: swQuery, oninput: (e) => { swQuery = e.target.value; const pos = e.target.selectionStart; d.paint(); const i = $(".pc-page .sw-search"); i?.focus(); i?.setSelectionRange(pos, pos); } }),
          h("div", { class: "row", style: { margin: "8px 0" } },
            h("span", { class: "sub grow" }, swReloading ? "Asking the PC for its programs…" : detail?.software_at ? `List from ${ago(detail.software_at)} · ${plural(list.length, "program")}` : ""),
            h("button", { class: "btn small", disabled: !a.online || swReloading, title: a.online ? "Read the installed programs from the PC again" : "The PC is offline", onclick: reloadPrograms }, icon("refresh", 14), swReloading ? "Reloading…" : "Reload")),
          list.map((s) =>
            h(
              "div",
              { class: "sw" },
              h("div", { class: "grow" }, h("b", {}, s.name), h("div", { class: "sub" }, [s.version, s.publisher].filter(Boolean).join(" · "))),
              s.uninstall_string
                ? h("button", { class: "btn small danger", onclick: () => confirm(`Uninstall ${s.name} from ${a.hostname}?`) && createJob({ kind: "uninstall", targets: [id], payload: { name: s.name } }) }, "Uninstall")
                : null,
            ),
          ),
        ];
      } else {
        const js = [...S.jobs.values()].filter((j) => j.targets[id]).slice(0, 50);
        content = js.length
          ? h("div", { class: "card" }, js.map((j) => h("div", { class: "job", onclick: () => openJob(j.id) }, h("div", { class: "grow" }, h("div", { class: "title" }, j.title), h("div", { class: "sub" }, `${ago(j.created_at)} · ${j.targets[id].message || ""}`)), statePill(j.targets[id].state))))
          : h("div", { class: "empty" }, "Nothing done on this computer yet.");
      }
      if (S.page !== d) return; // left this PC meanwhile
      const navScroll = $(".pcnav-list")?.scrollTop ?? null;
      const navFocus = document.activeElement?.classList.contains("nav-search");
      const y = window.scrollY;
      const main = h("div", { class: "pc-main" }, actions, sub, h("div", { class: `pc-tab-body tab-${tab}` }, ...[content].flat()));
      const nav = pcNav(id, go2);
      nav.append(h("div", { class: "pcnav-foot sub" }, h("kbd", {}, "↑"), h("kbd", {}, "↓"), " switch computers"));
      put(d.body, h("div", { class: "pc-layout" }, nav, main));
      window.scrollTo(0, y);
      if (navScroll !== null) $(".pcnav-list").scrollTop = navScroll;
      if (navFocus) {
        const i = $(".nav-search");
        i?.focus();
        i?.setSelectionRange(i.value.length, i.value.length);
      }
    },
    live() {
      const a = S.agents.get(id);
      if (a) {
        const k = metricsKey(a);
        if (k !== metKey) {
          metKey = k;
          loadMetrics();
        }
      }
      // Don't repaint under the user's typing (search boxes, notes, account form).
      const typing = document.activeElement?.matches?.(".pc-page input, .pc-page textarea, .pc-page select");
      if (settleToggles() || (!typing && tab !== "software" && !(tab === "accounts" && acc.form))) d.paint();
    },
  };
  /** Ask the PC for a fresh program list and show it when it arrives. */
  async function reloadPrograms() {
    const before = detail?.software_at ?? null;
    swReloading = true;
    d.paint();
    try {
      await api("POST", `/api/agents/${id}/refresh`);
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const fresh = await api("GET", `/api/agents/${id}`);
        if (fresh.software_at !== before) {
          detail = fresh;
          break;
        }
      }
    } catch (e) {
      fail(e);
    }
    swReloading = false;
    if (S.page === d) d.paint();
  }
  async function takeShot() {
    toast("Taking a screenshot — the user is notified");
    try {
      const blob = await api("POST", `/api/agents/${id}/screenshot`);
      if (shot) URL.revokeObjectURL(shot);
      shot = URL.createObjectURL(blob);
      tab = "overview";
      d.paint();
    } catch (e) {
      fail(e);
    }
  }
  d.body = h("div", { class: "pc-page" });
  put(mainEl, d.body);
  S.page = d;
  d.render();
}

async function createJob(body) {
  try {
    const { job } = await api("POST", "/api/jobs", body);
    S.jobs.set(job.id, job);
    watchJob(job);
    openJob(job.id);
    return job;
  } catch (e) {
    fail(e);
  }
}

function targetLine(ids) {
  return ids.length === 1 ? S.agents.get(ids[0])?.hostname : plural(ids.length, "computer");
}

// ---- maintenance tasks ----
const POWER = new Set(["restart", "shutdown", "cancel_power"]);
function openTasks({ ids, task } = {}) {
  const tg = newTargets(ids);
  const st = { waitOffline: true, open: task ?? null, opts: {} };
  /** task id → job id of what was started from this panel. */
  const started = new Map();
  const optsFor = (t) => (st.opts[t.id] ??= { delay: t.options?.delay_min ?? 5, message: t.options?.message ?? "", asr: t.options?.asr, cfa: !!t.options?.controlled_folders });
  async function run(t) {
    const n = targetIds(tg).length;
    if (!n) return toast("Choose computers first", true);
    const o = optsFor(t);
    if ((t.id === "restart" || t.id === "shutdown") && !confirm(`${t.label}: ${plural(n, "computer")} in ${o.delay} min?`)) return;
    const options = t.choices?.asr ? { asr: o.asr, controlled_folders: !!o.cfa } : t.options ? { delay_min: Number(o.delay) || 0, message: o.message } : {};
    try {
      // A restart queued for days would surprise people: power tasks never wait.
      const { job } = await api("POST", "/api/jobs", { kind: "task", targets: targetParam(tg), wait_offline: st.waitOffline && !POWER.has(t.id), payload: { task: t.id, options } });
      S.jobs.set(job.id, job);
      watchJob(job);
      started.set(t.id, job.id);
      st.open = null;
      d.render();
    } catch (e) {
      fail(e);
    }
  }
  const statusOf = (t) => {
    const jid = started.get(t.id);
    const j = jid && S.jobs.get(jid);
    return j ? h("button", { class: "task-status", onclick: () => openJob(j.id), title: "Show the result" }, jobResultLine(j), icon("chevronRight", 14)) : null;
  };
  const optionsForm = (t) => {
    const o = optsFor(t);
    return h(
      "div",
      { class: "task-opts" },
      t.choices?.asr
        ? [
            h("label", { class: "field" }, "Attack surface reduction rules"),
            h("select", { onchange: (e) => (o.asr = e.target.value) }, Object.entries(t.choices.asr).map(([k, v]) => h("option", { value: k, selected: o.asr === k }, v))),
            h("label", { class: "check", style: { marginTop: "8px" } }, h("input", { type: "checkbox", checked: o.cfa, onchange: (e) => (o.cfa = e.target.checked) }),
              h("span", {}, "Controlled folder access (ransomware protection)", h("small", {}, "Can stop ordinary programs from saving into Documents/Desktop until allowed — try one PC first."))),
          ]
        : h("div", { class: "grid2" },
            h("div", {}, h("label", { class: "field" }, "Warning time (minutes)"), h("input", { type: "text", value: String(o.delay), oninput: (e) => (o.delay = e.target.value) })),
            h("div", {}, h("label", { class: "field" }, "Message to the user"), h("input", { type: "text", value: o.message, oninput: (e) => (o.message = e.target.value) }))),
      h("div", { class: "row", style: { marginTop: "10px" } },
        h("button", { class: `btn primary${POWER.has(t.id) ? " danger-fill" : ""}`, onclick: () => run(t) }, icon("play", 14), `Start ${t.label.toLowerCase()}`),
        h("button", { class: "btn ghost", onclick: () => { st.open = null; d.render(); } }, "Cancel")),
    );
  };
  const d = {
    title: "Maintenance",
    render() {
      const n = targetIds(tg).length;
      const groups = [...new Set(S.tasks.map((x) => x.group))];
      put(
        d.body,
        h("div", { class: "task-targets" },
          h("div", { class: "step-title" }, icon("monitor", 16), "Run on"),
          targetPicker(tg, () => d.render()),
          h("label", { class: "check" }, h("input", { type: "checkbox", checked: st.waitOffline, onchange: (e) => { st.waitOffline = e.target.checked; d.render(); } }), h("span", {}, "Offline computers run it when they connect", h("small", {}, offlineNote(tg, st.waitOffline))))),
        h("p", { class: "sub", style: { margin: "4px 0 12px" } }, "Click Run: the task starts at once and its result appears in its row. Run as many as you like."),
        groups.map((g) =>
          h("section", { class: "task-group" },
            h("div", { class: "task-gtitle" }, g),
            S.tasks.filter((x) => x.group === g).map((t) => {
              const jid = started.get(t.id);
              const running = jid && !jobResult(S.jobs.get(jid) ?? { targets: {}, counts: {} }).done;
              return h("div", { class: `task-row${st.open === t.id ? " open" : ""}`, id: `task-${t.id}` },
                h("div", { class: "task-main" },
                  h("div", { class: "grow" },
                    h("b", {}, t.label, t.minutes >= 30 ? h("span", { class: "sub" }, ` · up to ${t.minutes >= 60 ? `${Math.round(t.minutes / 60)} h` : `${t.minutes} min`}`) : null),
                    h("div", { class: "sub task-help", title: t.help }, t.help),
                    h("div", { class: "task-status-slot", "data-task": t.id }, statusOf(t))),
                  h("button", {
                    class: `btn small${t.options ? "" : " primary"}`,
                    disabled: !n || running,
                    title: n ? "" : "Choose computers first",
                    onclick: () => (t.options ? ((st.open = st.open === t.id ? null : t.id), d.render()) : run(t)),
                  }, running ? "Running…" : t.options ? "Run…" : jid ? "Run again" : "Run")),
                st.open === t.id ? optionsForm(t) : null);
            }))),
      );
      put(d.footer, h("span", { class: "sub" }, n ? `Tasks go to ${plural(n, "computer")}.` : "Choose computers above."), h("span", { class: "spacer" }), h("button", { class: "btn", onclick: () => go("activity") }, "Activity"));
      if (st.open) setTimeout(() => $(`#task-${st.open}`)?.scrollIntoView({ block: "nearest" }), 0);
    },
    live() {
      // Only the result lines change; leave option fields being typed in alone.
      for (const slot of d.body.querySelectorAll(".task-status-slot")) {
        const t = S.tasks.find((x) => x.id === slot.dataset.task);
        if (t && started.has(t.id)) put(slot, statusOf(t));
      }
      for (const [tid, jid] of started) {
        const btn = d.body.querySelector(`#task-${tid} .task-main > .btn`);
        const t = S.tasks.find((x) => x.id === tid);
        if (btn && t) {
          const running = !jobResult(S.jobs.get(jid) ?? { targets: {}, counts: {} }).done;
          btn.disabled = running || !targetIds(tg).length;
          btn.textContent = running ? "Running…" : t.options ? "Run…" : "Run again";
        }
      }
      $("#target-seg", d.body)?.replaceWith(targetPicker(tg, () => d.render()));
    },
  };
  openDrawer(d);
}

// ---- local accounts ----
/** Form for one account action. `fixed` = { user } when started from a PC's list. */
function accountForm(st, onChange) {
  const A = S.accountActions;
  const needsPw = A[st.action]?.needsPassword;
  const field = (label, input) => h("div", {}, h("label", { class: "field" }, label), input);
  return h(
    "div",
    {},
    st.fixedUser
      ? h("div", { class: "row" }, h("b", { class: "grow" }, `${A[st.action].label}: ${st.user}`))
      : h(
          "div",
          { class: "grid2" },
          field("Action", h("select", { onchange: (e) => { st.action = e.target.value; onChange(); } }, Object.entries(A).map(([k, v]) => h("option", { value: k, selected: k === st.action }, v.label)))),
          field("User name", h("input", { type: "text", value: st.user, placeholder: "e.g. itadmin", autocomplete: "off", oninput: (e) => (st.user = e.target.value) })),
        ),
    st.action === "rename" ? field("New name", h("input", { type: "text", value: st.newName, autocomplete: "off", oninput: (e) => (st.newName = e.target.value) })) : null,
    st.action === "create" ? field("Full name (optional)", h("input", { type: "text", value: st.fullName, oninput: (e) => (st.fullName = e.target.value) })) : null,
    needsPw
      ? h(
          "div",
          { class: "grid2" },
          field("New password", h("input", { type: "password", autocomplete: "new-password", value: st.password, oninput: (e) => (st.password = e.target.value) })),
          field("Repeat password", h("input", { type: "password", autocomplete: "new-password", value: st.password2, oninput: (e) => (st.password2 = e.target.value) })),
        )
      : null,
    st.action === "create" ? h("label", { class: "check" }, h("input", { type: "checkbox", checked: st.admin, onchange: (e) => (st.admin = e.target.checked) }), h("span", {}, "Administrator")) : null,
    needsPw ? h("label", { class: "check" }, h("input", { type: "checkbox", checked: st.mustChange, onchange: (e) => (st.mustChange = e.target.checked) }), h("span", {}, "User must change it at next sign-in")) : null,
    needsPw ? h("div", { class: "sub" }, "The password is sent to the PCs over the encrypted agent channel and is not stored in the history.") : null,
    st.action === "delete" ? h("div", { class: "note" }, "Deletes the account (its files under C:\\Users stay). A PC's last administrator is never deleted.") : null,
  );
}
function newAccountState(action = "set_password", user = "") {
  return { action, user, newName: "", fullName: "", password: "", password2: "", admin: false, mustChange: false, fixedUser: !!user };
}
async function submitAccount(st, targets, waitOffline) {
  if (S.accountActions[st.action]?.needsPassword && st.password !== st.password2) throw new Error("the passwords don't match");
  if (st.action === "delete" && !confirm(`Delete the account ${st.user}?`)) return;
  await createJob({
    kind: "account",
    targets,
    wait_offline: waitOffline,
    payload: { action: st.action, user: st.user.trim(), new_name: st.newName.trim(), full_name: st.fullName.trim(), password: st.password, admin: st.admin, must_change: st.mustChange },
  });
}
function openAccountsBulk(ids) {
  const tg = newTargets(ids);
  const st = newAccountState();
  const opts = { waitOffline: true };
  const d = {
    title: "Local accounts",
    render() {
      put(
        d.body,
        h("div", { class: "note info" }, "Do the same thing to one account name on many PCs — e.g. set the password of “itadmin” everywhere. To see a PC's accounts, open the PC → Accounts."),
        accountForm(st, () => d.render()),
        h("div", { class: "step", style: { marginTop: "16px" } }, h("div", { class: "step-title" }, "Computers"), targetPicker(tg, () => d.render())),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: opts.waitOffline, onchange: (e) => (opts.waitOffline = e.target.checked) }), h("span", {}, "Also offline computers when they come back", h("small", {}, "Passwords are kept in the master's memory only until then; a master restart drops them."))),
      );
      const n = targetIds(tg).length;
      put(d.footer, h("button", { class: "btn primary big", disabled: !n, onclick: () => submitAccount(st, targetParam(tg), opts.waitOffline).catch(fail) }, n ? `Apply on ${plural(n, "computer")}` : "Choose computers"), h("span", { class: "sub" }, offlineNote(tg, opts.waitOffline)));
    },
    live() {
      $("#target-seg", d.body)?.replaceWith(targetPicker(tg, () => d.render()));
    },
  };
  openDrawer(d);
}

function openScript(ids) {
  const ta = h("textarea", { class: "mono", placeholder: "Get-Service | Where-Object Status -eq Running", rows: 12 });
  const wait = h("input", { type: "checkbox" });
  const d = {
    title: `PowerShell on ${targetLine(ids)}`,
    render() {
      put(d.body, 
        h("div", { class: "note info" }, "Runs as SYSTEM with no window. Output comes back in Activity."),
        h("label", { class: "field" }, "Script"),
        ta,
        h("label", { class: "check" }, wait, h("span", {}, "Run on offline computers when they come back")),
      );
      put(d.footer, h("button", { class: "btn primary big", onclick: () => ta.value.trim() && createJob({ kind: "script", targets: ids, wait_offline: wait.checked, payload: { script: ta.value } }) }, `Run on ${targetLine(ids)}`));
      setTimeout(() => ta.focus(), 0);
    },
  };
  openDrawer(d);
}

function openMessage(ids) {
  const title = h("input", { type: "text", value: "IT" });
  const ta = h("textarea", { rows: 5, placeholder: "The PC will restart at 18:00 for updates." });
  const d = {
    title: `Message ${targetLine(ids)}`,
    render() {
      put(d.body, h("label", { class: "field" }, "Title"), title, h("label", { class: "field" }, "Message"), ta);
      put(d.footer, h("button", { class: "btn primary big", onclick: () => ta.value.trim() && createJob({ kind: "message", targets: ids, payload: { title: title.value, body: ta.value } }) }, "Send"));
    },
  };
  openDrawer(d);
}

function openAgentSettings(ids) {
  const emg = h("input", { type: "text", placeholder: "https://documente.example.md — empty = turn the bridge off", value: S.master?.emanagement_url ?? "" });
  const addr = h("input", { type: "text", placeholder: "e.g. https://fleetview.akulav.com — empty = the agent's built-in address", value: S.master?.agent_address ?? "" });
  const useEmg = h("input", { type: "checkbox", checked: true });
  const useAddr = h("input", { type: "checkbox" });
  const d = {
    title: `Agent settings on ${targetLine(ids)}`,
    render() {
      put(d.body,
        h("div", { class: "note info" }, "Writes these into each PC's agent.config.json; the agent restarts to apply them. Only ticked settings change."),
        h("label", { class: "check" }, useEmg, h("span", {}, "e-Management URL", h("small", {}, "Turns on the MoldSign signing bridge for e-Management on these PCs."))),
        emg,
        h("label", { class: "check", style: { marginTop: "16px" } }, useAddr, h("span", {}, "Master address", h("small", {}, "Where the agents look for this master: a web address (https://…), host:port for the direct agent port, or \"discovery\" for LAN broadcast."))),
        addr,
      );
      put(d.footer, h("button", { class: "btn primary big", onclick: () => {
        const updates = [];
        if (useEmg.checked) updates.push({ key: "emanagement_url", value: emg.value.trim() });
        if (useAddr.checked) updates.push({ key: "master_address", value: addr.value.trim() });
        if (!updates.length) return toast("Tick at least one setting.", true);
        createJob({ kind: "config", targets: ids, payload: { updates } });
      } }, "Apply"));
    },
  };
  openDrawer(d);
}

function openEmanagementSetting() {
  const url = h("input", { type: "text", placeholder: "https://documente.example.md", value: S.master?.emanagement_url ?? "" });
  const d = {
    title: "e-Management URL",
    render() {
      put(d.body,
        h("p", { class: "sub" }, "Put into every new agent installer and agent update; it turns on the MoldSign signing bridge. PCs installed already keep their own value — change those with Agent settings (tick PCs on Computers)."),
        url);
      put(d.footer, h("button", { class: "btn primary big", onclick: async () => {
        try {
          const r = await api("PUT", "/api/settings/emanagement", { url: url.value });
          S.master.emanagement_url = r.url;
          toast(r.url ? "Saved — new installers include it" : "Cleared");
          closeDrawer();
          go("settings");
        } catch (e) { fail(e); }
      } }, "Save"));
    },
  };
  openDrawer(d);
}

// ----------------------------------------------------------------- rename --
// Same rules as the master (src/rename.js), so problems show while typing.
function checkPcName(n) {
  if (!n) return "enter a name";
  if (n.length > 15) return `${n}: longer than 15 characters`;
  if (!/^[A-Za-z0-9-]+$/.test(n)) return `${n}: only letters, digits and hyphens`;
  if (/^\d+$/.test(n)) return `${n}: can't be only digits`;
  if (n.startsWith("-") || n.endsWith("-")) return `${n}: can't start or end with a hyphen`;
  return null;
}
function expandPattern(pattern, count, start) {
  const m = /#+/.exec(pattern);
  const first = Math.max(0, Math.floor(Number(start) || 0));
  return Array.from({ length: count }, (_, i) =>
    m ? pattern.slice(0, m.index) + String(first + i).padStart(m[0].length, "0") + pattern.slice(m.index + m[0].length) : pattern,
  );
}
const byHost = (a, b) => a.hostname.localeCompare(b.hostname, undefined, { numeric: true, sensitivity: "base" });

function openRename(ids) {
  const list = ids.map((id) => S.agents.get(id)).filter(Boolean).sort(byHost);
  if (!list.length) return toast("Choose at least one computer", true);
  const single = list.length === 1;
  const st = { name: single ? list[0].pending_name || list[0].hostname : "", pattern: "PC-###", start: 1, restart: false, delay: 1, waitOffline: true, status: null };
  const names = () => {
    if (single) return { [list[0].id]: st.name.trim() };
    const n = expandPattern(st.pattern.trim(), list.length, st.start);
    return Object.fromEntries(list.map((a, i) => [a.id, n[i]]));
  };
  const problems = () => {
    const out = [];
    const nm = names();
    const seen = new Map();
    for (const [id, n] of Object.entries(nm)) {
      const e = checkPcName(n);
      if (e) out.push(e);
      else if (seen.has(n.toUpperCase())) out.push(`${n} would be used twice — put # in the pattern for a number`);
      seen.set(n.toUpperCase(), id);
      const other = [...S.agents.values()].find((x) => x.id !== id && !nm[x.id] && [x.hostname, x.pending_name].some((v) => String(v ?? "").toUpperCase() === n.toUpperCase()));
      if (other && !e) out.push(`${n} is already used by ${other.hostname}`);
    }
    return [...new Set(out)];
  };
  if (single && list[0].online) {
    api("POST", `/api/agents/${list[0].id}/name`)
      .then((r) => { st.status = r; d.render(); })
      .catch((e) => { st.status = { error: e.message }; d.render(); });
  }
  const d = {
    title: single ? `Rename ${list[0].hostname}` : `Rename ${plural(list.length, "computer")}`,
    render() {
      const a0 = list[0];
      const status = single
        ? h("div", { class: "note info" },
            !a0.online ? "The PC is offline: the rename runs when it connects (if ticked below)."
            : !st.status ? "Checking the PC's name…"
            : st.status.error ? `Couldn't read the PC's name: ${st.status.error}`
            : [`Current name: ${st.status.active}.`, st.status.pending ? h("b", {}, ` Rename to ${st.status.pending} is pending restart.`) : " No rename pending.",
               st.status.domain ? " Domain-joined: renaming as SYSTEM only works if the PC may rename its own AD account; otherwise do it with domain credentials." : ""])
        : null;
      const nameInput = h("input", { type: "text", class: "mono", maxlength: "15", value: st.name, autocomplete: "off", oninput: (e) => { st.name = e.target.value; paintCheck(); } });
      const patternInput = h("input", { type: "text", class: "mono", value: st.pattern, autocomplete: "off", oninput: (e) => { st.pattern = e.target.value; paintCheck(); } });
      const startInput = h("input", { type: "text", value: String(st.start), oninput: (e) => { st.start = e.target.value; paintCheck(); } });
      put(d.body,
        status,
        single
          ? h("div", {}, h("label", { class: "field" }, "New name"), nameInput)
          : h("div", {},
              h("div", { class: "grid2" },
                h("div", {}, h("label", { class: "field" }, "Pattern (# = number, ### = 001, 002…)"), patternInput),
                h("div", {}, h("label", { class: "field" }, "First number"), startInput)),
              h("div", { class: "sub", style: { marginTop: "6px" } }, "PCs are numbered in name order.")),
        h("div", { id: "rename-check" }),
        h("div", { class: "step", style: { marginTop: "16px" } },
          h("label", { class: "check" }, h("input", { type: "checkbox", checked: st.restart, onchange: (e) => { st.restart = e.target.checked; st.waitOffline = !st.restart; d.render(); } }),
            h("span", {}, "Restart after renaming", h("small", {}, "The new name only takes effect after a restart. Signed-in users get a warning, then the PC restarts — unsaved work is lost."))),
          st.restart ? h("div", { class: "grid2" }, h("div", {}, h("label", { class: "field" }, "Restart in (minutes)"), h("input", { type: "text", value: String(st.delay), oninput: (e) => (st.delay = e.target.value) }))) : null,
          h("label", { class: "check" }, h("input", { type: "checkbox", checked: st.waitOffline, onchange: (e) => (st.waitOffline = e.target.checked) }), h("span", {}, "Rename offline computers when they come back")),
        ),
      );
      paintCheck();
      if (single) setTimeout(() => nameInput.focus(), 0);
    },
  };
  function paintCheck() {
    const box = $("#rename-check", d.body);
    if (!box) return;
    const errs = problems();
    const nm = names();
    put(box,
      errs.length ? h("div", { class: "note" }, errs.slice(0, 6).map((e) => h("div", {}, e))) : null,
      !single
        ? h("div", { class: "card", style: { marginTop: "10px", maxHeight: "320px", overflow: "auto" } },
            h("table", {}, h("tbody", {}, list.map((a) => h("tr", {},
              h("td", {}, h("span", { class: `dot${a.online ? " on" : ""}` }), " ", a.hostname, a.pending_name ? h("span", { class: "pill warn", style: { marginLeft: "6px" } }, `pending: ${a.pending_name}`) : null),
              h("td", { class: "mono" }, "→ ", nm[a.id]))))))
        : null,
    );
    const n = list.length;
    put(d.footer,
      h("button", { class: "btn primary big", disabled: errs.length > 0, onclick: async (e) => {
        const delay = Math.max(0, Math.min(60, Number(st.delay) || 0));
        if (st.restart && !confirm(`Rename and restart ${plural(n, "computer")} ${delay ? `in ${delay} min` : "right away"}? Signed-in users lose unsaved work.`)) return;
        e.target.disabled = true;
        await createJob({ kind: "rename", targets: list.map((a) => a.id), wait_offline: st.waitOffline, payload: { names: names(), restart: st.restart, delay_sec: delay * 60, pattern: single ? undefined : st.pattern } });
      } }, single ? `Rename to ${st.name.trim() || "…"}` : `Rename ${plural(n, "computer")}`),
      h("span", { class: "sub" }, st.restart ? "then restart" : "takes effect at the next restart"),
    );
  }
  openDrawer(d);
}

// ---------------------------------------------------------- saved scripts --
// ------------------------------------------------------------------ apply --
// One place to apply many changes to many PCs: pick changes (tasks, saved
// scripts, "mark as cleaned") into an ordered list, pick computers, run. Each
// PC runs the list top to bottom as one action with a result per step.
const AP = { steps: [], ids: new Set(), filter: "all", query: "", waitOffline: true, stopOnFail: false, name: "", fleet: null, fleetLoading: false };
let apSeq = 0;

function openApply(ids) {
  if (ids?.length) AP.ids = new Set(ids);
  else if (S.selected.size) AP.ids = new Set(S.selected);
  closeDrawer();
  go("apply");
}

const APPLY_PRESETS = [
  { id: "setup", label: "New PC setup", help: "Everything the clean checklist needs (Windows Update repaired, checked, installed; security baseline + check; adblocker; clean-up; accounts read) plus a snapshot and the debloat script. The PC is marked cleaned by itself when every check passes.", steps: ["task:perf_snapshot", "task:repair_updates", "task:check_updates", "task:install_updates", "task:security_baseline", "task:security_status", "task:adblock", "script:debloat", "task:cleanup", "task:accounts_list"] },
  { id: "clean", label: "Clean-up", help: "Snapshot before, debloat, temp files, accounts read — the PC is marked cleaned by itself once its whole checklist passes", steps: ["task:perf_snapshot", "script:debloat", "task:cleanup", "task:disk_health", "task:accounts_list"] },
  { id: "secure", label: "Secure", help: "Security baseline, adblocker, Defender update + scan, security check", steps: ["task:security_baseline", "task:adblock", "task:defender_scan", "task:security_status"] },
  { id: "health", label: "Health check (changes nothing)", help: "Security check, updates waiting, disk health, performance, internet speed", steps: ["task:security_status", "task:check_updates", "task:disk_health", "task:perf_snapshot", "task:speed_test"] },
  { id: "updates", label: "Fix & install updates", help: "Repair Windows Update, then install everything waiting", steps: ["task:repair_updates", "task:install_updates"] },
];

function apStep(key) {
  const [type, ref] = key.split(":");
  if (type === "task") {
    const t = S.tasks.find((x) => x.id === ref);
    if (!t) return null;
    return { key, uid: ++apSeq, type: "task", task: t.id, label: t.label, help: t.help, options: t.options ? { ...t.options } : null, choices: t.choices };
  }
  if (type === "script") {
    const s = ref === "debloat" ? S.scripts.find((x) => /debloat/i.test(x.name)) : S.scripts.find((x) => x.id === ref);
    if (!s) return null;
    return { key: `script:${s.id}`, uid: ++apSeq, type: "saved_script", script_id: s.id, label: `Script: ${s.name}`, help: s.description || "" };
  }
  if (type === "mark") return { key, uid: ++apSeq, type: "mark_cleaned", label: "Mark as cleaned", help: "Marks each PC as cleaned when every step before it succeeded (the before/after comparison starts here).", note: "" };
  return null;
}
function apAdd(key) {
  const s = apStep(key);
  if (!s || AP.steps.some((x) => x.key === s.key)) return;
  // Power steps and the cleaned mark go last; a restart after the mark.
  const tailRank = (x) => (x.type === "task" && POWER.has(x.task) ? 2 : x.type === "mark_cleaned" ? 1 : 0);
  AP.steps.push(s);
  AP.steps.sort((a, b) => tailRank(a) - tailRank(b));
}

function apAgents() {
  const q = AP.query.trim().toLowerCase();
  return [...S.agents.values()]
    .filter((a) => {
      if (AP.filter === "online" && !a.online) return false;
      if (AP.filter === "offline" && a.online) return false;
      if (AP.filter === "dirty" && a.cleaned) return false;
      if (AP.filter === "cleaned" && !a.cleaned) return false;
      if (AP.filter === "picked" && !AP.ids.has(a.id)) return false;
      return !q || [a.hostname, a.user, a.ip, a.os, ...(a.tags ?? [])].some((x) => String(x ?? "").toLowerCase().includes(q));
    })
    .sort((a, b) => (b.online - a.online) || a.hostname.localeCompare(b.hostname));
}

function renderApply(main, full) {
  main.dataset.view = "apply";
  if (!full && $("#ap-root")) {
    // Live updates: only what changes on its own.
    const pcs = $("#ap-pcs");
    if (pcs && !pcs.contains(document.activeElement)) apPaintPcs();
    apPaintRun();
    return;
  }
  for (const id of [...AP.ids]) if (!S.agents.has(id)) AP.ids.delete(id);
  put(
    main,
    pageHead("Apply changes", "Pick changes and computers — every PC runs the list from top to bottom, with a result per step."),
    h(
      "div",
      { class: "apply", id: "ap-root" },
      h("section", { class: "card ap-lib" }, h("div", { class: "ap-col-head" }, h("span", { class: "step-num" }, "1"), h("b", {}, "Changes")), h("div", { id: "ap-lib" })),
      h("section", { class: "card ap-plan" }, h("div", { class: "ap-col-head" }, h("span", { class: "step-num" }, "2"), h("b", {}, "In this order")), h("div", { id: "ap-steps" })),
      h("section", { class: "card ap-pcs-card" }, h("div", { class: "ap-col-head" }, h("span", { class: "step-num" }, "3"), h("b", {}, "On these computers")), h("div", { id: "ap-pcs" })),
    ),
    h("div", { class: "ap-run", id: "ap-run" }),
    h("div", { class: "grid2", style: { marginTop: "18px" } }, h("section", { class: "card card-pad", id: "ap-fleet" }), h("section", { class: "card card-pad", id: "ap-measure" })),
  );
  apPaintLib();
  apPaintSteps();
  apPaintPcs();
  apPaintRun();
  apPaintMeasure();
  apLoadFleet();
}

function apPaintLib() {
  const root = $("#ap-lib");
  if (!root) return;
  const has = (k) => AP.steps.some((x) => x.key === k);
  const item = (key, label, sub, title) =>
    h("button", { class: `ap-item${has(key) ? " added" : ""}`, title: title ?? "", onclick: () => { has(key) ? (AP.steps = AP.steps.filter((x) => x.key !== key)) : apAdd(key); apPaintLib(); apPaintSteps(); apPaintRun(); } },
      h("span", { class: "ap-plus" }, has(key) ? "✓" : "+"), h("span", { class: "grow" }, label, sub ? h("span", { class: "sub" }, ` ${sub}`) : null));
  const groups = [...new Set(S.tasks.map((t) => t.group))];
  put(
    root,
    h("div", { class: "ap-presets" }, h("div", { class: "sub ap-group" }, "Ready-made"), APPLY_PRESETS.map((p) =>
      h("button", { class: "chip", title: p.help, onclick: () => { AP.steps = []; p.steps.forEach(apAdd); AP.name = p.label.replace(/ \(.*\)$/, ""); apPaintLib(); apPaintSteps(); apPaintRun(); } }, p.label))),
    groups.map((g) => [
      h("div", { class: "sub ap-group" }, g),
      S.tasks.filter((t) => t.group === g && t.id !== "cancel_power").map((t) => item(`task:${t.id}`, t.label, null, t.help)),
    ]),
    h("div", { class: "sub ap-group" }, "Saved scripts"),
    S.scripts.length ? S.scripts.map((s) => item(`script:${s.id}`, s.name, null, s.description)) : h("div", { class: "sub" }, "None yet — add them on the Scripts page."),
    h("div", { class: "sub ap-group" }, "Marks"),
    item("mark", "Mark as cleaned", null, "Sets the PC's cleaned date when the steps before it succeeded"),
  );
}

function apPaintSteps() {
  const root = $("#ap-steps");
  if (!root) return;
  if (!AP.steps.length) {
    return put(root, h("div", { class: "empty ap-empty" }, h("b", {}, "Nothing chosen yet"), "Click changes on the left, or start from a ready-made list."));
  }
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= AP.steps.length) return;
    [AP.steps[i], AP.steps[j]] = [AP.steps[j], AP.steps[i]];
    apPaintSteps();
  };
  put(
    root,
    h("label", { class: "field", style: { marginTop: 0 } }, "Name (shown in Activity, optional)"),
    h("input", { type: "text", value: AP.name, placeholder: "e.g. New PC setup", oninput: (e) => { AP.name = e.target.value; } }),
    h("ol", { class: "ap-steps" }, AP.steps.map((s, i) =>
      h(
        "li",
        { class: "ap-step" },
        h("div", { class: "row" },
          h("span", { class: "ap-n" }, i + 1),
          h("b", { class: "grow" }, s.label),
          h("button", { class: "btn ghost small", title: "Up", disabled: i === 0, onclick: () => move(i, -1) }, "↑"),
          h("button", { class: "btn ghost small", title: "Down", disabled: i === AP.steps.length - 1, onclick: () => move(i, 1) }, "↓"),
          h("button", { class: "btn ghost small", title: "Remove", onclick: () => { AP.steps.splice(i, 1); apPaintSteps(); apPaintLib(); apPaintRun(); } }, "✕")),
        s.help ? h("div", { class: "sub ap-help", title: s.help }, s.help) : null,
        apStepOptions(s),
      ),
    )),
    POWER_LAST(),
  );
}
function POWER_LAST() {
  const i = AP.steps.findIndex((s) => s.type === "task" && POWER.has(s.task));
  return i >= 0 && i !== AP.steps.length - 1 ? h("div", { class: "note" }, "Restart / shut down must be the last step.") : null;
}
function apStepOptions(s) {
  if (s.type === "mark_cleaned") return h("input", { type: "text", class: "ap-opt", placeholder: "Note (optional), e.g. removed bloat, new SSD", value: s.note, oninput: (e) => (s.note = e.target.value) });
  if (s.type !== "task" || !s.options) return null;
  if (s.choices?.asr) {
    return h(
      "div",
      { class: "ap-opt" },
      h("label", { class: "field" }, "Attack surface reduction rules"),
      h("select", { onchange: (e) => (s.options.asr = e.target.value) }, Object.entries(s.choices.asr).map(([k, v]) => h("option", { value: k, selected: s.options.asr === k }, v))),
      h("label", { class: "check", style: { marginTop: "8px" } }, h("input", { type: "checkbox", checked: !!s.options.controlled_folders, onchange: (e) => (s.options.controlled_folders = e.target.checked) }),
        h("span", {}, "Controlled folder access (ransomware protection)", h("small", {}, "Can stop ordinary programs from saving into Documents/Desktop until they are allowed — test on one PC first."))),
    );
  }
  if ("delay_min" in s.options) {
    return h(
      "div",
      { class: "grid2 ap-opt" },
      h("div", {}, h("label", { class: "field" }, "Warning time (minutes)"), h("input", { type: "text", value: String(s.options.delay_min), oninput: (e) => (s.options.delay_min = Number(e.target.value) || 0) })),
      h("div", {}, h("label", { class: "field" }, "Message to the user"), h("input", { type: "text", value: s.options.message ?? "", oninput: (e) => (s.options.message = e.target.value) })),
    );
  }
  return null;
}

function apPaintPcs() {
  const root = $("#ap-pcs");
  if (!root) return;
  const list = apAgents();
  const all = [...S.agents.values()];
  const chip = (id, label, n) => h("button", { class: `chip${AP.filter === id ? " active" : ""}`, onclick: () => { AP.filter = id; apPaintPcs(); } }, `${label} ${n}`);
  const shownAll = list.length > 0 && list.every((a) => AP.ids.has(a.id));
  const search = h("input", { type: "search", class: "search", placeholder: "Search name, user, tag…", value: AP.query, oninput: (e) => { AP.query = e.target.value; apPaintPcsList(); } });
  put(
    root,
    h("div", { class: "chips ap-chips" },
      chip("all", "All", all.length),
      chip("online", "Online", all.filter((a) => a.online).length),
      chip("dirty", "Not cleaned", all.filter((a) => !a.cleaned).length),
      chip("cleaned", "Cleaned", all.filter((a) => a.cleaned).length),
      chip("picked", "Chosen", AP.ids.size)),
    h("div", { class: "row", style: { margin: "8px 0" } }, search),
    h("div", { class: "row ap-pick-tools" },
      h("label", { class: "check inline" }, h("input", { type: "checkbox", id: "ap-all", checked: shownAll, onchange: (e) => { for (const a of apAgents()) e.target.checked ? AP.ids.add(a.id) : AP.ids.delete(a.id); apPaintPcsList(); apPaintRun(); } }), h("span", {}, "All shown")),
      h("span", { class: "spacer" }),
      AP.ids.size ? h("button", { class: "btn ghost small", onclick: () => { AP.ids.clear(); apPaintPcs(); apPaintRun(); } }, "Choose none") : null),
    h("div", { class: "ap-pc-list", id: "ap-pc-list" }),
  );
  apPaintPcsList();
}
function apPaintPcsList() {
  const root = $("#ap-pc-list");
  if (!root) return;
  const list = apAgents();
  const all = $("#ap-all");
  if (all) all.checked = list.length > 0 && list.every((a) => AP.ids.has(a.id));
  if (!list.length) return put(root, h("div", { class: "sub", style: { padding: "10px" } }, "No computers match."));
  put(
    root,
    ...list.map((a) =>
      h(
        "label",
        { class: `ap-pc${AP.ids.has(a.id) ? " on" : ""}` },
        h("input", { type: "checkbox", checked: AP.ids.has(a.id), onchange: (e) => { e.target.checked ? AP.ids.add(a.id) : AP.ids.delete(a.id); e.target.closest(".ap-pc").classList.toggle("on", e.target.checked); apPaintRun(); const x = $("#ap-all"); if (x) x.checked = apAgents().every((y) => AP.ids.has(y.id)); } }),
        h("span", { class: `dot${a.online ? " on" : ""}` }),
        h("span", { class: "grow" }, h("b", {}, a.hostname), h("span", { class: "sub" }, ` ${a.online ? (a.user ? a.user.split("\\").pop() : "") : `offline · ${ago(a.last_seen)}`}`)),
        a.cleaned ? h("span", { class: "pill ok", title: `Cleaned ${new Date(a.cleaned.at).toLocaleDateString()}` }, `✓ ${ago(a.cleaned.at)}`) : null,
      ),
    ),
  );
}

function apPaintRun() {
  const root = $("#ap-run");
  if (!root) return;
  const ids = [...AP.ids].filter((id) => S.agents.has(id));
  const offline = ids.filter((id) => !S.agents.get(id).online).length;
  const n = AP.steps.length;
  const blocked = !!POWER_LAST();
  put(
    root,
    h("div", { class: "card ap-run-card" },
      h("div", { class: "grow" },
        h("b", {}, n ? `${plural(n, "change")} on ${plural(ids.length, "computer")}` : "Choose changes and computers"),
        h("div", { class: "row", style: { gap: "18px", marginTop: "6px", flexWrap: "wrap" } },
          h("label", { class: "check inline" }, h("input", { type: "checkbox", checked: AP.waitOffline, onchange: (e) => { AP.waitOffline = e.target.checked; apPaintRun(); } }), h("span", {}, "Offline PCs run it when they connect")),
          h("label", { class: "check inline" }, h("input", { type: "checkbox", checked: AP.stopOnFail, onchange: (e) => (AP.stopOnFail = e.target.checked) }), h("span", {}, "Stop at the first failure")),
        ),
        offline ? h("div", { class: "sub", style: { marginTop: "4px" } }, `${offline} of them offline — ${AP.waitOffline ? "they get it when they connect" : "they will be skipped"}.`) : null,
      ),
      h("button", {
        class: "btn primary big",
        disabled: !n || !ids.length || blocked,
        onclick: async (e) => {
          const list = AP.steps.map((s, i) => `${i + 1}. ${s.label}`).join("\n");
          if (!confirm(`Run on ${plural(ids.length, "computer")}:\n\n${list}`)) return;
          e.target.disabled = true;
          const steps = AP.steps.map((s) =>
            s.type === "task" ? { type: "task", task: s.task, options: s.options ?? {} } : s.type === "saved_script" ? { type: "saved_script", script_id: s.script_id } : { type: "mark_cleaned", note: s.note });
          await createJob({ kind: "batch", targets: ids, wait_offline: AP.waitOffline, payload: { name: AP.name, steps, stop_on_fail: AP.stopOnFail } });
          e.target.disabled = false;
        },
      }, "Run"),
    ),
  );
}

async function apLoadFleet() {
  if (AP.fleetLoading) return;
  AP.fleetLoading = true;
  try {
    AP.fleet = await api("GET", "/api/metrics/fleet");
  } catch {
    AP.fleet = null;
  }
  AP.fleetLoading = false;
  apPaintFleet();
}
function apPaintFleet() {
  const root = $("#ap-fleet");
  if (!root) return;
  const f = AP.fleet;
  if (!f) return put(root, h("h3", {}, "Before / after cleaning"), h("div", { class: "sub" }, "Loading…"));
  const pct = (x) => (x == null ? "—" : `${x}%`);
  put(
    root,
    h("h3", {}, "Before / after cleaning"),
    f.rows.length
      ? [
          f.measured
            ? h("div", { class: "big-stats" },
                h("div", {}, h("span", {}, "CPU before → after"), h("b", {}, `${pct(f.cpu_before)} → ${pct(f.cpu_after)}`), delta(f.cpu_before, f.cpu_after)),
                h("div", {}, h("span", {}, "Memory before → after"), h("b", {}, `${pct(f.mem_before)} → ${pct(f.mem_after)}`), delta(f.mem_before, f.mem_after)),
                h("div", {}, h("span", {}, "Measured PCs"), h("b", {}, `${f.measured} of ${f.rows.length}`)))
            : h("div", { class: "sub" }, "Cleaned PCs need some running time before and after the mark to compare."),
          h("table", { class: "cmp" },
            h("thead", {}, h("tr", {}, h("th", {}, "Computer"), h("th", {}, "Cleaned"), h("th", {}, "CPU"), h("th", {}, "Memory"), h("th", { class: "hide-sm" }, "Boot"))),
            h("tbody", {}, f.rows.sort((a, b) => b.cleaned.at.localeCompare(a.cleaned.at)).map((r) =>
              h("tr", { class: "click", onclick: () => openDevice(r.id) },
                h("td", {}, r.hostname),
                h("td", {}, ago(r.cleaned.at)),
                h("td", {}, `${pct(r.before?.cpu)} → ${pct(r.after?.cpu)} `, delta(r.before?.cpu, r.after?.cpu) ?? ""),
                h("td", {}, `${pct(r.before?.mem)} → ${pct(r.after?.mem)} `, delta(r.before?.mem, r.after?.mem) ?? ""),
                h("td", { class: "hide-sm" }, r.boot_before || r.boot_after ? `${r.boot_before ? Math.round(r.boot_before / 1000) : "—"} → ${r.boot_after ? Math.round(r.boot_after / 1000) : "—"} s` : "—"))))),
        ]
      : h("div", { class: "sub" }, "No computer is marked as cleaned yet. Add “Mark as cleaned” to a run, or mark PCs on their page."),
    h("div", { class: "sub", style: { marginTop: "8px" } }, "Averages while the PC was on: 7 days before the mark against the time since (up to 7 days). How the PC was used matters too — compare a few PCs, not one."),
  );
}
function apPaintMeasure() {
  const root = $("#ap-measure");
  if (!root) return;
  const cur = S.master?.metrics?.speed_every_h ?? 0;
  const opts = [[0, "Off"], [6, "Every 6 hours"], [12, "Every 12 hours"], [24, "Once a day"], [72, "Every 3 days"], [168, "Once a week"]];
  put(
    root,
    h("h3", {}, "Measurements"),
    h("div", { class: "sub" }, "CPU and memory history is kept automatically (hourly, 14 days; daily, 6 months) from the agents' regular reports."),
    h("label", { class: "field" }, "Scheduled internet speed tests"),
    h("select", {
      onchange: async (e) => {
        try {
          await api("PUT", "/api/settings/metrics", { speed_every_h: Number(e.target.value) });
          toast(Number(e.target.value) ? "Speed tests scheduled" : "Scheduled speed tests off");
        } catch (ex) {
          fail(ex);
        }
      },
    }, opts.map(([v, l]) => h("option", { value: v, selected: cur === v }, l)), opts.some(([v]) => v === cur) ? null : h("option", { value: cur, selected: true }, `Every ${cur} hours`)),
    h("div", { class: "sub", style: { marginTop: "6px" } }, "One PC at a time (tests on the same line slow each other down), about 30 s and up to 35 MB each, against Cloudflare's speed test. Results are on each PC's page; they don't fill Activity."),
    h("div", { class: "row", style: { marginTop: "12px", flexWrap: "wrap" } },
      h("button", { class: "btn small", onclick: () => { AP.steps = []; ["task:perf_snapshot"].forEach(apAdd); AP.name = "Performance snapshot"; apPaintLib(); apPaintSteps(); apPaintRun(); window.scrollTo({ top: 0, behavior: "smooth" }); } }, "Snapshot the chosen PCs…"),
      h("button", { class: "btn small", onclick: () => { AP.steps = []; ["task:speed_test"].forEach(apAdd); AP.name = "Internet speed test"; apPaintLib(); apPaintSteps(); apPaintRun(); window.scrollTo({ top: 0, behavior: "smooth" }); } }, "Speed-test the chosen PCs…")),
  );
}

function renderScripts(main, full) {
  if (!full && main.dataset.view === "scripts") return;
  main.dataset.view = "scripts";
  const list = [...S.scripts].sort((a, b) => a.name.localeCompare(b.name));
  put(main,
    pageHead("Scripts", "Saved PowerShell scripts to run on one PC, a selection or the whole fleet.", h("button", { class: "btn primary", onclick: () => openScriptEditor() }, icon("plus", 16), "New script")),
    h("p", { class: "sub", style: { marginTop: "-6px", marginBottom: "14px" } }, "PowerShell scripts saved on the master. Run one on a PC, the selected PCs or the whole fleet (offline PCs run it when they connect); every PC's result is in Activity. Scripts run as SYSTEM with no window."),
    h("div", { class: "card card-pad script-list" },
      list.length
        ? list.map((s) => h("div", { class: "sw script-row" },
            h("div", { class: "grow" },
              h("b", {}, s.name), " ",
              s.auto_new ? h("span", { class: "pill blue", title: s.auto_since ? `since ${new Date(s.auto_since).toLocaleString()}` : "" }, `Runs on new PCs${s.auto_count ? ` · ${s.auto_count} so far` : ""}`) : null,
              s.description ? h("div", { class: "sub" }, s.description) : null,
              h("div", { class: "sub" }, `${plural(s.script.split("\n").length, "line")} · changed ${ago(s.updated_at)}${s.by ? ` · ${s.by}` : ""}`)),
            h("button", { class: "btn small primary", onclick: () => openRunScript({ scriptId: s.id }) }, "Run…"),
            h("button", { class: "btn small", onclick: () => openScriptEditor(s.id) }, "Edit"),
            h("button", { class: "btn small ghost danger", onclick: () => confirm(`Delete the script “${s.name}”? Its past runs stay in Activity.`) && api("DELETE", `/api/scripts/${s.id}`).then(() => toast("Deleted")).catch(fail) }, "Delete"),
          ))
        : h("div", { class: "empty" }, h("b", {}, "No saved scripts"), "Save a PowerShell script once, then run it on any computers with one click."),
    ),
  );
}

function openScriptEditor(id) {
  const s = id ? S.scripts.find((x) => x.id === id) : null;
  const name = h("input", { type: "text", value: s?.name ?? "", placeholder: "e.g. Remove bloatware", maxlength: "100" });
  const desc = h("input", { type: "text", value: s?.description ?? "", placeholder: "What it does (optional)" });
  const ta = h("textarea", { class: "mono script-edit", rows: 22, spellcheck: "false", value: s?.script ?? "", placeholder: "# Runs as SYSTEM\nGet-Service | Where-Object Status -eq Running" });
  ta.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    e.preventDefault(); // indent instead of leaving the editor
    ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end");
  });
  const auto = h("input", { type: "checkbox", checked: !!s?.auto_new });
  const save = async (andRun) => {
    try {
      const b = { name: name.value, description: desc.value, script: ta.value, auto_new: auto.checked };
      const r = s ? await api("PUT", `/api/scripts/${s.id}`, b) : await api("POST", "/api/scripts", b);
      const i = S.scripts.findIndex((x) => x.id === r.script.id);
      if (i >= 0) S.scripts[i] = r.script;
      else S.scripts.push(r.script);
      toast("Saved");
      if (andRun) openRunScript({ scriptId: r.script.id });
      else closeDrawer();
      if (S.view === "scripts") renderScripts($("#main"), true);
    } catch (e) {
      fail(e);
    }
  };
  const d = {
    title: s ? `Edit “${s.name}”` : "New script",
    render() {
      put(d.body,
        h("label", { class: "field" }, "Name"), name,
        h("label", { class: "field" }, "Description"), desc,
        h("label", { class: "field" }, "PowerShell"), ta,
        h("div", { class: "sub", style: { marginTop: "6px" } }, "Runs as SYSTEM with Windows PowerShell 5.1, no window, up to 4 hours. The last line it prints is the result shown in Activity; exit with a non-zero code to mark a PC as failed."),
        h("label", { class: "check", style: { marginTop: "14px" } }, auto,
          h("span", {}, "Run automatically on new PCs", h("small", {}, "Every PC that enrolls from now on runs it once, shortly after it first connects. PCs you already have are not affected — run it on them with Run…."))),
      );
      put(d.footer,
        h("button", { class: "btn primary big", onclick: () => save(false) }, "Save"),
        h("button", { class: "btn", onclick: () => save(true) }, "Save and run…"),
        h("span", { class: "spacer" }),
        h("button", { class: "btn ghost", onclick: closeDrawer }, "Cancel"));
      if (!s) setTimeout(() => name.focus(), 0);
    },
  };
  openDrawer(d);
}

function openRunScript({ ids, scriptId } = {}) {
  const tg = newTargets(ids);
  const st = { id: scriptId ?? null, waitOffline: true, show: false };
  const d = {
    title: "Run a saved script",
    render() {
      const list = [...S.scripts].sort((a, b) => a.name.localeCompare(b.name));
      const s = list.find((x) => x.id === st.id);
      put(d.body,
        h("div", { class: "step" }, h("div", { class: "step-title" }, h("span", { class: "step-num" }, "1"), "Script"),
          list.length
            ? h("div", { class: "lib" }, list.map((x) => h("button", { class: `lib-item${x.id === st.id ? " active" : ""}`, onclick: () => { st.id = x.id; st.show = false; d.render(); } },
                h("span", { class: "name" }, x.name), x.auto_new ? h("span", { class: "pill blue" }, "new PCs") : null)))
            : h("div", { class: "empty" }, "No saved scripts yet. ", h("button", { class: "btn small", onclick: () => openScriptEditor() }, "New script")),
          s ? h("div", { class: "note info" }, s.description || "No description.", " ",
                h("a", { href: "#", onclick: (e) => { e.preventDefault(); st.show = !st.show; d.render(); } }, st.show ? "Hide script" : "Show script")) : null,
          s && st.show ? h("pre", { class: "mono script-view" }, s.script) : null),
        h("div", { class: "step" }, h("div", { class: "step-title" }, h("span", { class: "step-num" }, "2"), "Computers"), targetPicker(tg, () => d.render())),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: st.waitOffline, onchange: (e) => { st.waitOffline = e.target.checked; d.footerRender(); } }), h("span", {}, "Run on offline computers when they come back")),
      );
      d.footerRender();
    },
    footerRender() {
      const n = targetIds(tg).length;
      const s = S.scripts.find((x) => x.id === st.id);
      put(d.footer,
        h("button", { class: "btn primary big", disabled: !n || !s, onclick: async (e) => {
          if (n > 1 && !confirm(`Run “${s.name}” on ${plural(n, "computer")}?`)) return;
          e.target.disabled = true;
          await createJob({ kind: "saved_script", targets: targetParam(tg), wait_offline: st.waitOffline, payload: { script_id: s.id } });
        } }, !s ? "Choose a script" : n ? `Run on ${plural(n, "computer")}` : "Choose computers"),
        h("span", { class: "sub" }, offlineNote(tg, st.waitOffline)));
    },
    live() {
      d.footerRender();
      $("#target-seg", d.body)?.replaceWith(targetPicker(tg, () => d.render()));
    },
  };
  openDrawer(d);
}

// ------------------------------------------------------------ startup apps --
const STARTUP_KIND = { run: "Registry Run", runonce: "Run once", folder: "Startup folder", task: "Scheduled task" };
function startupWhere(e) {
  if (e.kind === "task") return `${e.trigger === "boot" ? "at boot" : "at sign-in"}${e.user ? ` · as ${e.user}` : ""}`;
  if (e.scope === "user") return e.user ? e.user.split("\\").pop() : "each user";
  return e.scope === "machine32" ? "all users (32-bit)" : "all users";
}
function enabledPill(v) {
  return v === null ? h("span", { class: "pill", title: "This user is signed out, so their setting can't be read" }, "unknown") : v ? h("span", { class: "pill ok" }, "Enabled") : h("span", { class: "pill" }, "Disabled");
}

/** The Startup tab of a PC's page. `su` holds its state. */
function startupTab(a, su, repaint) {
  const head = h("div", { class: "row", style: { marginBottom: "8px", flexWrap: "wrap" } },
    h("span", { class: "sub grow" }, su.loading ? "Asking the PC…" : su.at ? `Read ${ago(su.at)}` : ""),
    h("label", { class: "check inline" }, h("input", { type: "checkbox", checked: su.showMs, onchange: (e) => { su.showMs = e.target.checked; repaint(); } }), h("span", {}, "Windows tasks")),
    h("button", { class: "btn small", disabled: !a.online || su.loading, onclick: su.load }, "Reload"));
  if (su.error) return [head, h("div", { class: "note" }, su.error)];
  if (!su.list) return [head, !a.online ? h("div", { class: "empty" }, "The PC is offline and was never scanned.") : null];
  const shown = su.list.filter((e) => su.showMs || !e.microsoft);
  const hidden = su.list.length - shown.length;
  const groups = ["run", "folder", "runonce", "task"].map((k) => [k, shown.filter((e) => e.kind === k)]).filter(([, l]) => l.length);
  return [
    head,
    !a.online ? h("div", { class: "note" }, "The PC is offline — this is the last list it sent.") : null,
    h("div", { class: "sub", style: { marginBottom: "8px" } }, "Disabling works like Task Manager: the entry stays, Windows skips it at sign-in. Only signed-in users' own entries are listed."),
    groups.map(([k, l]) => h("div", {},
      h("div", { class: "sub", style: { margin: "14px 0 4px", fontWeight: "600" } }, `${STARTUP_KIND[k]} (${l.length})`),
      l.map((e) => {
        const busy = [...su.pending.values()].some((p) => p.key === e.key && p.sid === e.sid);
        return h("div", { class: "sw" },
          h("div", { class: "grow", style: { minWidth: "0" } },
            h("b", {}, e.name), " ", enabledPill(e.enabled), " ", h("span", { class: "pill blue" }, startupWhere(e)),
            h("div", { class: "sub mono startup-cmd", title: e.location }, e.command || "—")),
          e.can_toggle
            ? h("button", { class: "btn small", disabled: !a.online || busy, onclick: () => su.toggle(e, e.enabled === false) }, busy ? "…" : e.enabled === false ? "Enable" : "Disable")
            : null);
      }))),
    !shown.length ? h("div", { class: "empty" }, "Nothing starts automatically on this PC.") : null,
    hidden ? h("div", { class: "sub", style: { marginTop: "10px" } }, `${plural(hidden, "Windows task")} hidden.`) : null,
  ];
}

const SU = { data: null, loading: false, query: "", showMs: false, open: new Set() };
async function loadFleetStartup(scan) {
  SU.loading = scan ? "scan" : "load";
  paintFleetStartup();
  try {
    SU.data = scan ? await api("POST", "/api/startup/scan", {}) : await api("GET", "/api/startup/fleet");
    if (scan) {
      toast(`Scanned ${plural(SU.data.scanned_now, "computer")}`);
      SU.data.errors?.slice(0, 3).forEach((e) => toast(e, true));
    }
  } catch (e) {
    fail(e);
  }
  SU.loading = false;
  paintFleetStartup();
}
function renderStartupView(main, full) {
  if (!full && main.dataset.view === "startup") return;
  main.dataset.view = "startup";
  put(main, h("div", { id: "startup-view" }));
  paintFleetStartup();
  if (!SU.data && !SU.loading) loadFleetStartup(false);
}
function paintFleetStartup() {
  const root = $("#startup-view");
  if (!root) return;
  const online = [...S.agents.values()].filter((a) => a.online).length;
  const data = SU.data;
  const q = SU.query.trim().toLowerCase();
  const rows = (data?.entries ?? []).filter((e) => (SU.showMs || !e.microsoft) && (!q || e.name.toLowerCase().includes(q) || e.command.toLowerCase().includes(q)));
  const toggleAll = (e, enable) => {
    const ids = e.pcs.filter((p) => S.agents.get(p.id)?.online && (enable ? p.enabled === false : p.enabled !== false)).map((p) => p.id);
    if (!ids.length) return toast(enable ? "Already enabled on every online PC that has it" : "Not enabled on any online PC that has it", true);
    if (!confirm(`${enable ? "Enable" : "Disable"} “${e.name}” at startup on ${plural(ids.length, "online computer")}?`)) return;
    createJob({ kind: "startup", targets: ids, payload: { kind: e.kind, scope: e.scope, name: e.name, task_path: e.task_path, enable } });
  };
  const search = h("input", { type: "search", class: "search", placeholder: "Search name or command…", value: SU.query, oninput: (ev) => { SU.query = ev.target.value; paintFleetStartup(); const i = $("#startup-view input[type=search]"); i?.focus(); i?.setSelectionRange(SU.query.length, SU.query.length); } });
  put(root,
    h("div", { class: "page-head" }, h("h1", {}, "Startup apps"), h("div", { class: "spacer" }),
      h("button", { class: "btn primary", disabled: !online || !!SU.loading, onclick: () => loadFleetStartup(true) }, SU.loading === "scan" ? "Scanning…" : `Scan ${plural(online, "online computer")}`)),
    h("p", { class: "sub", style: { marginTop: "-6px", marginBottom: "14px" } },
      data ? `${plural(data.scanned, "computer")} of ${data.pcs} scanned. ` : "",
      "What starts with Windows on your PCs and how many have it. Click an entry to see the PCs; open a PC → Startup to change just that one."),
    h("div", { class: "card" },
      h("div", { class: "toolbar" }, search, h("div", { class: "chips" }, h("button", { class: `chip${SU.showMs ? " active" : ""}`, onclick: () => { SU.showMs = !SU.showMs; paintFleetStartup(); } }, "Show Windows tasks"))),
      !data
        ? h("div", { class: "empty" }, SU.loading ? "Loading…" : "")
        : !data.scanned
          ? h("div", { class: "empty" }, h("b", {}, "No computer scanned yet"), "Scan the online computers to list their startup apps.")
          : h("table", { class: "startup-table" },
              h("thead", {}, h("tr", {}, h("th", {}, "Entry"), h("th", { class: "hide-sm" }, "Type"), h("th", {}, "PCs"), h("th", {}, "Enabled"), h("th", {}))),
              h("tbody", {}, rows.map((e) => [
                h("tr", { onclick: () => { SU.open.has(e.key) ? SU.open.delete(e.key) : SU.open.add(e.key); paintFleetStartup(); } },
                  h("td", { style: { maxWidth: "460px" } }, h("b", {}, e.name), h("div", { class: "sub mono startup-cmd" }, e.command || "—", e.variants > 1 ? ` (+${e.variants - 1} other command${e.variants > 2 ? "s" : ""})` : "")),
                  h("td", { class: "hide-sm" }, STARTUP_KIND[e.kind], h("div", { class: "sub" }, e.kind === "task" ? e.task_path : e.scope === "user" ? "per user" : e.scope === "machine32" ? "all users (32-bit)" : "all users")),
                  h("td", {}, h("b", {}, e.count), h("span", { class: "sub" }, ` / ${data.scanned}`)),
                  h("td", {}, e.enabled_count === e.count ? h("span", { class: "pill ok" }, "all") : e.enabled_count === 0 ? h("span", { class: "pill" }, "none") : h("span", { class: "pill warn" }, `${e.enabled_count} of ${e.count}`)),
                  h("td", { style: { whiteSpace: "nowrap", textAlign: "right" } },
                    e.can_toggle && e.enabled_count ? h("button", { class: "btn small", onclick: (ev) => { ev.stopPropagation(); toggleAll(e, false); } }, "Disable on all") : null,
                    e.can_toggle && e.enabled_count < e.count ? h("button", { class: "btn small ghost", onclick: (ev) => { ev.stopPropagation(); toggleAll(e, true); } }, "Enable") : null)),
                SU.open.has(e.key)
                  ? h("tr", { class: "startup-pcs" }, h("td", { colspan: 5 }, h("div", { class: "pcs-chips" }, e.pcs.slice().sort(byHost).map((p) => {
                      const a = S.agents.get(p.id);
                      return h("button", { class: "chip", onclick: (ev) => { ev.stopPropagation(); openDevice(p.id, "startup"); } },
                        h("span", { class: `dot${a?.online ? " on" : ""}` }), " ", a?.hostname ?? p.hostname, p.enabled === false ? " (off)" : "");
                    }))))
                  : null,
              ])),
            ),
      data && data.scanned && !rows.length ? h("div", { class: "empty" }, "Nothing matches.") : null,
    ),
  );
}

// ---------------------------------------------------------------- activity --
function renderActivity(main) {
  const jobs = [...S.jobs.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  put(main, 
    pageHead("Activity", "Everything sent to the computers, with a result for each one."),
    h(
      "div",
      { class: "card" },
      jobs.length
        ? jobs.map((j) =>
            h(
              "div",
              { class: "job", onclick: () => openJob(j.id) },
              h("div", { class: "grow" }, h("div", { class: "title" }, j.title), jobResultLine(j), h("div", { class: "sub" }, `${ago(j.created_at)} · ${plural(Object.keys(j.targets).length, "computer")}${j.by ? ` · ${j.by}` : ""}`)),
              summaryBar(j, false),
              statePill(overallState(j)),
            ),
          )
        : h("div", { class: "empty" }, h("b", {}, "Nothing yet"), "Installs, scripts and messages you send show up here with a result for every computer."),
    ),
    h("h3", { style: { margin: "24px 0 10px" } }, "Log"),
    h("div", { class: "card log" }, [...S.log].reverse().slice(0, 200).map((l) => h("div", {}, h("time", {}, new Date(l.at).toLocaleTimeString()), l.message))),
  );
}
/** Order in which missing checklist items are run. */
const CLEAN_ORDER = ["repair_updates", "check_updates", "install_updates", "security_baseline", "security_status", "adblock", "cleanup", "accounts_list"];
/** Open Apply changes with exactly what the checklist still needs on these PCs. */
function runMissing(ids) {
  const need = new Set();
  for (const id of ids) for (const it of S.agents.get(id)?.clean?.items ?? []) if (!it.ok) need.add(it.id === "accounts" ? "accounts_list" : it.id);
  if (!need.size) return toast("Nothing missing: every check already passed");
  AP.steps = [];
  CLEAN_ORDER.filter((t) => need.has(t)).forEach((t) => apAdd(`task:${t}`));
  AP.name = "Finish the clean checklist";
  openApply(ids);
}
/** The clean checklist of a PC: green ✓ per item met, with the detail. */
function cleanChecklist(a, { button = true } = {}) {
  const c = a.clean;
  if (!c) return null;
  return h("div", { class: "checklist" },
    h("div", { class: "ck-head" },
      h("span", { class: `ck-count${c.ok ? " ok" : ""}` }, `${c.done}/${c.total}`),
      h("span", { class: "grow" }, c.ok ? (a.cleaned ? "Every check passed — cleaned" : "Every check passed") : `${c.total - c.done} to go before this PC counts as cleaned`),
      button && !c.ok ? h("button", { class: "btn small primary", onclick: () => runMissing([a.id]) }, icon("play", 14), "Run what's missing") : null),
    h("ul", { class: "ck-list" }, c.items.map((it) =>
      h("li", { class: it.ok ? "ok" : "" },
        h("span", { class: "ck-mark" }, icon(it.ok ? "check" : "x", 13)),
        h("span", { class: "grow" }, h("b", {}, it.label), h("span", { class: "sub" }, ` — ${it.detail}${it.at ? ` · ${ago(it.at)}` : ""}`))))));
}

/** The result in one coloured line, for lists. */
function jobResultLine(j) {
  const r = jobResult(j);
  return h("span", { class: `job-result ${r.tone}` }, icon({ ok: "checkCircle", bad: "alert", warn: "clock", running: "activity" }[r.tone] ?? "activity", 13), h("span", {}, r.headline, r.text ? h("span", { class: "jr-text" }, ` — ${r.text}`) : null));
}
function overallState(j) {
  const c = j.counts;
  if (c.sending || c.installing || c.running || c.preparing) return "running";
  if (c.queued) return "queued";
  if (c.waiting) return "waiting";
  if (c.failed) return "failed";
  if (c.succeeded) return "succeeded";
  if (c.cancelled) return "cancelled";
  return "skipped";
}

// ---------------------------------------------------------------- settings --

/** "Add computers": the agent is compiled on this master (address built in). */
function fillAgentCard(card, pkgInput) {
  const m = S.master;
  const pkg = m.agent_package;
  const b = m.agent_build ?? { state: "unavailable" };
  const building = b.state === "building";
  const outdated = [...S.agents.values()].filter((a) => a.outdated);
  const status = {
    building: h("div", { class: "note info" }, `Compiling the agent for ${m.public_url}… (started ${ago(b.started_at)}; the first build takes a few minutes)`),
    failed: h("div", { class: "note" }, h("b", {}, "The agent build failed: "), b.error ?? "unknown error"),
    unavailable: h("div", { class: "note" }, "The agent's sources are not next to this master, so it can't be compiled here. Upload a built fleetview-agent.exe instead."),
  }[b.state];
  put(
    card,
    h("h3", {}, "Add computers"),
    h("p", { class: "sub" }, "Run the agent installer on each PC (double-click, or ", h("code", {}, "/S"), " for silent). It installs a background service and a tray icon, and connects to ", h("b", {}, m.agent_address || m.public_url), "."),
    pkg && !building
      ? h("a", { class: "btn primary", href: "/api/agent-package/setup", download: true }, `Download agent installer ${pkg.version}`)
      : null,
    status,
    building || (b.state === "failed" && b.log) ? h("pre", { class: "build-log mono" }, b.log || "starting cargo…") : null,
    h(
      "div",
      { style: { marginTop: "10px", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" } },
      b.state !== "unavailable"
        ? h("button", { class: "btn small", disabled: building, onclick: () => api("POST", "/api/agent-package/build").then(() => toast("Agent build started")).catch(fail) }, pkg ? "Rebuild agent" : "Build agent")
        : null,
      b.state === "unavailable" || b.state === "failed" ? h("button", { class: "btn small ghost", onclick: () => pkgInput.click() }, "Upload a built agent…") : null,
      pkgInput,
      b.built_at && !building ? h("span", { class: "sub" }, `built ${ago(b.built_at)} (${b.target})`) : null,
    ),
    pkg && !building && outdated.length
      ? h("div", { style: { marginTop: "16px" } }, h("p", { class: "sub" }, `${plural(outdated.length, "computer")} run an older agent.`), h("button", { class: "btn", onclick: () => createJob({ kind: "update", targets: outdated.map((a) => a.id), wait_offline: true }) }, `Update ${plural(outdated.length, "agent")} to ${pkg.version}`))
      : null,
  );
  card._pkgInput = pkgInput;
  const log = card.querySelector(".build-log");
  if (log) requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
  return card;
}

/** Bring over the desktop master's identity, so its agents trust this one. */
function importCard() {
  const settings = h("input", { type: "file", accept: ".json" });
  const known = h("input", { type: "file", accept: ".json" });
  const run = async () => {
    const s = settings.files[0];
    if (!s) return toast("Choose master.settings.json", true);
    if (!confirm("Replace this master's identity with the desktop master's?\n\nPCs that were set up from this master's own installers will stop trusting it; PCs of the desktop master will connect here.")) return;
    try {
      const r = await api("POST", "/api/import-desktop-master", { settings: await s.text(), known: known.files[0] ? await known.files[0].text() : null });
      toast(`Imported ${r.name}${r.pcs ? ` and ${plural(r.pcs, "PC")}` : ""}`);
      await loadState();
      go("settings");
    } catch (e) {
      fail(e);
    }
  };
  return h(
    "div",
    { class: "card card-pad", style: { marginTop: "16px" } },
    h("h3", {}, "Move PCs from the desktop master"),
    h("p", { class: "sub" }, "Agents trust a master's certificate, not its address. Upload the old desktop master's files from ", h("code", {}, "%APPDATA%\\FleetView"), " and its PCs will connect here as soon as they run agent 0.6 (update them from the old master). Stop the desktop master afterwards."),
    h("label", { class: "field" }, "master.settings.json (required)"),
    settings,
    h("label", { class: "field" }, "known_agents.json (optional: the PC list and their pinned keys)"),
    known,
    h("div", { style: { marginTop: "12px" } }, h("button", { class: "btn", onclick: run }, "Import")),
  );
}

/** What the master's automatic e-Management sync found on a PC. */
function emgText(e) {
  if (!S.master?.emanagement_url) return "no e-Management URL on the master";
  if (!e) return "checked when the PC connects";
  return {
    ok: "on — settings match the master",
    fixed: `was missing — set by the master ${ago(e.at)} (agent restarted)`,
    pending: "being applied — the agent is restarting",
    error: `couldn't set it: ${e.detail}`,
    unsupported: e.detail,
  }[e.state] ?? e.state;
}

/** Show freshly made recovery codes once; `done` repaints the card. */
function showRecoveryCodes(card, codes, done) {
  const text = `FleetView recovery codes (${location.host}, made ${new Date().toLocaleString()})\n` +
    "Each code works once, in place of an authenticator code.\n\n" + codes.join("\n") + "\n";
  const saved = h("input", { type: "checkbox" });
  const finish = h("button", { class: "btn primary", disabled: true, onclick: () => done() }, "Done");
  saved.addEventListener("change", () => (finish.disabled = !saved.checked));
  put(
    card,
    h("h3", {}, "Save your recovery codes"),
    h("p", { class: "sub" }, "If you lose your phone, each of these codes signs you in once instead of an authenticator code. Keep them somewhere safe and offline (printed, or in another password manager). They won't be shown again."),
    h("div", { class: "recovery-codes mono" }, codes.map((c) => h("span", {}, c))),
    h("div", { class: "row", style: { marginTop: "12px", flexWrap: "wrap" } },
      h("button", { class: "btn", onclick: () => navigator.clipboard.writeText(text).then(() => toast("Copied")).catch(fail) }, "Copy"),
      h("button", { class: "btn", onclick: () => {
        const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/plain" })), download: "fleetview-recovery-codes.txt" });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      } }, "Download .txt"),
      h("button", { class: "btn", onclick: () => window.print() }, "Print")),
    h("label", { class: "check", style: { marginTop: "14px", display: "flex", gap: "8px", alignItems: "center" } }, saved, "I've saved these codes"),
    h("div", { style: { marginTop: "10px" } }, finish),
  );
}

// ---- Security: two-step sign-in (TOTP) ----
function securityCard() {
  const card = h("div", { class: "card card-pad", style: { marginTop: "16px" } });
  const paint = async () => {
    let me;
    try {
      me = await api("GET", "/api/me");
    } catch {
      return;
    }
    const pw = h("input", { type: "password", autocomplete: "current-password", placeholder: "Console password" });
    const code = h("input", { type: "text", autocomplete: "one-time-code", placeholder: "Code", class: "code-input" });
    if (me.totp_enabled) {
      const pw2 = h("input", { type: "password", autocomplete: "current-password", placeholder: "Console password" });
      const code2 = h("input", { type: "text", autocomplete: "one-time-code", placeholder: "Code", class: "code-input" });
      const left = me.recovery_left ?? 0;
      put(
        card,
        h("h3", {}, "Two-step sign-in ", h("span", { class: "pill ok" }, "On")),
        h("p", { class: "sub" }, "Signing in needs your password and a code from your authenticator app. The password vault requires it."),
        h(
          "p",
          { class: left > 2 ? "sub" : "note" },
          left
            ? `Recovery codes: ${left} of 10 left. Each one replaces an authenticator code once, e.g. if you lose your phone.`
            : "No recovery codes left: if you lose your phone you can only get in through the server. Make new ones below.",
        ),
        h("details", { open: left === 0 }, h("summary", { class: "sub" }, "Make new recovery codes…"),
          h("p", { class: "sub" }, "The old codes stop working."),
          h("div", { class: "row", style: { marginTop: "10px", flexWrap: "wrap" } }, pw2, code2,
            h("button", { class: "btn", onclick: async () => {
              try {
                const r = await api("POST", "/api/2fa/recovery", { password: pw2.value, code: code2.value });
                showRecoveryCodes(card, r.recovery_codes, paint);
              } catch (e) { fail(e); }
            } }, "Make new codes"))),
        h("details", {}, h("summary", { class: "sub" }, "Turn it off…"),
          h("div", { class: "row", style: { marginTop: "10px", flexWrap: "wrap" } }, pw, code,
            h("button", { class: "btn danger", onclick: async () => {
              if (!confirm("Turn off two-step sign-in? The password vault will be unavailable until you turn it on again.")) return;
              try { await api("POST", "/api/2fa/disable", { password: pw.value, code: code.value }); toast("Two-step sign-in is off"); paint(); } catch (e) { fail(e); }
            } }, "Turn off"))),
      );
      return;
    }
    put(
      card,
      h("h3", {}, "Two-step sign-in ", h("span", { class: "pill warn" }, "Off")),
      h("p", { class: "sub" }, "Protects the console with a 6-digit code from an authenticator app (Microsoft Authenticator, Google Authenticator, Aegis, 1Password…). Required for the password vault."),
      h("div", { class: "row", style: { flexWrap: "wrap" } }, pw,
        h("button", { class: "btn primary", onclick: async () => {
          let r;
          try { r = await api("POST", "/api/2fa/setup", { password: pw.value }); } catch (e) { return fail(e); }
          const { qrSvg } = await import("./qr.js");
          const confirmCode = h("input", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", placeholder: "123456", class: "code-input" });
          put(
            card,
            h("h3", {}, "Set up two-step sign-in"),
            h("ol", { class: "steps" },
              h("li", {}, "Open your authenticator app and add an account by scanning this code:"),
            ),
            h("div", { class: "qr" }, qrSvg(r.uri, 4)),
            h("p", { class: "sub" }, "Can't scan? Enter this key by hand (time-based, 6 digits):"),
            h("div", { class: "secret mono" }, r.secret.replace(/(.{4})/g, "$1 ").trim()),
            h("p", { class: "sub" }, "On this phone? ", h("a", { href: r.uri }, "Add to authenticator")),
            h("label", { class: "field" }, "Then type the code the app shows"),
            h("div", { class: "row" }, confirmCode,
              h("button", { class: "btn primary", onclick: async () => {
                try {
                  const r = await api("POST", "/api/2fa/confirm", { code: confirmCode.value });
                  toast("Two-step sign-in is on");
                  showRecoveryCodes(card, r.recovery_codes, paint);
                } catch (e) { fail(e); }
              } }, "Turn on"),
              h("button", { class: "btn ghost", onclick: paint }, "Cancel")),
          );
          setTimeout(() => confirmCode.focus(), 0);
        } }, "Set up…")),
    );
  };
  paint();
  return card;
}

function renderSettings(main, full) {
  if (!full && main.dataset.view === "settings") return;
  main.dataset.view = "settings";
  const m = S.master;
  const pkg = m.agent_package;
  const outdated = [...S.agents.values()].filter((a) => a.outdated);
  const pkgInput = h("input", {
    type: "file",
    accept: ".exe",
    class: "hidden",
    onchange: async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const res = await fetch("/api/agent-package", { method: "PUT", headers: { "X-FleetView": "1" }, body: f });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        toast(`Agent package ${data.version} ready`);
        await loadState();
        go("settings");
      } catch (ex) {
        fail(ex);
      }
    },
  });
  put(main, 
    pageHead("Settings", "The master, the agent installer and your sign-in."),
    h(
      "div",
      { class: "grid2" },
      fillAgentCard(h("div", { class: "card card-pad", id: "agent-card" }), pkgInput),
      h(
        "div",
        { class: "card card-pad" },
        h("h3", {}, "This master"),
        h(
          "div",
          { class: "kv" },
          h("span", {}, "Name"), h("b", {}, m.name),
          h("span", {}, "Console URL"), h("b", {}, m.public_url),
          h("span", {}, "Direct agent port"), h("b", {}, m.agent_port ? `${m.agent_port} (TLS, agents before 0.6)` : "off"),
          h("span", {}, "Agents connect to"), h("b", {}, m.agent_address || "LAN discovery"),
          h("span", {}, "e-Management URL"), h("b", {}, m.emanagement_url || h("span", { class: "pill warn" }, "not set — new agents get no MoldSign bridge"), " ",
            m.emanagement_url ? h("span", { class: "sub" }, `· kept on every PC automatically (${[...S.agents.values()].filter((x) => x.emanagement?.state === "ok" || x.emanagement?.state === "fixed").length} in sync)`) : null, " ",
            m.emanagement_from_env ? h("span", { class: "sub" }, "(from .env)") : h("button", { class: "btn small ghost", onclick: openEmanagementSetting }, "Change")),
          h("span", {}, "LAN discovery"), h("b", {}, m.discovery ? "on" : "off"),
          h("span", {}, "Certificate"), h("b", { class: "mono" }, m.fingerprint),
          h("span", {}, "Version"), h("b", {}, m.version),
        ),
        h("p", { class: "sub", style: { marginTop: "12px" } }, "These come from the master's .env file (see README)."),
      ),
    ),
    securityCard(),
    importCard(),
    h(
      "div",
      { class: "card card-pad", style: { marginTop: "16px" } },
      h("h3", {}, "Uploaded installers"),
      S.installers.length
        ? S.installers.map((i) =>
            h(
              "div",
              { class: "sw" },
              h("div", { class: "grow" }, h("b", {}, i.file_name), h("div", { class: "sub mono" }, `${i.kind_label} · ${fmtSize(i.size)} · ${i.is_msi ? "msiexec /i … " : ""}${i.args}`)),
              h("button", { class: "btn small", onclick: () => openInstall({ installerId: i.id }) }, "Install…"),
              h("button", { class: "btn small ghost danger", onclick: () => confirm(`Delete ${i.file_name} from the master?`) && api("DELETE", `/api/installers/${i.id}`).then(() => { S.installers = S.installers.filter((x) => x.id !== i.id); renderSettings(main, true); }).catch(fail) }, "Delete"),
            ),
          )
        : h("p", { class: "sub" }, "None yet — use “Install software”."),
    ),
  );
}

boot().catch((e) => (e.message === "sign in first" ? null : fail(e)));
