// Pure derivations over the synced cache: what's due when, which list a task
// belongs in, honest project counts. No DOM, no network.

export const LIFE_ADMIN = Object.freeze({
  id: "5f1c0d2e-7a4b-4c3e-9b1a-2d8e6f0a4c71",
  title: "Life admin",
  purpose: "Loose personal tasks that don't belong to another project.",
  outcome: "Nothing slips.",
  domain: "personal",
});

export const OPEN = new Set(["not_started", "in_progress", "blocked", "needs_review"]);
export const PRIORITIES = ["now", "soon", "someday"];
export const PRIORITY_RANK = { now: 0, soon: 1, someday: 2 };
export const PRIORITY_LABEL = { now: "Now", soon: "Soon", someday: "Someday" };
export const STATUS_LABEL = {
  not_started: "Not started",
  in_progress: "In progress",
  blocked: "Blocked",
  needs_review: "Needs review",
  done: "Done",
  cancelled: "Cancelled",
};
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Civil days
//
// A due date is a calendar day, not an instant. The server stores calendar
// recurrences (weekday / day of month) as UTC midnight of the target day, so
// their day is read in UTC. An interval recurrence is a real instant (N days
// after completion), so its day is read in local time. Every comparison below
// is on these day numbers, never on raw milliseconds.
// ---------------------------------------------------------------------------

