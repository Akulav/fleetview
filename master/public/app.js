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
  view: "computers",
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
    h("div", { class: "login" }, h("div", { class: "card" }, h("img", { src: "/favicon.png", alt: "" }), h("h1", {}, "FleetView"), h("p", {}, "Sign in to manage your computers."), form)),
  );
  setTimeout(() => pw.focus(), 0);
}

// ------------------------------------------------------------------ shell --
function renderShell() {
  const app = $("#app");
  put(app, 
    h(
      "div",
      { class: "topbar" },
      h("div", { class: "brand" }, h("img", { src: "/favicon.png", alt: "" }), "FleetView", h("small", {}, S.master?.name ?? "")),
      h("nav", { class: "tabs", id: "tabs" }),
      h("div", { class: "spacer" }),
      h("button", { class: "btn", onclick: () => openTasks() }, "Maintenance"),
      h("button", { class: "btn primary", onclick: () => openInstall() }, "＋ Install software"),
      h("span", { class: "who" }, S.user),
      h(
        "button",
        {
          class: "btn ghost small",
          title: "Light / dark",
          onclick: () => {
            const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
            const next = cur === "dark" ? "light" : "dark";
            document.documentElement.dataset.theme = next;
            safeSet("fv-theme", next);
          },
        },
        "◐",
      ),
      h(
        "button",
        {
          class: "btn ghost small",
          onclick: async () => {
            lockVault();
            await api("POST", "/api/logout").catch(() => {});
            showLogin();
          },
        },
        "Sign out",
      ),
    ),
    h("main", { id: "main" }),
    h("div", { id: "drawer-root" }),
  );
  renderTabs();
  renderMain(true);
}

function renderTabs() {
  const nav = $("#tabs");
  if (!nav) return;
  const running = [...S.jobs.values()].filter((j) => ["queued", "preparing", "sending", "installing", "running"].some((s) => j.counts[s])).length;
  const tab = (id, label, count) =>
    h("button", { class: `tab${S.view === id ? " active" : ""}`, onclick: () => go(id) }, label, count ? h("span", { class: "count" }, count) : null);
  put(nav, tab("computers", "Computers"), tab("scripts", "Scripts"), tab("startup", "Startup"), tab("vault", "Passwords"), tab("activity", "Activity", running), tab("settings", "Settings"));
}

function go(view) {
  S.view = view;
  renderTabs();
  renderMain(true);
}

function renderMain(full = false) {
  const main = $("#main");
  if (!main) return;
  if (S.view === "computers") return renderComputers(main, full);
  if (S.view === "activity") return renderActivity(main);
  if (S.view === "settings") return renderSettings(main, full);
  if (S.view === "scripts") return renderScripts(main, full);
  if (S.view === "startup") return renderStartupView(main, full);
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

// -------------------------------------------------------------- computers --
function filteredAgents() {
  const q = S.query.trim().toLowerCase();
  return [...S.agents.values()]
    .filter((a) => {
      if (S.filter === "online" && !a.online) return false;
      if (S.filter === "offline" && a.online) return false;
      if (S.filter === "outdated" && !a.outdated) return false;
      if (!q) return true;
      return [a.hostname, a.user, a.ip, a.os, ...(a.tags ?? [])].some((x) => String(x ?? "").toLowerCase().includes(q));
    })
    .sort((a, b) => (b.online - a.online) || a.hostname.localeCompare(b.hostname));
}

function renderComputers(main, full) {
  const agents = [...S.agents.values()];
  const online = agents.filter((a) => a.online).length;
  const outdated = agents.filter((a) => a.outdated).length;
  const failing = [...S.jobs.values()].filter((j) => j.counts.failed).length;
  const stats = h(
    "div",
    { class: "stats", id: "stats" },
    h("div", { class: "stat" }, h("b", {}, `${online} / ${agents.length}`), h("span", {}, "computers online")),
    h("div", { class: "stat" }, h("b", {}, [...S.jobs.values()].filter((j) => j.counts.installing || j.counts.sending || j.counts.running).length), h("span", {}, "actions running")),
    h("div", { class: "stat" }, h("b", {}, failing), h("span", {}, "recent actions with failures")),
    h("div", { class: "stat" }, h("b", {}, outdated), h("span", {}, "agents to update")),
  );

  if (full || !$("#devtable")) {
    const search = h("input", {
      type: "search",
      class: "search",
      placeholder: "Search name, user, IP, tag…",
      value: S.query,
      oninput: (e) => {
        S.query = e.target.value;
        renderRows();
      },
    });
    const chip = (id, label) =>
      h("button", { class: `chip${S.filter === id ? " active" : ""}`, onclick: () => { S.filter = id; renderComputers(main, true); } }, label);
    put(main, 
      h("div", { class: "page-head" }, h("h1", {}, "Computers")),
      stats,
      h(
        "div",
        { class: "card" },
        h("div", { class: "toolbar" }, search, h("div", { class: "chips" }, chip("all", "All"), chip("online", "Online"), chip("offline", "Offline"), chip("outdated", "Agent outdated"))),
        h(
          "table",
          { id: "devtable" },
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
              h("th", {}, "Computer"),
              h("th", { class: "hide-sm" }, "User"),
              h("th", { class: "hide-sm" }, "CPU"),
              h("th", { class: "hide-sm" }, "Memory"),
              h("th", { class: "hide-sm" }, "Disk"),
              h("th", { class: "hide-sm" }, "Agent"),
            ),
          ),
          h("tbody", { id: "devrows" }),
        ),
      ),
      h("div", { id: "selbar-root" }),
    );
  } else {
    $("#stats").replaceWith(stats);
  }
  renderRows();
}

