// When is a PC "cleaned"? When every item of this checklist holds. The master
// marks it cleaned by itself the moment the last item is met (by "auto").
//
// Task items are judged from the PC's last result for each task (kept per PC
// in `task_runs`, so they survive the Activity history being trimmed). The
// accounts item uses the last account list read from the PC.

export const CLEAN_CHECKS = [
  { id: "security_baseline", label: "Security baseline applied", need: "succeeded" },
  // A check that finds something off still counts: Tamper Protection, for one,
  // can't be switched on by a script.
  { id: "security_status", label: "Security check done", need: "ran" },
  { id: "adblock", label: "Adblocker installed", need: "succeeded", undoneBy: "adblock_remove" },
  { id: "repair_updates", label: "Windows Update repaired", need: "succeeded" },
  { id: "check_updates", label: "Windows updates checked", need: "succeeded" },
  { id: "install_updates", label: "Windows updates installed", need: "succeeded" },
  { id: "cleanup", label: "Clean-up run", need: "succeeded" },
];

/** The account rule: exactly two accounts besides Windows' own, one named Admin. */
export const ACCOUNT_RULE = { count: 2, adminName: "Admin" };

const peopleOf = (accounts) => (accounts ?? []).filter((u) => !u.default_kind && !u.builtin);

/** The checklist for one agent record: { ok, done, total, items: [{ id, label, ok, at, detail }] }. */
export function cleanChecks(a) {
  const runs = a?.task_runs ?? {};
  const items = CLEAN_CHECKS.map((c) => {
    const r = runs[c.id];
    let ok = !!r && (c.need === "ran" ? r.state === "succeeded" || r.state === "failed" : r.state === "succeeded");
    let detail = r ? r.message || r.state : "not run yet";
    const undo = c.undoneBy && runs[c.undoneBy];
    if (ok && undo?.state === "succeeded" && String(undo.at) > String(r.at)) {
      ok = false;
      detail = "removed again afterwards";
    } else if (r && !ok) detail = `last run failed: ${detail}`;
    return { id: c.id, label: c.label, ok, at: r?.at ?? null, detail };
  });
  const people = peopleOf(a?.accounts);
  const hasAdmin = people.some((u) => String(u.name).toLowerCase() === ACCOUNT_RULE.adminName.toLowerCase());
  const known = Array.isArray(a?.accounts);
  items.push({
    id: "accounts",
    label: `${ACCOUNT_RULE.count} accounts besides Windows' own, one named ${ACCOUNT_RULE.adminName}`,
    ok: known && people.length === ACCOUNT_RULE.count && hasAdmin,
    at: a?.accounts_at ?? null,
    detail: !known
      ? "accounts not read yet"
      : `${people.length ? people.map((u) => u.name).join(", ") : "no accounts besides Windows' own"}${hasAdmin ? "" : ` — none named ${ACCOUNT_RULE.adminName}`}`,
  });
  const done = items.filter((i) => i.ok).length;
  return { ok: done === items.length, done, total: items.length, items };
}

/** The tasks that would satisfy what's missing (accounts → read them). */
export function missingTasks(a) {
  return cleanChecks(a).items.filter((i) => !i.ok).map((i) => (i.id === "accounts" ? "accounts_list" : i.id));
}
