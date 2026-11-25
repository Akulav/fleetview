// Password vault UI. Everything sensitive happens here, in the browser:
// the master password, the decrypted entries and the vault key never leave
// this tab; the server only receives the sealed record (see crypto.js).

import { createVault, openVault, sealVault, changeMasterPassword, checkMasterPassword, WrongPassword, generatePassword } from "./crypto.js";
import { entriesFromCsv, entriesToCsv } from "./csv.js";

const AUTO_LOCK_MS = 5 * 60_000;
const CLIPBOARD_CLEAR_MS = 30_000;

let ui; // helpers from app.js: { h, put, api, toast, fail, openDrawer, closeDrawer, openSecurity }
let root; // the <main> element
const V = {
  remote: null, // { exists, revision, record }
  session: null, // { dek, head } while unlocked
  data: null, // decrypted { v, groups, entries } while unlocked
  group: "all", // "all" | "fav" | "recent" | group id
  query: "",
  selected: null, // entry id
  idleTimer: null,
};

const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("");
const now = () => new Date().toISOString();

// ------------------------------------------------------------- lifecycle --

export async function renderVault(main, helpers) {
  ui = helpers;
  root = main;
  if (V.session) return paintUnlocked();
  const { h, put } = ui;
  put(root, h("div", { class: "page-head" }, h("h1", {}, "Passwords")), h("div", { class: "card card-pad" }, "Loading…"));
  try {
    V.remote = await ui.api("GET", "/api/vault");
  } catch (e) {
    return paintNeedsMfa(e.message);
  }
  if (!V.remote.exists) return paintCreate();
  paintLocked();
}

/** Forget the key and the plaintext (sign-out, idle, the Lock button). */
export function lockVault(reason = "locked") {
  if (!V.session) return;
  V.session = null;
  V.data = null;
  V.selected = null;
  clearTimeout(V.idleTimer);
  document.removeEventListener("pointerdown", bump, true);
  document.removeEventListener("keydown", bump, true);
  ui?.api("POST", "/api/vault/audit", { event: "locked" }).catch(() => {});
  // Repaint only if the vault is on screen (not another tab of the console).
  if (root?.isConnected && root.querySelector(".vault, .vault-gate")) paintLocked(reason === "idle" ? "Locked after 5 minutes without activity." : "");
  // An open vault drawer (edit form, import preview) shows plaintext: close it.
  if (document.querySelector(".drawer[data-vault]")) ui?.closeDrawer?.();
}

/** Open a drawer marked as the vault's, so locking can close it. */
function openVaultDrawer(d) {
  ui.openDrawer(d);
  document.querySelector(".drawer")?.setAttribute("data-vault", "1");
}

function bump() {
  clearTimeout(V.idleTimer);
  V.idleTimer = setTimeout(() => lockVault("idle"), AUTO_LOCK_MS);
}

function startSession(session, data) {
  V.session = session;
  V.data = normalize(data);
  document.addEventListener("pointerdown", bump, true);
  document.addEventListener("keydown", bump, true);
  bump();
}

function normalize(d) {
  return { v: 1, groups: Array.isArray(d?.groups) ? d.groups : [], entries: Array.isArray(d?.entries) ? d.entries : [] };
}

/** Encrypt and store the current contents (optimistic concurrency). */
async function save() {
  const record = await sealVault(V.session, V.data);
  try {
    const r = await ui.api("PUT", "/api/vault", { record, base_revision: V.remote.revision });
    V.remote = { exists: true, revision: r.revision, record };
  } catch (e) {
    if (/changed elsewhere/.test(e.message)) {
      ui.toast("The vault was changed in another window — reloading it.", true);
      lockVault();
      V.remote = await ui.api("GET", "/api/vault");
      paintLocked("Changed in another window: unlock again to see the latest version. Your last change was not saved.");
    }
    throw e;
  }
}

// ---------------------------------------------------------------- screens --

function paintNeedsMfa(message) {
  const { h, put } = ui;
  put(
    root,
    h("div", { class: "page-head" }, h("h1", {}, "Passwords")),
    h(
      "div",
      { class: "card card-pad vault-gate" },
      h("div", { class: "gate-icon" }, "🔐"),
      h("h2", {}, "Two-step sign-in comes first"),
      h("p", { class: "sub" }, message),
      h("p", { class: "sub" }, "The vault holds your passwords, so FleetView only opens it for sessions confirmed with an authenticator code."),
      h("button", { class: "btn primary", onclick: ui.openSecurity }, "Open Settings → Security"),
    ),
  );
}

function paintCreate() {
  const { h, put } = ui;
  const pw = h("input", { type: "password", autocomplete: "new-password" });
  const pw2 = h("input", { type: "password", autocomplete: "new-password" });
  const meter = h("div", { class: "strength" }, h("i"));
  pw.addEventListener("input", () => showStrength(meter, pw.value));
  const err = h("div", { class: "err" });
  const btn = h("button", { class: "btn primary big", type: "submit" }, "Create vault");
  put(
    root,
    h("div", { class: "page-head" }, h("h1", {}, "Passwords")),
    h(
      "form",
      {
        class: "card card-pad vault-gate",
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = "";
          if (pw.value.length < 12) return (err.textContent = "Use at least 12 characters — a few unrelated words work well.");
          if (pw.value !== pw2.value) return (err.textContent = "The two passwords don't match.");
          btn.disabled = true;
          btn.textContent = "Creating…";
          try {
            const { record, session } = await createVault(pw.value, normalize({}));
            const r = await ui.api("PUT", "/api/vault", { record, base_revision: null });
            V.remote = { exists: true, revision: r.revision, record };
            startSession(session, {});
            paintUnlocked();
            ui.toast("Vault created");
          } catch (ex) {
            err.textContent = ex.message;
            btn.disabled = false;
            btn.textContent = "Create vault";
          }
        },
      },
      h("div", { class: "gate-icon" }, "🔑"),
      h("h2", {}, "Create your password vault"),
      h("p", { class: "sub" }, "Choose a master password just for the vault (not your sign-in password). It encrypts everything in this browser; FleetView never sees it and cannot recover it."),
      h("label", { class: "field" }, "Master password"),
      pw,
      meter,
      h("label", { class: "field" }, "Repeat it"),
      pw2,
      err,
      h("div", { style: { marginTop: "14px" } }, btn),
    ),
  );
  setTimeout(() => pw.focus(), 0);
}