function meter(pct) {
  if (pct == null) return h("span", { class: "sub" }, "—");
  const m = h("span", { class: `meter${pct >= 90 ? " hot" : pct >= 75 ? " warm" : ""}` }, h("i", { style: { width: `${pct}%` } }));
  return h("span", {}, m, `${pct}%`);
}

function renderRows() {
  const tbody = $("#devrows");
  if (!tbody) return;
  const list = filteredAgents();
  for (const id of [...S.selected]) if (!S.agents.has(id)) S.selected.delete(id);
  if (!list.length) {
    put(tbody, 
      h(
        "tr",
        {},
        h(
          "td",
          { colspan: 7 },
          h(
            "div",
            { class: "empty" },
            S.agents.size
              ? [h("b", {}, "No computers match"), "Try another search or filter."]
              : [h("b", {}, "No computers yet"), "Download the agent installer in Settings and run it on each PC. They appear here within seconds."],
          ),
        ),
      ),
    );
  } else {
    put(tbody, 
      ...list.map((a) =>
        h(
          "tr",
          { class: S.selected.has(a.id) ? "selected" : "", onclick: (e) => { if (e.target.type !== "checkbox") openDevice(a.id); } },
          h("td", { class: "cb" }, h("input", { type: "checkbox", checked: S.selected.has(a.id), onclick: (e) => {
            e.stopPropagation();
            e.target.checked ? S.selected.add(a.id) : S.selected.delete(a.id);
            renderRows();
          } })),
          h(
            "td",
            {},
            h("div", { class: "host" }, h("span", { class: `dot${a.online ? " on" : ""}` }), a.hostname,
              a.pending_name ? h("span", { class: "pill warn", style: { marginLeft: "6px" }, title: "The new name takes effect when the PC restarts" }, `→ ${a.pending_name} · restart pending`) : null),
            h("div", { class: "sub" }, a.online ? [a.ip, a.os].filter(Boolean).join(" · ") : `offline · seen ${ago(a.last_seen)}`),
          ),
          h("td", { class: "hide-sm" }, a.user ? a.user.split("\\").pop() : h("span", { class: "sub" }, "—")),
          h("td", { class: "hide-sm" }, a.online ? meter(a.cpu) : h("span", { class: "sub" }, "—")),
          h("td", { class: "hide-sm" }, meter(a.mem)),
          h("td", { class: "hide-sm" }, meter(a.disk)),
          h("td", { class: "hide-sm" }, a.agent_version || "—", a.outdated ? h("span", { class: "pill warn", style: { marginLeft: "6px" } }, "update") : null,
            a.emanagement && ["error", "unsupported"].includes(a.emanagement.state) ? h("span", { class: "pill bad", style: { marginLeft: "6px" }, title: a.emanagement.detail ?? "" }, "MoldSign ✗") : null),
        ),
      ),
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
      h("b", {}, plural(n, "computer"), " selected"),
      h("button", { class: "btn primary", onclick: () => openInstall({ mode: "selected" }) }, "Install software"),
      h("button", { class: "btn", onclick: () => openTasks({ ids }) }, "Maintenance"),
      h("button", { class: "btn", onclick: () => openAccountsBulk(ids) }, "Accounts"),
      h("button", { class: "btn", onclick: () => openRunScript({ ids }) }, "Run script"),
      h("button", { class: "btn", onclick: () => openScript(ids) }, "PowerShell"),
      h("button", { class: "btn", onclick: () => openRename(ids) }, "Rename"),
      h("button", { class: "btn", onclick: () => openMessage(ids) }, "Message"),
      h("button", { class: "btn", onclick: () => openAgentSettings(ids) }, "Agent settings"),
      h("button", { class: "btn ghost", onclick: () => { S.selected.clear(); renderRows(); } }, "Clear"),
    ),
  );
}

