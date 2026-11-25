// CSV (RFC 4180: quoted fields, "" escapes, line breaks inside quotes),
// mapped from / to KeePassXC's export format:
//   "Group","Title","Username","Password","URL","Notes"[,"TOTP","Icon","Last Modified","Created"]

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // BOM
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      quoted = true;
      i++;
    } else if (c === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (c === "\r" || c === "\n") {
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      i += c === "\r" && s[i + 1] === "\n" ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const ALIASES = {
  group: ["group", "grup", "folder", "path"],
  title: ["title", "titlu", "name", "nume"],
  username: ["username", "user name", "user", "login", "utilizator"],
  password: ["password", "parola", "parolă", "pass"],
  url: ["url", "website", "web site", "address", "adresa", "adresă"],
  notes: ["notes", "note", "comments", "notițe", "notite"],
};

/**
 * Entries from a CSV export. Columns are found by header name; the group is
 * a path "Root/ANSC/Servere" (a leading root folder shared by every row,
 * like KeePassXC's "Root", is dropped).
 */
export function entriesFromCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("The CSV file has no entries.");
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = {};
  for (const [k, names] of Object.entries(ALIASES)) col[k] = header.findIndex((h) => names.includes(h));
  if (col.title < 0 && col.username < 0 && col.password < 0) {
    throw new Error('This CSV has no Title / Username / Password columns. Export from KeePassXC with "Database → Export → CSV file".');
  }
  const known = new Set(Object.values(col).filter((i) => i >= 0));
  const extra = header.map((h, i) => [h, i]).filter(([h, i]) => !known.has(i) && h && !["icon", "last modified", "created"].includes(h));
  const get = (r, k) => (col[k] >= 0 ? (r[col[k]] ?? "") : "");
  let entries = rows.slice(1).map((r) => ({
    group: get(r, "group").split("/").map((g) => g.trim()).filter(Boolean),
    title: get(r, "title"),
    username: get(r, "username"),
    password: get(r, "password"),
    url: get(r, "url"),
    notes: get(r, "notes"),
    fields: extra.filter(([, i]) => r[i]).map(([h, i]) => ({ name: rows[0][i].trim(), value: r[i] })),
  }));
  // Drop a root folder every row shares ("Root/…"), as the KDBX reader does.
  const first = entries[0]?.group[0];
  if (first && entries.every((e) => e.group[0] === first) && /^(root|rădăcină|radacina)$/i.test(first)) {
    entries = entries.map((e) => ({ ...e, group: e.group.slice(1) }));
  }
  return entries;
}

const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

/** KeePassXC-compatible CSV (for the plain export). */
export function entriesToCsv(entries) {
  const lines = [["Group", "Title", "Username", "Password", "URL", "Notes"].map(q).join(",")];
  for (const e of entries) lines.push([e.groupPath ?? "", e.title, e.username, e.password, e.url, e.notes].map(q).join(","));
  return lines.join("\r\n") + "\r\n";
}