function paintLocked(note = "") {
  const { h, put } = ui;
  const pw = h("input", { type: "password", autocomplete: "current-password", placeholder: "Master password" });
  const err = h("div", { class: "err" }, note);
  const btn = h("button", { class: "btn primary big", type: "submit" }, "Unlock");
  put(
    root,
    h("div", { class: "page-head" }, h("h1", {}, "Passwords")),
    h(
      "form",
      {
        class: "card card-pad vault-gate",
        onsubmit: async (e) => {
          e.preventDefault();
          btn.disabled = true;
          btn.textContent = "Unlocking…";
          err.textContent = "";
          try {
            V.remote = await ui.api("GET", "/api/vault");
            const { contents, session } = await openVault(V.remote.record, pw.value);
            startSession(session, contents);
            ui.api("POST", "/api/vault/audit", { event: "unlocked" }).catch(() => {});
            paintUnlocked();
          } catch (ex) {
            if (ex instanceof WrongPassword) ui.api("POST", "/api/vault/audit", { event: "unlock_failed" }).catch(() => {});
            err.textContent = ex.message;
            btn.disabled = false;
            btn.textContent = "Unlock";
            pw.select();
          }
        },
      },
      h("div", { class: "gate-icon" }, "🔒"),
      h("h2", {}, "Vault locked"),
      h("p", { class: "sub" }, "Enter the vault's master password. It is checked here, in your browser."),
      pw,
      err,
      h("div", { style: { marginTop: "14px" } }, btn),
      h("details", { class: "sub", style: { marginTop: "18px" } }, h("summary", {}, "Forgot the master password?"),
        h("p", {}, "It can't be recovered — that's what keeps the vault safe. You can restore an encrypted backup (you need that backup's master password) or start over with an empty vault."),
        h("div", { class: "row" },
          h("button", { class: "btn small", type: "button", onclick: () => openRestore() }, "Restore a backup…"),
          h("button", { class: "btn small ghost danger", type: "button", onclick: () => openReset() }, "Delete the vault…"))),
    ),
  );
  setTimeout(() => pw.focus(), 0);
}

// --------------------------------------------------------------- unlocked --

function groupById(id) {
  return V.data.groups.find((g) => g.id === id) ?? null;
}
function groupPath(id) {
  const out = [];
  for (let g = groupById(id), guard = 0; g && guard < 64; g = groupById(g.parent), guard++) out.unshift(g.name);
  return out;
}
function descendants(id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of V.data.groups) if (g.parent && out.has(g.parent) && !out.has(g.id)) (out.add(g.id), (grew = true));
  }
  return out;
}
function recentIds() {
  try {
    return JSON.parse(localStorage.getItem("fv-vault-recent") ?? "[]");
  } catch {
    return [];
  }
}
function touchRecent(id) {
  // Only random entry ids (no names) are kept outside the encrypted vault.
  try {
    localStorage.setItem("fv-vault-recent", JSON.stringify([id, ...recentIds().filter((x) => x !== id)].slice(0, 12)));
  } catch {}
}

function visibleEntries() {
  const q = V.query.trim().toLowerCase();
  let list = V.data.entries;
  if (V.group === "fav") list = list.filter((e) => e.favorite);
  else if (V.group === "recent") {
    const r = recentIds();
    list = r.map((id) => list.find((e) => e.id === id)).filter(Boolean);
  } else if (V.group !== "all") {
    const ids = descendants(V.group);
    list = list.filter((e) => ids.has(e.group));
  }
  if (q) {
    const words = q.split(/\s+/);
    list = list.filter((e) => {
      const hay = [e.title, e.username, e.url, e.notes, groupPath(e.group).join(" "), ...(e.fields ?? []).map((f) => f.name)].join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  return V.group === "recent" ? list : [...list].sort((a, b) => (b.favorite - a.favorite) || a.title.localeCompare(b.title));
}

function paintUnlocked() {
  const { h, put } = ui;
  root.dataset.view = "vault";
  const search = h("input", {
    type: "search",
    class: "vault-search",
    placeholder: "Search passwords…  (Ctrl+K)",
    value: V.query,
    oninput: (e) => {
      V.query = e.target.value;
      paintList();
    },
    onkeydown: (e) => {
      if (e.key === "Enter") {
        const first = visibleEntries()[0];
        if (first) select(first.id);
      }
    },
  });
  put(
    root,
    h(
      "div",
      { class: "page-head" },
      h("h1", {}, "Passwords"),
      h("span", { class: "spacer" }),
      h("button", { class: "btn primary", onclick: () => openEdit(null) }, "＋ New"),
      h("button", { class: "btn", onclick: openImport }, "Import"),
      moreMenu(),
      h("button", { class: "btn ghost", title: "Lock now", onclick: () => lockVault() }, "🔒 Lock"),
    ),
    h(
      "div",
      { class: "vault" },
      h("aside", { class: "vault-groups card", id: "vault-groups" }),
      h("section", { class: "vault-main" }, search, h("div", { class: "card vault-list", id: "vault-list" })),
      h("section", { class: "vault-detail card", id: "vault-detail" }),
    ),
  );
  paintGroups();
  paintList();
  paintDetail();
  setTimeout(() => search.focus(), 0);
}

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && V.session) {
    const s = document.querySelector(".vault-search");
    if (s) {
      e.preventDefault();
      s.focus();
      s.select();
    }
  }
});