// ---------------------------------------------------------------- drawers --
function openDrawer(d) {
  S.drawer = d;
  const root = $("#drawer-root");
  const close = () => closeDrawer();
  const header = h("header", {}, h("h2", { class: "grow" }, d.title), h("div", { class: "spacer" }), h("button", { class: "btn ghost", onclick: close, title: "Close (Esc)" }, "✕"));
  d.body = h("div", { class: "body" });
  d.footer = h("footer", {});
  put(root, h("div", { class: "scrim", onclick: close }), h("aside", { class: "drawer" }, header, d.body, d.footer));
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
  if (e.key === "Escape" && S.drawer) closeDrawer();
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
  const d = {
    title: "Action",
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
      put(d.body, 
        h("h3", {}, j.title),
        h("div", { class: "sub" }, `${new Date(j.created_at).toLocaleString()} · by ${j.by || "—"}`),
        j.detail ? h("pre", { class: "mono", style: { whiteSpace: "pre-wrap", background: "var(--surface-2)", padding: "10px", borderRadius: "8px" } }, j.detail) : null,
        det.script ? h("details", { style: { marginTop: "10px" } }, h("summary", { class: "sub" }, "Script that ran"), h("pre", { class: "mono script-view" }, det.script)) : null,
        summaryBar(j, true),
        h(
          "div",
          { class: "card card-pad", style: { marginTop: "14px" } },
          rows.map(([aid, t]) => {
            const out = det.targets[aid]?.output;
            const pr = h("div", { class: "progress" }, h("i", { style: { width: `${Math.round((t.progress ?? 0) * 100)}%` } }));
            return h(
              "div",
              { class: "target" },
              h(
                "div",
                { class: "head" },
                h("b", { class: "grow" }, t.hostname),
                h("span", { class: "spacer" }),
                t.exit_code != null ? h("span", { class: "sub mono" }, `exit ${t.exit_code}`) : null,
                statePill(t.state),
              ),
              t.message ? h("div", { class: "msg" }, t.message) : null,
              t.state === "sending" ? pr : null,
              out
                ? h("div", {},
                    h("button", { class: "btn ghost small", style: { marginTop: "6px" }, onclick: () => { open.has(aid) ? open.delete(aid) : open.add(aid); d.paint(); } }, open.has(aid) ? "Hide details" : "Show details"),
                    open.has(aid) ? h("pre", {}, out) : null)
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
function openDevice(id, startTab = "overview") {
  let tab = startTab;
  let detail = null;
  let shot = null;
  let swQuery = "";
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
    return [
      head,
      acc.list.map((u) =>
        h(
          "div",
          { class: "sw" },
          h(
            "div",
            { class: "grow" },
            h("b", {}, u.name),
            " ",
            u.admin ? h("span", { class: "pill blue" }, "Administrator") : null,
            " ",
            !u.enabled ? h("span", { class: "pill" }, "Disabled") : null,
            " ",
            u.builtin ? h("span", { class: "pill" }, "Built-in") : null,
            h("div", { class: "sub" }, [u.full_name, u.last_logon ? `last sign-in ${ago(u.last_logon)}` : "never signed in", u.password_last_set ? `password set ${ago(u.password_last_set)}` : null].filter(Boolean).join(" · ")),
          ),
          h("button", { class: "btn small", onclick: act(u, "set_password") }, "Password"),
          h("button", { class: "btn small", onclick: act(u, "rename") }, "Rename"),
          h("button", { class: "btn small", onclick: act(u, u.enabled ? "disable" : "enable") }, u.enabled ? "Disable" : "Enable"),
          h("button", { class: "btn small", onclick: act(u, u.admin ? "remove_admin" : "add_admin") }, u.admin ? "Not admin" : "Make admin"),
          u.builtin ? null : h("button", { class: "btn small ghost danger", onclick: act(u, "delete") }, "Delete"),
        ),
      ),
    ];
  }
  const d = {
    title: S.agents.get(id)?.hostname ?? "Computer",
    async render() {
      d.paint();
      if (tab === "startup" && !su.list && !su.loading) su.load();
      try {
        detail = await api("GET", `/api/agents/${id}`);
      } catch (e) {
        return fail(e);
      }
      d.paint();
    },
    paint() {
      const a = S.agents.get(id);
      if (!a) return closeDrawer();
      const t = detail?.telemetry;
      const sub = h("div", { class: "subtabs" }, ["overview", "software", "startup", "accounts", "history"].map((k) => h("button", { class: tab === k ? "active" : "", onclick: () => { tab = k; if (k === "accounts" && !acc.list && !acc.loading) loadAccounts(); if (k === "startup" && !su.list && !su.loading) su.load(); d.paint(); } }, { overview: "Overview", software: `Programs (${detail?.software?.length ?? a.software_count})`, startup: "Startup", accounts: "Accounts", history: "History" }[k])));
      const actions = h(
        "div",
        { class: "actions" },
        h("button", { class: "btn primary", onclick: () => openInstall({ ids: [id] }) }, "Install software"),
        h("button", { class: "btn", onclick: () => openTasks({ ids: [id] }) }, "Maintenance"),
        h("button", { class: "btn", onclick: () => openRunScript({ ids: [id] }) }, "Run script"),
        h("button", { class: "btn", onclick: () => openScript([id]) }, "PowerShell"),
        h("button", { class: "btn", onclick: () => openRename([id]) }, "Rename"),
        h("button", { class: "btn", disabled: !a.online, onclick: takeShot }, "Screenshot"),
        h("button", { class: "btn", onclick: () => openMessage([id]) }, "Message"),
        h("button", { class: "btn", onclick: () => openAgentSettings([id]) }, "Agent settings"),
        h("button", { class: "btn ghost", disabled: !a.online, onclick: () => api("POST", `/api/agents/${id}/refresh`).then(() => setTimeout(() => d.render(), 1500)).catch(fail) }, "Refresh"),
      );
      let content;
      if (tab === "overview") {
        const disks = t?.disks?.map((x) => `${x.mount} ${Math.round(x.total_gb - x.available_gb)}/${Math.round(x.total_gb)} GB`).join(", ");
        const fact = (k, v) => h("div", { class: "fact" }, h("span", {}, k), h("b", {}, v ?? "—"));
        content = [
          h(
            "div",
            { class: "facts" },
            fact("Status", a.online ? "Online" : `Offline — seen ${ago(a.last_seen)}`),
            a.pending_name ? fact("Rename", `to ${a.pending_name} — pending restart`) : null,
            fact("User", a.user),
            fact("Windows", a.os),
            fact("IP address", a.ip),
            fact("CPU", t ? `${t.cpu_name} · ${t.cpu_cores} cores · ${a.cpu}%` : null),
            fact("Memory", t ? `${Math.round(t.mem_used_mb / 1024)} / ${Math.round(t.mem_total_mb / 1024)} GB (${a.mem}%)` : null),
            fact("Disks", disks),
            fact("Uptime", uptime(a.uptime_secs)),
            fact("Agent", a.agent_version + (a.outdated ? " (update available)" : "")),
            fact("MoldSign bridge", emgText(a.emanagement)),
            fact("MAC", detail?.macs?.join(", ")),
          ),
          shot ? h("img", { class: "shot", src: shot, alt: "screenshot" }) : null,
          !a.online ? h("div", { style: { marginTop: "16px" } }, h("button", { class: "btn danger", onclick: () => confirm(`Remove ${a.hostname} from the list? It reappears if its agent connects again.`) && api("DELETE", `/api/agents/${id}`).then(closeDrawer).catch(fail) }, "Remove from list")) : null,
        ];
      } else if (tab === "accounts") {
        content = accountsTab(a);
      } else if (tab === "startup") {
        content = startupTab(a, su, () => d.paint());
      } else if (tab === "software") {
        const list = (detail?.software ?? []).filter((s) => !swQuery || s.name.toLowerCase().includes(swQuery.toLowerCase())).sort((x, y) => x.name.localeCompare(y.name));
        content = [
          h("input", { type: "search", placeholder: "Search programs…", value: swQuery, oninput: (e) => { swQuery = e.target.value; const pos = e.target.selectionStart; d.paint(); const i = $(".drawer input[type=search]"); i?.focus(); i?.setSelectionRange(pos, pos); } }),
          detail?.software_at ? h("div", { class: "sub", style: { margin: "6px 0" } }, `List from ${ago(detail.software_at)}`) : null,
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
      put(d.body, actions, sub, ...[content].flat());
      put(d.footer, h("span", { class: "sub" }, `${a.hostname} · id ${id}`));
    },
    live() {
      // Don't repaint under the user's typing (search box, account form).
      if (settleToggles() || (tab !== "software" && !(tab === "accounts" && acc.form))) d.paint();
    },
  };
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
  openDrawer(d);
}

async function createJob(body) {
  try {
    const { job } = await api("POST", "/api/jobs", body);
    S.jobs.set(job.id, job);
    openJob(job.id);
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
  const st = { task: task ?? "check_updates", waitOffline: true, delay: 5, message: "" };
  const byId = new Map(S.tasks.map((t) => [t.id, t]));
  const choose = (id) => {
    st.task = id;
    const t = byId.get(id);
    st.waitOffline = !POWER.has(id); // a restart queued for days would surprise people
    st.delay = t.options?.delay_min ?? 5;
    st.message = t.options?.message ?? "";
    d.render();
  };
  const d = {
    title: "Maintenance",
    render() {
      const t = byId.get(st.task);
      const groups = [...new Set(S.tasks.map((x) => x.group))];
      put(
        d.body,
        h(
          "div",
          { class: "step" },
          h("div", { class: "step-title" }, h("span", { class: "step-num" }, "1"), "Task"),
          groups.map((g) =>
            h(
              "div",
              {},
              h("div", { class: "sub", style: { margin: "10px 0 6px", fontWeight: "600" } }, g),
              h("div", { class: "lib" }, S.tasks.filter((x) => x.group === g).map((x) =>
                h("button", { class: `lib-item${st.task === x.id ? " active" : ""}`, onclick: () => choose(x.id) },
                  h("span", { class: "name" }, x.label),
                  h("span", { class: "sub" }, x.minutes >= 30 ? `up to ${x.minutes >= 60 ? `${Math.round(x.minutes / 60)} h` : `${x.minutes} min`}` : "")),
              )),
            ),
          ),
          h("div", { class: "note info" }, t.help),
          t.options
            ? h(
                "div",
                { class: "grid2", style: { marginTop: "10px" } },
                h("div", {}, h("label", { class: "field" }, "Warning time (minutes)"), h("input", { type: "text", value: String(st.delay), oninput: (e) => (st.delay = e.target.value) })),
                h("div", {}, h("label", { class: "field" }, "Message to the user"), h("input", { type: "text", value: st.message, oninput: (e) => (st.message = e.target.value) })),
              )
            : null,
        ),
        h("div", { class: "step" }, h("div", { class: "step-title" }, h("span", { class: "step-num" }, "2"), "Computers"), targetPicker(tg, () => d.render())),
        h(
          "label",
          { class: "check" },
          h("input", { type: "checkbox", checked: st.waitOffline, onchange: (e) => { st.waitOffline = e.target.checked; d.footerRender(); } }),
          h("span", {}, "Run on offline computers when they come back"),
        ),
      );
      d.footerRender();
    },
    footerRender() {
      const n = targetIds(tg).length;
      const t = byId.get(st.task);
      put(
        d.footer,
        h(
          "button",
          {
            class: "btn primary big",
            disabled: !n,
            onclick: async (e) => {
              if ((st.task === "restart" || st.task === "shutdown") && !confirm(`${t.label} ${plural(n, "computer")} in ${st.delay} min?`)) return;
              e.target.disabled = true;
              const options = t.options ? { delay_min: Number(st.delay) || 0, message: st.message } : {};
              await createJob({ kind: "task", targets: targetParam(tg), wait_offline: st.waitOffline, payload: { task: st.task, options } });
            },
          },
          n ? `${t.label} on ${plural(n, "computer")}` : "Choose computers",
        ),
        h("span", { class: "sub" }, offlineNote(tg, st.waitOffline)),
      );
    },
    live() {
      d.footerRender();
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
function renderScripts(main, full) {
  if (!full && main.dataset.view === "scripts") return;
  main.dataset.view = "scripts";
  const list = [...S.scripts].sort((a, b) => a.name.localeCompare(b.name));
  put(main,
    h("div", { class: "page-head" }, h("h1", {}, "Scripts"), h("div", { class: "spacer" }), h("button", { class: "btn primary", onclick: () => openScriptEditor() }, "＋ New script")),
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
    h("div", { class: "page-head" }, h("h1", {}, "Activity")),
    h(
      "div",
      { class: "card" },
      jobs.length
        ? jobs.map((j) =>
            h(
              "div",
              { class: "job", onclick: () => openJob(j.id) },
              h("div", { class: "grow" }, h("div", { class: "title" }, j.title), h("div", { class: "sub" }, `${ago(j.created_at)} · ${plural(Object.keys(j.targets).length, "computer")}${j.by ? ` · ${j.by}` : ""}`)),
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
    h("div", { class: "page-head" }, h("h1", {}, "Settings")),
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