/** Days since epoch for a local calendar date. */
function dayNumber(y, m, d) {
  return Math.round(Date.UTC(y, m, d) / DAY_MS);
}
export function todayDay(now = Date.now()) {
  const d = new Date(now);
  return dayNumber(d.getFullYear(), d.getMonth(), d.getDate());
}
/** The civil day a task is due, or null if it has no due date. */
export function dueDay(task) {
  if (task.nextDueAt == null) return null;
  const d = new Date(task.nextDueAt);
  return task.recurrenceType === "interval_days"
    ? dayNumber(d.getFullYear(), d.getMonth(), d.getDate())
    : dayNumber(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
/** A Date at UTC midnight for a day number: format it with timeZone UTC. */
function dayDate(day) {
  return new Date(day * DAY_MS);
}

export function fmtDay(day, now = Date.now()) {
  const t = todayDay(now);
  if (day === t) return "today";
  if (day === t + 1) return "tomorrow";
  if (day === t - 1) return "yesterday";
  const d = dayDate(day);
  const sameYear = d.getUTCFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}
export function fmtDayLong(day, now = Date.now()) {
  const d = dayDate(day);
  const sameYear = d.getUTCFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}
export function fmtWhen(ms) {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return (
    d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }) +
    " " +
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  );
}
export function fmtAgo(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** "2 days late", "due today", "due Tue 17 Nov" — or null with no due date. */
export function dueLabel(task, now = Date.now()) {
  const day = dueDay(task);
  if (day === null) return null;
  const diff = day - todayDay(now);
  if (diff < 0) return { text: diff === -1 ? "1 day late" : `${-diff} days late`, late: true };
  return { text: `due ${fmtDay(day, now)}`, late: false };
}

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

export function isRecurring(task) {
  return task.recurrenceType != null;
}
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
export function recurrenceText(task) {
  switch (task.recurrenceType) {
    case "interval_days":
      return task.recurrenceIntervalDays === 1 ? "every day" : `every ${task.recurrenceIntervalDays}d`;
    case "calendar_weekday":
      return `every ${WEEKDAYS[task.recurrenceWeekday ?? 0]}`;
    case "calendar_day_of_month":
      return `on the ${ordinal(task.recurrenceDayOfMonth ?? 1)}`;
    default:
      return null;
  }
}
export function recurrenceLong(task) {
  switch (task.recurrenceType) {
    case "interval_days":
      return `${task.recurrenceIntervalDays} day${task.recurrenceIntervalDays === 1 ? "" : "s"} after it's done`;
    case "calendar_weekday":
      return `Every ${WEEKDAYS_LONG[task.recurrenceWeekday ?? 0]}`;
    case "calendar_day_of_month":
      return `The ${ordinal(task.recurrenceDayOfMonth ?? 1)} of each month`;
    default:
      return "Doesn't repeat";
  }
}
/** The recurrence as the API's input shape, or null. */
export function recurrenceInput(task) {
  switch (task.recurrenceType) {
    case "interval_days":
      return { type: "interval_days", intervalDays: task.recurrenceIntervalDays };
    case "calendar_weekday":
      return { type: "calendar_weekday", weekday: task.recurrenceWeekday };
    case "calendar_day_of_month":
      return { type: "calendar_day_of_month", dayOfMonth: task.recurrenceDayOfMonth };
    default:
      return null;
  }
}

/** Port of the tracker's computeNextDueAt (workers/tracker/src/db.ts), used
 *  only to preview "Next due …" before the server confirms it. */
export function computeNextDueAt(task, fromMs) {
  if (task.recurrenceType === "interval_days") return fromMs + (task.recurrenceIntervalDays ?? 1) * DAY_MS;
  const from = new Date(fromMs);
  const fromUtcMidnight = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  if (task.recurrenceType === "calendar_weekday") {
    const target = task.recurrenceWeekday ?? 0;
    let diff = (target - new Date(fromUtcMidnight).getUTCDay() + 7) % 7;
    if (diff === 0) diff = 7;
    return fromUtcMidnight + diff * DAY_MS;
  }
  const targetDay = task.recurrenceDayOfMonth ?? 1;
  let year = from.getUTCFullYear();
  let month = from.getUTCMonth();
  if (from.getUTCDate() >= targetDay) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  const dim = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(targetDay, dim));
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

function byPriorityThenDue(a, b) {
  return (
    (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3) ||
    (dueDay(a) ?? Infinity) - (dueDay(b) ?? Infinity) ||
    a.createdAt - b.createdAt
  );
}

export function openTasks(cache) {
  return Object.values(cache.tasks).filter((t) => OPEN.has(t.status));
}

/** Today, grouped. A task appears once: review wins, then Now (flagged now,
 *  overdue, or blocked), then Due today. */
export function todayGroups(cache, now = Date.now()) {
  const t = todayDay(now);
  const groups = { now: [], review: [], due: [] };
  for (const task of openTasks(cache)) {
    const day = dueDay(task);
    if (task.status === "needs_review") groups.review.push(task);
    else if (task.priority === "now" || task.status === "blocked" || (day !== null && day < t)) groups.now.push(task);
    else if (day !== null && day <= t) groups.due.push(task);
  }
  for (const list of Object.values(groups)) list.sort(byPriorityThenDue);
  return [
    { key: "now", label: "Now", tasks: groups.now },
    { key: "review", label: "Needs your review", tasks: groups.review },
    { key: "due", label: "Due today", tasks: groups.due },
  ];
}

/** Open tasks due within the next 14 days (overdue first), grouped by day. */
export function upcomingGroups(cache, now = Date.now()) {
  const t = todayDay(now);
  const byDay = new Map();
  for (const task of openTasks(cache)) {
    const day = dueDay(task);
    if (day === null || day > t + 14) continue;
    const key = day < t ? "late" : day;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(task);
  }
  const keys = [...byDay.keys()].sort((a, b) => (a === "late" ? -1 : b === "late" ? 1 : a - b));
  return keys.map((key) => ({
    key: String(key),
    label: key === "late" ? "Overdue" : key === t ? "Today" : key === t + 1 ? "Tomorrow" : fmtDayLong(key),
    tasks: byDay.get(key).sort(byPriorityThenDue),
  }));
}

export function reviewTasks(cache) {
  return Object.values(cache.tasks)
    .filter((t) => t.status === "needs_review")
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

export function projectTasks(cache, projectId) {
  const rank = { needs_review: 0, blocked: 1, in_progress: 2, not_started: 3, done: 4, cancelled: 5 };
  return Object.values(cache.tasks)
    .filter((t) => t.projectId === projectId)
    .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || byPriorityThenDue(a, b));
}

/** Priorities of this task's unmet (not done) dependencies. */
function unmetBlockerPriorities(cache, taskId) {
  const out = [];
  for (const d of Object.values(cache.deps)) {
    if (d.taskId !== taskId) continue;
    const blocker = cache.tasks[d.dependsOnTaskId];
    if (blocker && blocker.status !== "done") out.push(blocker.priority);
  }
  return out;
}

/** A task waiting on an unfinished dependency is ranked one tier behind its
 *  most urgent unmet blocker (never more urgent than its own stored
 *  priority, never past someday) -- see TodayLogic.kt's identical rule in
 *  the Android client. Recomputed live from current dependency state, never
 *  stored, so a task moves back up as soon as its blocker clears. */
export function effectivePriorityRank(cache, task) {
  const ownRank = PRIORITY_RANK[task.priority] ?? 2;
  const blockers = unmetBlockerPriorities(cache, task.id);
  if (blockers.length === 0) return ownRank;
  const mostUrgentBlockerRank = Math.min(...blockers.map((p) => PRIORITY_RANK[p] ?? 2));
  return Math.min(Math.max(ownRank, mostUrgentBlockerRank + 1), PRIORITY_RANK.someday);
}

/** This project's open tasks, grouped by effective priority (now/soon/someday,
 *  in that order; a group is omitted when empty), each sorted by due date
 *  then title within the group. */
export function openTasksByPriority(cache, projectId) {
  const open = Object.values(cache.tasks).filter((t) => t.projectId === projectId && OPEN.has(t.status));
  const byRank = new Map();
  for (const t of open) {
    const rank = effectivePriorityRank(cache, t);
    if (!byRank.has(rank)) byRank.set(rank, []);
    byRank.get(rank).push(t);
  }
  const byDueThenTitle = (a, b) => (dueDay(a) ?? Infinity) - (dueDay(b) ?? Infinity) || a.title.localeCompare(b.title);
  return PRIORITIES.map((key, rank) => ({ key, label: PRIORITY_LABEL[key], tasks: (byRank.get(rank) ?? []).sort(byDueThenTitle) })).filter(
    (g) => g.tasks.length > 0,
  );
}

/** Honest counts, each task in exactly one bucket. Cancelled tasks are left
 *  out of the total. "Claimed by an agent" is an open task an actor other than
 *  the owner holds. */
export function projectCounts(cache, projectId, ownerId) {
  const c = { done: 0, review: 0, claimed: 0, open: 0, cancelled: 0, total: 0 };
  for (const t of Object.values(cache.tasks)) {
    if (t.projectId !== projectId) continue;
    if (t.status === "cancelled") {
      c.cancelled += 1;
      continue;
    }
    c.total += 1;
    if (t.status === "done") c.done += 1;
    else if (t.status === "needs_review") c.review += 1;
    else if (t.claimedBy && t.claimedBy !== ownerId) c.claimed += 1;
    else c.open += 1;
  }
  return c;
}

export function openCount(cache, projectId) {
  let n = 0;
  for (const t of Object.values(cache.tasks)) if (t.projectId === projectId && OPEN.has(t.status)) n += 1;
  return n;
}

export function decisionsFor(cache, projectId) {
  return Object.values(cache.decisions)
    .filter((d) => d.projectId === projectId)
    .sort((a, b) => b.createdAt - a.createdAt);
}
export function progressFor(cache, taskId) {
  return Object.values(cache.progress)
    .filter((p) => p.taskId === taskId)
    .sort((a, b) => b.createdAt - a.createdAt);
}
export function dependenciesOf(cache, taskId) {
  return Object.values(cache.deps)
    .filter((d) => d.taskId === taskId)
    .map((d) => cache.tasks[d.dependsOnTaskId])
    .filter(Boolean);
}

/** Rail projects: everything not finished, AI then Life, alphabetical. */
export function railProjects(cache) {
  const live = Object.values(cache.projects)
    .filter((p) => p.status !== "done" && p.status !== "cancelled")
    .sort((a, b) => a.title.localeCompare(b.title));
  return { ai: live.filter((p) => p.domain === "ai"), personal: live.filter((p) => p.domain !== "ai") };
}
export function finishedProjects(cache) {
  return Object.values(cache.projects)
    .filter((p) => p.status === "done" || p.status === "cancelled")
    .sort((a, b) => a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------------------
// Conflict diffs
// ---------------------------------------------------------------------------

const TASK_FIELDS = [
  ["title", "Title"],
  ["status", "Status"],
  ["priority", "Priority"],
  ["blockedReason", "Blocked reason"],
  ["evidenceUrl", "Evidence"],
  ["description", "Description"],
  ["completionCriteria", "Done when"],
  ["claimedBy", "Claimed by"],
  ["nextDueAt", "Next due"],
];

/** What the server changed between the version the user started from and
 *  the version it has now. */
export function taskDiff(before, after) {
  const out = [];
  for (const [key, label] of TASK_FIELDS) {
    const a = before?.[key] ?? null;
    const b = after?.[key] ?? null;
    if (a === b || (a === "" && b === null) || (a === null && b === "")) continue;
    const show = (v, t) =>
      v === null || v === ""
        ? "—"
        : key === "status"
          ? STATUS_LABEL[v] ?? v
          : key === "nextDueAt"
            ? fmtDay(dueDay({ ...t, nextDueAt: v }))
            : String(v);
    out.push({ label, from: show(a, before), to: show(b, after) });
  }
  if (recurrenceText(before ?? {}) !== recurrenceText(after ?? {})) {
    out.push({ label: "Repeats", from: recurrenceText(before ?? {}) ?? "—", to: recurrenceText(after ?? {}) ?? "—" });
  }
  return out;
}