function moreMenu() {
  const { h } = ui;
  const item = (label, fn, cls = "") => h("button", { class: `menu-item ${cls}`, onclick: (e) => (e.target.closest("details").open = false, fn()) }, label);
  return h(
    "details",
    { class: "menu" },
    h("summary", { class: "btn" }, "More ▾"),
    h(
      "div",
      { class: "menu-list card" },
      item("New folder…", () => openGroup(null)),
      item("Download encrypted backup", downloadBackup),
      item("Restore a backup…", openRestore),
      item("Export as CSV (unencrypted)…", openPlainExport),
      item("Change master password…", openChangePassword),
      item("Activity log", openAudit),
    ),
  );
}

function countIn(id) {
  const ids = descendants(id);
  return V.data.entries.filter((e) => ids.has(e.group)).length;
}

function paintGroups() {
  const { h, put } = ui;
  const box = document.getElementById("vault-groups");
  if (!box) return;
  const item = (id, label, count, depth = 0, icon = "") =>
    h(
      "button",
      { class: `group-item${V.group === id ? " active" : ""}`, style: { paddingLeft: `${10 + depth * 14}px` }, onclick: () => ((V.group = id), paintGroups(), paintList()) },
      icon ? h("span", { class: "gi" }, icon) : null,
      h("span", { class: "gname" }, label),
      count != null ? h("span", { class: "gcount" }, count) : null,
    );
  const tree = [];
  const walk = (parent, depth) => {
    V.data.groups
      .filter((g) => (g.parent ?? null) === parent)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((g) => {
        tree.push(item(g.id, g.name, countIn(g.id), depth, "📁"));
        walk(g.id, depth + 1);
      });
  };
  walk(null, 0);
  put(
    box,
    item("all", "All passwords", V.data.entries.length, 0, "🗂"),
    item("fav", "Favorites", V.data.entries.filter((e) => e.favorite).length, 0, "★"),
    item("recent", "Recently used", null, 0, "🕘"),
    h("div", { class: "group-sep" }),
    tree,
    V.group !== "all" && V.group !== "fav" && V.group !== "recent"
      ? h("div", { class: "row group-actions" },
          h("button", { class: "btn small ghost", onclick: () => openGroup(groupById(V.group)) }, "Rename"),
          h("button", { class: "btn small ghost", onclick: () => openGroup(null, V.group) }, "Sub-folder"),
          h("button", { class: "btn small ghost danger", onclick: () => deleteGroup(V.group) }, "Delete"))
      : null,
  );
}

function host(url) {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).host;
  } catch {
    return url;
  }
}

function paintList() {
  const { h, put } = ui;
  const box = document.getElementById("vault-list");
  if (!box) return;
  const list = visibleEntries();
  if (!list.length) {
    put(box, h("div", { class: "empty" }, V.data.entries.length ? [h("b", {}, "Nothing here"), V.query ? "Try another search." : "This folder is empty."] : [h("b", {}, "Your vault is empty"), "Import from KeePassXC (.kdbx or .csv) or add a password with ＋ New."]));
    return;
  }
  put(
    box,
    list.slice(0, 500).map((e) =>
      h(
        "div",
        { class: `entry${V.selected === e.id ? " active" : ""}`, onclick: () => select(e.id) },
        h("div", { class: "avatar" }, (e.title || "?").trim()[0]?.toUpperCase() ?? "?"),
        h("div", { class: "grow" }, h("div", { class: "etitle" }, e.favorite ? "★ " : "", e.title || "(no title)"), h("div", { class: "sub" }, [e.username, e.url ? host(e.url) : null, V.group === "all" || V.query ? groupPath(e.group).join(" / ") : null].filter(Boolean).join(" · "))),
        e.username ? h("button", { class: "btn small ghost", title: "Copy user name", onclick: (ev) => (ev.stopPropagation(), copy(e.username, "User name", e.id)) }, "👤") : null,
        e.password ? h("button", { class: "btn small ghost", title: "Copy password", onclick: (ev) => (ev.stopPropagation(), copy(e.password, "Password", e.id)) }, "🔑") : null,
      ),
    ),
    list.length > 500 ? h("div", { class: "sub", style: { padding: "10px" } }, `Showing 500 of ${list.length} — search to narrow down.`) : null,
  );
}

function select(id) {
  V.selected = id;
  touchRecent(id);
  paintList();
  paintDetail();
  document.getElementById("vault-detail")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function paintDetail() {
  const { h, put } = ui;
  const box = document.getElementById("vault-detail");
  if (!box) return;
  const e = V.data.entries.find((x) => x.id === V.selected);
  box.classList.toggle("open", !!e);
  if (!e) return put(box, h("div", { class: "empty" }, h("b", {}, "Pick a password"), "Its details show here. Tip: type to search, Enter opens the first match."));
  const row = (label, value, { secret = false, link = false, mono = false } = {}) => {
    if (!value) return null;
    const val = h("span", { class: `fval${mono || secret ? " mono" : ""}` }, secret ? "••••••••••" : value);
    let shown = false;
    return h(
      "div",
      { class: "field-row" },
      h("span", { class: "flabel" }, label),
      link ? h("a", { class: "fval", href: safeHref(value), target: "_blank", rel: "noopener noreferrer" }, value) : val,
      h(
        "span",
        { class: "factions" },
        secret
          ? h("button", { class: "btn small ghost", title: "Show / hide", onclick: (ev) => {
              shown = !shown;
              val.textContent = shown ? value : "••••••••••";
              ev.currentTarget.textContent = shown ? "🙈" : "👁";
            } }, "👁")
          : null,
        h("button", { class: "btn small ghost", title: `Copy ${label.toLowerCase()}`, onclick: () => copy(value, label, e.id) }, "Copy"),
      ),
    );
  };
  put(
    box,
    h("button", { class: "btn small ghost detail-close", onclick: () => ((V.selected = null), paintList(), paintDetail()) }, "✕"),
    h("div", { class: "detail-head" }, h("div", { class: "avatar big" }, (e.title || "?").trim()[0]?.toUpperCase() ?? "?"), h("div", {}, h("h2", {}, e.title || "(no title)"), h("div", { class: "sub" }, groupPath(e.group).join(" / ") || "No folder"))),
    h("div", { class: "fields" }, row("User name", e.username, { mono: true }), row("Password", e.password, { secret: true }), row("Website", e.url, { link: /^https?:\/\//i.test(e.url) }), ...(e.fields ?? []).map((f) => row(f.name, f.value, { secret: /pass|parol|pin|otp|secret|key/i.test(f.name) }))),
    e.notes ? h("div", { class: "notes" }, h("div", { class: "flabel" }, "Notes"), h("pre", {}, e.notes)) : null,
    connectBox(e),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn primary", onclick: () => openEdit(e) }, "Edit"),
      h("button", { class: "btn", onclick: async () => ((e.favorite = !e.favorite), (e.updated = now()), await save().catch(ui.fail), paintList(), paintGroups(), paintDetail()) }, e.favorite ? "★ Unfavorite" : "☆ Favorite"),
      h("button", { class: "btn ghost danger", onclick: () => deleteEntry(e) }, "Delete"),
    ),
    h("div", { class: "sub", style: { marginTop: "10px" } }, `Changed ${new Date(e.updated ?? e.created ?? Date.now()).toLocaleString()}`),
  );
}

function safeHref(url) {
  return /^https?:\/\//i.test(url) ? url : "#";
}

/** "Connect" helpers for servers: never put the password anywhere. */
function connectBox(e) {
  const { h } = ui;
  const target = connectTarget(e);
  if (!target) return null;
  const { kind, host: hst, port } = target;
  const user = e.username;
  if (kind === "ssh") {
    const cmd = `ssh ${port && port !== 22 ? `-p ${port} ` : ""}${user ? `${user}@` : ""}${hst}`;
    return h("div", { class: "connect" }, h("span", { class: "flabel" }, "Connect"), h("code", {}, cmd), h("button", { class: "btn small", onclick: () => copy(cmd, "SSH command", e.id) }, "Copy command"));
  }
  return h(
    "div",
    { class: "connect" },
    h("span", { class: "flabel" }, "Connect"),
    h("code", {}, `${hst}${port && port !== 3389 ? `:${port}` : ""}`),
    h("button", { class: "btn small", onclick: () => downloadRdp(e, hst, port) }, "Remote Desktop (.rdp)"),
  );
}

function connectTarget(e) {
  const url = (e.url ?? "").trim();
  const m = /^(ssh|rdp|sftp):\/\/([^/:]+)(?::(\d+))?/i.exec(url);
  if (m) return { kind: m[1].toLowerCase() === "rdp" ? "rdp" : "ssh", host: m[2], port: m[3] ? Number(m[3]) : null };
  // A server folder with a bare host / IP: offer both.
  const looksServer = /server|servere|nas|vps|rdp|ssh/i.test([e.title, groupPath(e.group).join(" ")].join(" "));
  const hostLike = /^[\w.-]+\.[a-z0-9-]{2,}$|^\d{1,3}(\.\d{1,3}){3}$/i;
  const candidate = url && !url.includes("://") ? url.split("/")[0] : "";
  if (looksServer && hostLike.test(candidate)) return { kind: /linux|ssh|ubuntu|debian/i.test(e.title + e.notes) ? "ssh" : "rdp", host: candidate, port: null };
  return null;
}

function downloadRdp(e, host, port) {
  // Address and user only. Windows asks for the password when connecting.
  const lines = [`full address:s:${host}${port ? `:${port}` : ""}`, e.username ? `username:s:${e.username}` : null, "prompt for credentials:i:1", "screen mode id:i:2"].filter(Boolean);
  download(`${(e.title || host).replace(/[^\w.-]+/g, "_")}.rdp`, new Blob([lines.join("\r\n") + "\r\n"], { type: "application/x-rdp" }));
}

function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

let clipTimer = null;
async function copy(value, label, entryId) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    return ui.toast("Your browser blocked the clipboard.", true);
  }
  if (entryId) touchRecent(entryId);
  ui.toast(`${label} copied — the clipboard clears in 30 s`);
  clearTimeout(clipTimer);
  clipTimer = setTimeout(() => navigator.clipboard.writeText("").catch(() => {}), CLIPBOARD_CLEAR_MS);
}

// ------------------------------------------------------------------ edits --

function groupOptions(selected) {
  const { h } = ui;
  const opts = [h("option", { value: "", selected: !selected }, "(no folder)")];
  const walk = (parent, depth) =>
    V.data.groups
      .filter((g) => (g.parent ?? null) === parent)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((g) => {
        opts.push(h("option", { value: g.id, selected: g.id === selected }, `${"  ".repeat(depth)}${depth ? "└ " : ""}${g.name}`));
        walk(g.id, depth + 1);
      });
  walk(null, 0);
  return opts;
}

function openEdit(entry) {
  const { h, put } = ui;
  const e = entry ? { ...entry, fields: [...(entry.fields ?? [])] } : { id: uid(), group: ["all", "fav", "recent"].includes(V.group) ? null : V.group, title: "", username: "", password: "", url: "", notes: "", fields: [], favorite: false };
  const inp = (key, attrs = {}) => h("input", { type: "text", value: e[key] ?? "", autocomplete: "off", oninput: (ev) => (e[key] = ev.target.value), ...attrs });
  const pw = h("input", { type: "password", class: "mono", value: e.password, autocomplete: "new-password", oninput: (ev) => ((e.password = ev.target.value), showStrength(meter, e.password)) });
  const meter = h("div", { class: "strength" }, h("i"));
  showStrength(meter, e.password);
  const gen = { length: 20, symbols: true };
  const showBtn = h("button", { class: "btn", type: "button", onclick: () => setShown(pw.type === "password") }, "Show");
  const setShown = (on) => {
    pw.type = on ? "text" : "password";
    showBtn.textContent = on ? "Hide" : "Show";
  };
  const d = {
    title: entry ? "Edit password" : "New password",
    render() {
      put(
        d.body,
        h("label", { class: "field" }, "Title"),
        inp("title", { placeholder: "e.g. Router principal" }),
        h("label", { class: "field" }, "User name"),
        inp("username", { class: "mono" }),
        h("label", { class: "field" }, "Password"),
        h("div", { class: "row" }, h("div", { class: "grow" }, pw), showBtn),
        meter,
        h("div", { class: "gen row" },
          h("button", { class: "btn small", type: "button", onclick: () => {
            e.password = generatePassword({ length: gen.length, symbols: gen.symbols });
            pw.value = e.password;
            setShown(true);
            showStrength(meter, e.password);
          } }, "⚡ Generate"),
          h("label", { class: "sub" }, "length ", h("input", { type: "number", min: "8", max: "64", value: String(gen.length), class: "num", oninput: (ev) => (gen.length = Math.max(8, Math.min(64, Number(ev.target.value) || 20))) })),
          h("label", { class: "check inline" }, h("input", { type: "checkbox", checked: gen.symbols, onchange: (ev) => (gen.symbols = ev.target.checked) }), "symbols")),
        h("label", { class: "field" }, "Website or address"),
        inp("url", { placeholder: "https://… or ssh://server or rdp://pc" }),
        h("label", { class: "field" }, "Folder"),
        h("select", { onchange: (ev) => (e.group = ev.target.value || null) }, groupOptions(e.group)),
        h("label", { class: "field" }, "Notes"),
        h("textarea", { rows: 4, oninput: (ev) => (e.notes = ev.target.value) }, e.notes ?? ""),
        e.fields.length
          ? h("div", {}, h("label", { class: "field" }, "Other fields"),
              e.fields.map((f, i) => h("div", { class: "row", style: { marginBottom: "6px" } },
                h("input", { type: "text", value: f.name, oninput: (ev) => (f.name = ev.target.value) }),
                h("input", { type: "text", value: f.value, class: "mono", oninput: (ev) => (f.value = ev.target.value) }),
                h("button", { class: "btn small ghost danger", type: "button", onclick: () => (e.fields.splice(i, 1), d.render()) }, "✕"))))
          : null,
        h("button", { class: "btn small ghost", type: "button", style: { marginTop: "8px" }, onclick: () => (e.fields.push({ name: "", value: "" }), d.render()) }, "＋ Add a field"),
      );
      put(
        d.footer,
        h("button", { class: "btn primary big", onclick: async (ev) => {
          if (!e.title.trim() && !e.username.trim()) return ui.toast("Give it a title or a user name.", true);
          ev.target.disabled = true;
          e.fields = e.fields.filter((f) => f.name.trim() || f.value);
          e.updated = now();
          const i = V.data.entries.findIndex((x) => x.id === e.id);
          const before = i >= 0 ? V.data.entries[i] : null;
          if (i >= 0) V.data.entries[i] = e;
          else V.data.entries.push({ ...e, created: now() });
          try {
            await save();
            V.selected = e.id;
            ui.closeDrawer();
            paintGroups();
            paintList();
            paintDetail();
            ui.toast("Saved");
          } catch (ex) {
            if (before) V.data.entries[i] = before;
            else V.data.entries = V.data.entries.filter((x) => x.id !== e.id);
            ev.target.disabled = false;
            ui.fail(ex);
          }
        } }, "Save"),
        h("button", { class: "btn ghost", onclick: ui.closeDrawer }, "Cancel"),
      );
    },
  };
  openVaultDrawer(d);
}

async function deleteEntry(e) {
  if (!confirm(`Delete “${e.title || e.username}”? This can't be undone (except from a backup).`)) return;
  const before = V.data.entries;
  V.data.entries = before.filter((x) => x.id !== e.id);
  try {
    await save();
    V.selected = null;
    paintGroups();
    paintList();
    paintDetail();
    ui.toast("Deleted");
  } catch (ex) {
    V.data.entries = before;
    ui.fail(ex);
  }
}

function openGroup(group, parent = null) {
  const { h, put } = ui;
  const name = h("input", { type: "text", value: group?.name ?? "" });
  const d = {
    title: group ? "Rename folder" : "New folder",
    render() {
      put(d.body, h("label", { class: "field" }, "Name"), name, !group ? h("label", { class: "field" }, "Inside") : null, !group ? h("select", { onchange: (e) => (parent = e.target.value || null) }, groupOptions(parent)) : null);
      put(d.footer, h("button", { class: "btn primary big", onclick: async () => {
        const n = name.value.trim();
        if (!n) return;
        const snapshot = JSON.stringify(V.data.groups);
        if (group) group.name = n;
        else V.data.groups.push({ id: uid(), name: n, parent });
        try {
          await save();
          ui.closeDrawer();
          paintGroups();
          paintList();
        } catch (ex) {
          V.data.groups = JSON.parse(snapshot);
          ui.fail(ex);
        }
      } }, "Save"));
      setTimeout(() => name.focus(), 0);
    },
  };
  openVaultDrawer(d);
}

async function deleteGroup(id) {
  const n = countIn(id);
  if (n) return ui.toast(`Move or delete its ${n} password(s) first.`, true);
  const ids = descendants(id);
  if (!confirm(`Delete the folder “${groupById(id)?.name}”${ids.size > 1 ? " and its empty sub-folders" : ""}?`)) return;
  const before = V.data.groups;
  V.data.groups = before.filter((g) => !ids.has(g.id));
  try {
    await save();
    V.group = "all";
    paintGroups();
    paintList();
  } catch (ex) {
    V.data.groups = before;
    ui.fail(ex);
  }
}

// ----------------------------------------------------------------- import --

/** Folder id for a path like ["ANSC", "Servere cloud"], creating folders. */
function ensurePath(path, groups) {
  let parent = null;
  for (const name of path) {
    let g = groups.find((x) => (x.parent ?? null) === parent && x.name === name);
    if (!g) {
      g = { id: uid(), name, parent };
      groups.push(g);
    }
    parent = g.id;
  }
  return parent;
}

function openImport() {
  const { h, put } = ui;
  const st = { stage: "pick", file: null, entries: null, error: "", progress: 0, skipDuplicates: true };
  const d = {
    title: "Import passwords",
    render() {
      if (st.stage === "pick") {
        const input = h("input", { type: "file", accept: ".kdbx,.csv", class: "hidden", onchange: (e) => e.target.files[0] && pick(e.target.files[0]) });
        const drop = h("div", {
          class: "drop",
          onclick: () => input.click(),
          ondragover: (e) => (e.preventDefault(), drop.classList.add("over")),
          ondragleave: () => drop.classList.remove("over"),
          ondrop: (e) => (e.preventDefault(), drop.classList.remove("over"), e.dataTransfer.files[0] && pick(e.dataTransfer.files[0])),
        }, h("b", {}, "Drop a KeePassXC .kdbx or .csv file here"), h("div", {}, "or click to choose"), input);
        put(
          d.body,
          drop,
          h("div", { class: "note info" }, "The file is opened and decrypted here in your browser. Nothing is uploaded until you confirm, and then only in encrypted form."),
          h("ul", { class: "sub" },
            h("li", {}, ".kdbx: KeePassXC / KeePass 2 database (KDBX 4). You'll type its KeePass password here."),
            h("li", {}, ".csv: KeePassXC → Database → Export → CSV file. Delete the CSV afterwards — it isn't encrypted.")),
        );
        put(d.footer);
      } else if (st.stage === "kdbx-password") {
        const pw = h("input", { type: "password", autocomplete: "off", placeholder: "KeePass master password" });
        const err = h("div", { class: "err" }, st.error);
        const go = async () => {
          st.error = "";
          st.stage = "opening";
          st.progress = 0;
          d.render();
          try {
            const buf = await st.file.arrayBuffer();
            const r = await openKdbxInWorker(buf, pw.value, (p) => {
              st.progress = p;
              const bar = d.body.querySelector(".upbar i");
              if (bar) bar.style.width = `${Math.round(p * 100)}%`;
            });
            st.entries = r.entries;
            st.groups = r.groups;
            st.stage = "preview";
          } catch (e) {
            st.stage = "kdbx-password";
            st.error = e.message;
          }
          d.render();
        };
        put(d.body, h("p", {}, h("b", {}, st.file.name)), h("label", { class: "field" }, "KeePass master password"), pw, err, h("p", { class: "sub" }, "Checked and used only in this browser tab."));
        pw.addEventListener("keydown", (e) => e.key === "Enter" && go());
        put(d.footer, h("button", { class: "btn primary big", onclick: go }, "Open"), h("button", { class: "btn ghost", onclick: () => ((st.stage = "pick"), d.render()) }, "Back"));
        setTimeout(() => pw.focus(), 0);
      } else if (st.stage === "opening") {
        const bar = h("i");
        bar.style.width = `${Math.round(st.progress * 100)}%`;
        put(d.body, h("p", {}, "Opening the database… (the key derivation is deliberately slow)"), h("div", { class: "upbar" }, bar));
        put(d.footer);
      } else if (st.stage === "preview") {
        const existing = new Set(V.data.entries.map((e) => dupKey(groupPath(e.group), e)));
        const dups = st.entries.filter((e) => existing.has(dupKey(e.group, e))).length;
        const folders = new Map();
        for (const e of st.entries) {
          const k = e.group.join(" / ") || "(no folder)";
          folders.set(k, (folders.get(k) ?? 0) + 1);
        }
        put(
          d.body,
          h("div", { class: "stats" },
            h("div", { class: "stat" }, h("b", {}, st.entries.length), h("span", {}, "passwords")),
            h("div", { class: "stat" }, h("b", {}, new Set([...(st.groups ?? []).map((g) => g.join("/")), ...st.entries.map((e) => e.group.join("/"))].filter(Boolean)).size), h("span", {}, "folders"))),
          dups ? h("label", { class: "check" }, h("input", { type: "checkbox", checked: st.skipDuplicates, onchange: (e) => (st.skipDuplicates = e.target.checked) }), h("span", {}, `Skip ${dups} already in the vault`, h("small", {}, "Same folder, title and user name."))) : null,
          h("label", { class: "field" }, "Folders"),
          h("div", { class: "card preview" }, [...folders].sort().map(([k, n]) => h("div", { class: "row" }, h("span", { class: "grow" }, "📁 ", k), h("span", { class: "sub" }, n)))),
          h("label", { class: "field" }, "First entries"),
          h("div", { class: "card preview" }, st.entries.slice(0, 8).map((e) => h("div", { class: "row" }, h("span", { class: "grow" }, e.title || "(no title)"), h("span", { class: "sub" }, e.username)))),
        );
        put(
          d.footer,
          h("button", { class: "btn primary big", onclick: async (ev) => {
            ev.target.disabled = true;
            const before = JSON.stringify(V.data);
            const groups = V.data.groups;
            for (const p of st.groups ?? []) ensurePath(p, groups);
            let added = 0;
            for (const e of st.entries) {
              if (st.skipDuplicates && existing.has(dupKey(e.group, e))) continue;
              V.data.entries.push({ id: uid(), group: ensurePath(e.group, groups), title: e.title, username: e.username, password: e.password, url: e.url, notes: e.notes, fields: e.fields ?? [], favorite: false, created: now(), updated: now() });
              added++;
            }
            try {
              await save();
              ui.api("POST", "/api/vault/audit", { event: "imported", count: added }).catch(() => {});
              st.entries = null;
              ui.closeDrawer();
              V.group = "all";
              paintGroups();
              paintList();
              ui.toast(`Imported ${added} password(s)`);
            } catch (ex) {
              V.data = JSON.parse(before);
              ev.target.disabled = false;
              ui.fail(ex);
            }
          } }, `Import ${st.skipDuplicates ? st.entries.length - dups : st.entries.length} passwords`),
          h("button", { class: "btn ghost", onclick: ui.closeDrawer }, "Cancel"),
        );
      }
    },
  };
  async function pick(file) {
    st.file = file;
    if (/\.kdbx$/i.test(file.name)) {
      st.stage = "kdbx-password";
    } else {
      try {
        st.entries = entriesFromCsv(await file.text());
        st.groups = [];
        st.stage = "preview";
      } catch (e) {
        ui.toast(e.message, true);
        return;
      }
    }
    d.render();
  }
  openVaultDrawer(d);
}

const dupKey = (path, e) => [path.join("/"), e.title, e.username].join("\u0000").toLowerCase();

function openKdbxInWorker(buf, password, onProgress) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./kdbx-worker.js", import.meta.url), { type: "module" });
    w.onmessage = (e) => {
      if (e.data.progress != null) return onProgress(e.data.progress);
      w.terminate();
      e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.result);
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || "could not open the file"));
    };
    w.postMessage({ buf, password }, [buf]);
  });
}

// --------------------------------------------------------- backup, export --

function downloadBackup() {
  // The encrypted record, straight from the server; opening it needs the master password.
  const a = document.createElement("a");
  a.href = "/api/vault/backup";
  a.download = "";
  document.body.append(a);
  a.click();
  a.remove();
  ui.toast("Encrypted backup downloaded — it needs your master password to open");
}

function stepUpFields() {
  const { h } = ui;
  const pw = h("input", { type: "password", autocomplete: "current-password", placeholder: "Console sign-in password" });
  const code = h("input", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", placeholder: "Authenticator code", class: "code-input" });
  return { pw, code, el: h("div", { class: "row" }, pw, code) };
}

function openRestore() {
  const { h, put } = ui;
  let record = null;
  const s = stepUpFields();
  const d = {
    title: "Restore an encrypted backup",
    render() {
      const input = h("input", { type: "file", accept: ".json", onchange: async (e) => {
        try {
          const j = JSON.parse(await e.target.files[0].text());
          record = j.record ?? j;
          if (record?.format !== "fleetview-vault-1") throw new Error("This is not a FleetView vault backup.");
          info.textContent = `Backup from ${j.exported_at ? new Date(j.exported_at).toLocaleString() : "an unknown date"}.`;
        } catch (ex) {
          record = null;
          info.textContent = ex.message;
        }
      } });
      const info = h("div", { class: "sub" });
      put(d.body, h("div", { class: "note" }, "This replaces the vault on the server with the backup. You'll need the master password the backup was made with."), h("label", { class: "field" }, "Backup file"), input, info, h("label", { class: "field" }, "Confirm it's you"), s.el);
      put(d.footer, h("button", { class: "btn primary big", onclick: async () => {
        if (!record) return ui.toast("Choose a backup file first.", true);
        try {
          await ui.api("POST", "/api/vault/restore", { record, password: s.pw.value, code: s.code.value });
          lockVault();
          V.remote = await ui.api("GET", "/api/vault");
          ui.closeDrawer();
          paintLocked("Backup restored. Unlock it with the backup's master password.");
        } catch (ex) {
          ui.fail(ex);
        }
      } }, "Restore"));
    },
  };
  openVaultDrawer(d);
}

function openReset() {
  const { h, put } = ui;
  const s = stepUpFields();
  const d = {
    title: "Delete the vault",
    render() {
      put(d.body, h("div", { class: "note" }, "This permanently deletes every password in the vault. Download an encrypted backup first if you might remember the master password later."), h("label", { class: "field" }, "Confirm it's you"), s.el);
      put(d.footer, h("button", { class: "btn danger big", onclick: async () => {
        if (!confirm("Delete the vault for good?")) return;
        try {
          await ui.api("POST", "/api/vault/reset", { password: s.pw.value, code: s.code.value });
          lockVault();
          V.remote = { exists: false };
          ui.closeDrawer();
          paintCreate();
        } catch (ex) {
          ui.fail(ex);
        }
      } }, "Delete vault"));
    },
  };
  openVaultDrawer(d);
}

function openPlainExport() {
  const { h, put } = ui;
  const pw = h("input", { type: "password", autocomplete: "off", placeholder: "Vault master password" });
  const d = {
    title: "Export as CSV (unencrypted)",
    render() {
      put(
        d.body,
        h("div", { class: "note" }, "⚠ The CSV file contains every password in plain text. Anyone who gets the file can read them. Import it where you need it, then delete it (and empty the Recycle Bin). For backups use “Download encrypted backup” instead."),
        h("label", { class: "field" }, "Type the vault's master password to continue"),
        pw,
      );
      put(d.footer, h("button", { class: "btn danger big", onclick: async () => {
        if (!(await checkMasterPassword(V.remote.record, pw.value))) return ui.toast("Wrong master password.", true);
        const rows = V.data.entries.map((e) => ({ ...e, groupPath: groupPath(e.group).join("/") }));
        download(`fleetview-passwords-${new Date().toISOString().slice(0, 10)}.csv`, new Blob(["﻿" + entriesToCsv(rows)], { type: "text/csv;charset=utf-8" }));
        ui.api("POST", "/api/vault/audit", { event: "exported_plain", count: rows.length }).catch(() => {});
        ui.closeDrawer();
      } }, "I understand — export"));
      setTimeout(() => pw.focus(), 0);
    },
  };
  openVaultDrawer(d);
}

function openChangePassword() {
  const { h, put } = ui;
  const cur = h("input", { type: "password", autocomplete: "current-password" });
  const nw = h("input", { type: "password", autocomplete: "new-password" });
  const nw2 = h("input", { type: "password", autocomplete: "new-password" });
  const meter = h("div", { class: "strength" }, h("i"));
  nw.addEventListener("input", () => showStrength(meter, nw.value));
  const d = {
    title: "Change master password",
    render() {
      put(d.body, h("label", { class: "field" }, "Current master password"), cur, h("label", { class: "field" }, "New master password"), nw, meter, h("label", { class: "field" }, "Repeat the new one"), nw2,
        h("p", { class: "sub" }, "Old encrypted backups still open with the old password."));
      put(d.footer, h("button", { class: "btn primary big", onclick: async (ev) => {
        if (nw.value.length < 12) return ui.toast("Use at least 12 characters.", true);
        if (nw.value !== nw2.value) return ui.toast("The new passwords don't match.", true);
        ev.target.disabled = true;
        try {
          // Re-wrap the vault key; then seal the current contents with it.
          const { session } = await changeMasterPassword(V.remote.record, cur.value, nw.value);
          V.session = session;
          await save();
          ui.api("POST", "/api/vault/audit", { event: "password_changed" }).catch(() => {});
          ui.closeDrawer();
          ui.toast("Master password changed");
        } catch (ex) {
          ev.target.disabled = false;
          ui.fail(ex);
        }
      } }, "Change"));
    },
  };
  openVaultDrawer(d);
}

const EVENT_LABELS = {
  created: "Vault created",
  unlocked: "Unlocked",
  unlock_failed: "Wrong master password",
  locked: "Locked",
  saved: "Changes saved",
  imported: "Imported",
  exported_plain: "Exported as CSV (unencrypted)",
  backup_downloaded: "Encrypted backup downloaded",
  backup_restored: "Backup restored",
  password_changed: "Master password changed",
  reset: "Vault deleted",
};

async function openAudit() {
  const { h, put } = ui;
  let events = [];
  try {
    events = (await ui.api("GET", "/api/vault/audit")).events;
  } catch (e) {
    return ui.fail(e);
  }
  const d = {
    title: "Vault activity",
    render() {
      put(d.body, h("p", { class: "sub" }, "What happened to the vault, when and from where. It never contains passwords or entry names."),
        h("div", { class: "card log" }, events.map((e) => h("div", {}, h("time", {}, new Date(e.at).toLocaleString()), " ", h("b", {}, EVENT_LABELS[e.event] ?? e.event), e.count != null ? ` (${e.count})` : "", h("span", { class: "sub" }, ` · ${e.user} · ${e.ip}`)))));
    },
  };
  openVaultDrawer(d);
}

// ------------------------------------------------------------------ misc --

/** Rough strength: character classes × length, with an honest label. */
function showStrength(meter, pw) {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^\w]/].filter((r) => r.test(pw)).length;
  const bits = pw.length * Math.log2([0, 26, 52, 62, 90][classes] || 1);
  const pct = Math.min(100, Math.round((bits / 100) * 100));
  const bar = meter.firstChild;
  bar.style.width = `${pct}%`;
  meter.dataset.level = bits < 45 ? "weak" : bits < 75 ? "ok" : "strong";
  meter.title = pw ? `${meter.dataset.level} (~${Math.round(bits)} bits)` : "";
}
