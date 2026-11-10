// The Process web client. One render function draws the whole signed-in
// shell from the synced cache (sync.js) and the current hash route. Writes go
// straight to the API and are always followed by a sync, because the server
// is the source of truth (agents write to it too).
import { AuthError, currentUserId, isSignedIn, signInEmail, signOut, verifyTotp } from "./auth.js";
import { ApiError, api } from "./api.js";
import { getCache, syncNow } from "./sync.js";
import * as M from "./model.js";

const root = document.getElementById("app");
const toastEl = document.getElementById("toast");
const dialog = document.getElementById("dialog");

const VIEWS = new Set(["today", "upcoming", "review", "projects", "project"]);
const UNDO_MS = 5000;
const SYNC_EVERY_MS = 60 * 1000;

const state = {
  cache: getCache(),
  sync: { status: "idle", error: null },
  route: parseRoute(),
  /** taskId -> { timer, task }: completions waiting out the Undo window. */
  pending: new Map(),
  /** { taskId, base, conflict }: the task being edited and the version the edit started from. */
  edit: null,
  /** taskId -> { tone, title, diff, body }: shown at the top of that task's detail. */
  notices: {},
  sendBack: null,
  toast: null,
  lifeAdminChecked: false,
  signedIn: false,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const uuid = () => crypto.randomUUID();
const CHECK = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.3l2.3 2.3 4.7-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function ownerId() {
  return currentUserId();
}
function isOwner(actorId) {
  const me = ownerId();
  return me !== null && actorId === me;
}
function actorName(actorId) {
  if (!actorId) return "";
  return isOwner(actorId) ? "you" : actorId;
}
function projectOf(task) {
  return state.cache.projects[task.projectId] ?? null;
}
function domainOf(project) {
  return project?.domain === "ai" ? "ai" : "personal";
}
function domainTag(domain) {
  return domain === "ai" ? "AI" : "Life";
}
function errorText(err) {
  if (err instanceof ApiError) {
    if (err.status === 429) return "Too many requests. Wait a minute and try again.";
    if (err.status === 400 && Array.isArray(err.body?.issues)) {
      return err.body.issues.map((i) => `${(i.path || []).join(".") || "input"}: ${i.message}`).join("; ");
    }
    return err.message;
  }
  if (err instanceof TypeError) return "Can't reach the server. Check your connection.";
  return err?.message || "Something went wrong.";
}

// ---------------------------------------------------------------------------
// Routing: #/today, #/upcoming, #/review, #/projects, #/project/<id>,
// with an optional trailing /<taskId> selecting a task in the detail pane.
// ---------------------------------------------------------------------------

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  let view = parts[0];
  if (!VIEWS.has(view)) view = "today";
  if (view === "project") return { view, projectId: parts[1] ?? null, taskId: parts[2] ?? null };
  return { view, projectId: null, taskId: parts[1] ?? null };
}
function baseHref(route = state.route) {
  return route.view === "project" ? `#/project/${encodeURIComponent(route.projectId)}` : `#/${route.view}`;
}
function taskHref(taskId) {
  return `${baseHref()}/${encodeURIComponent(taskId)}`;
}
function projectHref(projectId) {
  return `#/project/${encodeURIComponent(projectId)}`;
}

window.addEventListener("hashchange", () => {
  const prev = state.route;
  state.route = parseRoute();
  if (state.route.taskId !== prev.taskId) {
    state.sendBack = null;
    if (state.edit && state.edit.taskId !== state.route.taskId) state.edit = null;
  }
  render({ resetCenter: baseHref(prev) !== baseHref(), resetDetail: state.route.taskId !== prev.taskId });
});

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

async function doSync() {
  state.sync = { ...state.sync, status: "syncing" };
  renderSyncLines();
  try {
    state.cache = await syncNow();
    state.sync = { status: "ok", error: null };
    await ensureLifeAdmin();
  } catch (err) {
    if (err instanceof AuthError || (err instanceof ApiError && err.status === 401)) {
      await endSession("Your session ended. Sign in again.");
      return;
    }
    state.sync = { status: "offline", error: errorText(err) };
  }
  render();
}

/** Loose chores go to "Life admin". Created once, with the exact body the
 *  Android app also uses, and only after a sync proves it's missing. */
async function ensureLifeAdmin() {
  if (state.lifeAdminChecked) return;
  if (!state.cache.projects[M.LIFE_ADMIN.id]) {
    try {
      await api.createLifeAdmin();
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409)) return; // try again next sync
    }
    state.cache = await syncNow();
  }
  state.lifeAdminChecked = true;
}

async function endSession(message) {
  for (const p of state.pending.values()) clearTimeout(p.timer);
  state.pending.clear();
  await signOut();
  state.cache = getCache();
  state.signedIn = false;
  state.lifeAdminChecked = false;
  hideToast();
  renderSignIn("password", message);
}

setInterval(() => {
  if (state.signedIn && document.visibilityState === "visible") doSync();
}, SYNC_EVERY_MS);
document.addEventListener("visibilitychange", () => {
  if (!state.signedIn || document.visibilityState !== "visible") return;
  if (!state.cache.lastSyncedAt || Date.now() - state.cache.lastSyncedAt > 15 * 1000) doSync();
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** The full-replace PUT body for a task, from its current row plus overrides. */
function taskBody(task, overrides = {}) {
  const merged = {
    title: task.title,
    description: task.description ?? "",
    completionCriteria: task.completionCriteria ?? "",
    status: task.status,
    blockedReason: task.blockedReason ?? undefined,
    priority: task.priority,
    evidenceUrl: task.evidenceUrl ?? undefined,
    expectedUpdatedAt: task.updatedAt,
    ...overrides,
  };
  if (merged.status !== "blocked" || !merged.blockedReason) delete merged.blockedReason;
  if (!merged.evidenceUrl) delete merged.evidenceUrl;
  if (merged.recurrence === undefined) delete merged.recurrence;
  return merged;
}

/** PUT a task. On a 409 it re-syncs and records what changed instead of
 *  overwriting; returns false in that case. Other errors throw. */
async function putTask(task, overrides, { what = "Your change" } = {}) {
  try {
    await api.updateTask(task.id, taskBody(task, overrides));
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      await doSync();
      const now = state.cache.tasks[task.id];
      state.notices[task.id] = {
        tone: "warn",
        title: `${what} wasn't saved: this task changed on the server first.`,
        diff: M.taskDiff(task, now),
        body: "Nothing was overwritten. Here's what changed. Try again if you still want to.",
      };
      render();
      return false;
    }
    throw err;
  }
  delete state.notices[task.id];
  await doSync();
  return true;
}

function complete(taskId, { approve = false } = {}) {
  const task = state.cache.tasks[taskId];
  if (!task || state.pending.has(taskId)) return;
  const timer = setTimeout(() => commitComplete(taskId), UNDO_MS);
  state.pending.set(taskId, { timer, task, approve });
  let extra = "";
  if (M.isRecurring(task)) {
    const next = M.dueDay({ ...task, nextDueAt: M.computeNextDueAt(task, Date.now()) });
    extra = ` Next due <span class="mono">${esc(M.fmtDay(next))}</span>`;
  }
  showToast({
    html: `<span><b>${approve ? "Approved." : "Done."}</b>${extra}</span>`,
    undo: () => undoComplete(taskId),
  });
  render();
}

function undoComplete(taskId) {
  const p = state.pending.get(taskId);
  if (!p) return;
  clearTimeout(p.timer);
  state.pending.delete(taskId);
  hideToast();
  render();
}

async function commitComplete(taskId) {
  const p = state.pending.get(taskId);
  if (!p) return;
  clearTimeout(p.timer);
  if (state.toast?.taskId === taskId) hideToast();
  try {
    await putTask(p.task, { status: "done" }, { what: p.approve ? "The approval" : "Marking it done" });
  } catch (err) {
    showToast({ html: `<span><b>Not saved.</b> ${esc(p.task.title)}: ${esc(errorText(err))}</span>`, bad: true, ms: 8000 });
  } finally {
    state.pending.delete(taskId);
    render();
  }
}

// Don't lose a check-off when the tab closes inside the Undo window.
window.addEventListener("pagehide", () => {
  for (const taskId of [...state.pending.keys()]) commitComplete(taskId);
});

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer = null;
function showToast({ html, undo = null, bad = false, ms = UNDO_MS }) {
  clearTimeout(toastTimer);
  state.toast = { undo, taskId: null };
  if (undo) {
    // The most recent pending completion owns the Undo button.
    state.toast.taskId = [...state.pending.keys()].pop() ?? null;
  }
  toastEl.className = `toast${bad ? " bad" : ""}`;
  toastEl.innerHTML = `${html}${undo ? `<button class="undo" data-action="toast-undo">Undo</button>` : ""}`;
  toastEl.hidden = false;
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() {
  clearTimeout(toastTimer);
  state.toast = null;
  toastEl.hidden = true;
  toastEl.innerHTML = "";
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

function renderSignIn(step = "password", error = "") {
  state.signedIn = false;
  document.title = "The Process";
  root.innerHTML = `
    <div class="signin">
      <div class="signin-card">
        <div class="edges" aria-hidden="true"><i></i><i></i></div>
        <h1>The Process</h1>
        ${
          step === "password"
            ? `<form id="signin-form" data-step="password">
                 <label class="field"><span>Email</span><input name="email" type="email" autocomplete="username" required></label>
                 <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
                 <button class="btn primary">Sign in</button>
                 <div class="error" role="alert">${esc(error)}</div>
               </form>`
            : `<form id="signin-form" data-step="totp">
                 <label class="field"><span>Code from your authenticator</span>
                   <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>
                 <button class="btn primary">Verify</button>
                 <div class="error" role="alert">${esc(error)}</div>
               </form>`
        }
      </div>
    </div>`;
  const form = root.querySelector("#signin-form");
  form.querySelector("input").focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      if (step === "password") {
        await signInEmail(f.get("email"), f.get("password"));
        renderSignIn("totp");
      } else {
        await verifyTotp(String(f.get("code")).trim());
        startApp();
      }
    } catch (err) {
      renderSignIn(step, err instanceof AuthError ? err.message : errorText(err));
    }
  });
}

function startApp() {
  state.signedIn = true;
  state.cache = getCache();
  render();
  doSync();
}

// ---------------------------------------------------------------------------
// Render: keep typed text, focus and scroll across full redraws
// ---------------------------------------------------------------------------

function captureUi() {
  const values = {};
  for (const el of root.querySelectorAll("[data-keep]")) {
    const key = el.dataset.keep;
    if (el.type === "radio" || el.type === "checkbox") values[`${key}=${el.value}`] = el.checked;
    else values[key] = el.value;
  }
  const active = document.activeElement;
  const focus =
    active && root.contains(active) && active.dataset.keep
      ? { key: active.dataset.keep, value: active.value, start: active.selectionStart, end: active.selectionEnd }
      : null;
  return {
    values,
    focus,
    center: root.querySelector(".center")?.scrollTop ?? 0,
    detail: root.querySelector(".detail")?.scrollTop ?? 0,
  };
}

function restoreUi(ui, { resetCenter, resetDetail }) {
  for (const el of root.querySelectorAll("[data-keep]")) {
    const key = el.dataset.keep;
    if (el.type === "radio" || el.type === "checkbox") {
      const v = ui.values[`${key}=${el.value}`];
      if (v !== undefined) el.checked = v;
    } else if (ui.values[key] !== undefined) {
      el.value = ui.values[key];
    }
  }
  for (const form of root.querySelectorAll("form[data-form]")) syncFormVisibility(form);
  if (ui.focus) {
    const el = [...root.querySelectorAll("[data-keep]")].find(
      (n) => n.dataset.keep === ui.focus.key && (n.type !== "radio" || n.value === ui.focus.value),
    );
    if (el) {
      el.focus({ preventScroll: true });
      try {
        if (ui.focus.start != null) el.setSelectionRange(ui.focus.start, ui.focus.end);
      } catch {
        // not a text field
      }
    }
  }
  const center = root.querySelector(".center");
  const detail = root.querySelector(".detail");
  if (center) center.scrollTop = resetCenter ? 0 : ui.center;
  if (detail) detail.scrollTop = resetDetail ? 0 : ui.detail;
}

function render(opts = {}) {
  if (!state.signedIn) return;
  const ui = captureUi();
  const r = state.route;
  const task = r.taskId ? state.cache.tasks[r.taskId] : null;
  root.innerHTML = `
    <div class="shell ${r.taskId ? "has-detail" : "no-detail"}">
      ${railHtml()}
      <main class="center" aria-label="List"><div class="center-inner">${centerHtml()}</div></main>
      <aside class="detail" aria-label="Details">${detailHtml(task)}</aside>
      ${bottomNavHtml()}
      <button class="fab" data-action="quick-add" aria-label="Add a task">+</button>
    </div>`;
  restoreUi(ui, opts);
  document.title = titleFor(r);
}

function titleFor(r) {
  const names = { today: "Today", upcoming: "Upcoming", review: "Review", projects: "Projects" };
  const name = r.view === "project" ? state.cache.projects[r.projectId]?.title ?? "Project" : names[r.view];
  return `${name} · The Process`;
}

function syncText() {
  const at = state.cache.lastSyncedAt;
  if (state.sync.status === "syncing") return { dot: "busy", text: "syncing…" };
  if (state.sync.status === "offline") return { dot: "off", text: at ? `offline · last sync ${M.fmtAgo(at)}` : "offline · never synced" };
  return { dot: "", text: at ? `synced ${M.fmtAgo(at)}` : "not synced yet" };
}
function syncLineHtml() {
  const s = syncText();
  const title = state.sync.status === "offline" && state.sync.error ? ` title="${esc(state.sync.error)}"` : "";
  return `<span class="sync-line"${title}><span class="sync-dot ${s.dot}"></span><span class="sync-text">${esc(s.text)}</span></span>`;
}
function renderSyncLines() {
  const s = syncText();
  for (const el of root.querySelectorAll(".sync-line")) {
    el.querySelector(".sync-dot").className = `sync-dot ${s.dot}`;
    el.querySelector(".sync-text").textContent = s.text;
  }
}
setInterval(renderSyncLines, 30 * 1000);

// ---------------------------------------------------------------------------
// Rail and bottom nav
// ---------------------------------------------------------------------------

function counts() {
  const today = M.todayGroups(state.cache).reduce((n, g) => n + g.tasks.length, 0);
  const upcoming = M.upcomingGroups(state.cache).reduce((n, g) => n + g.tasks.length, 0);
  const review = M.reviewTasks(state.cache).length;
  return { today, upcoming, review };
}

function railHtml() {
  const r = state.route;
  const c = counts();
  const { ai, personal } = M.railProjects(state.cache);
  const item = (href, label, n, on, badge = false) =>
    `<a class="rail-item${on ? " on" : ""}" href="${href}"${on ? ' aria-current="page"' : ""}>
       <span class="name">${esc(label)}</span>${n ? (badge ? `<span class="badge">${n}</span>` : `<span class="n">${n}</span>`) : ""}</a>`;
  const projectItems = (list) =>
    list.length
      ? list.map((p) => item(projectHref(p.id), p.title, M.openCount(state.cache, p.id), r.view === "project" && r.projectId === p.id)).join("")
      : `<div class="rail-empty">None yet</div>`;
  return `
    <aside class="rail" aria-label="Views and projects">
      <div class="logo">The Process</div>
      <button class="btn primary add" data-action="quick-add">+ Add task</button>
      <nav>
        ${item("#/today", "Today", c.today, r.view === "today")}
        ${item("#/upcoming", "Upcoming", c.upcoming, r.view === "upcoming")}
        ${item("#/review", "Review", c.review, r.view === "review", true)}
      </nav>
      <div class="rail-sep ai"><i></i>AI work</div>
      <nav>${projectItems(ai)}</nav>
      <div class="rail-sep personal"><i></i>Life</div>
      <nav>${projectItems(personal)}</nav>
      <nav style="margin-top:10px">${item("#/projects", "All projects", 0, r.view === "projects")}</nav>
      <div class="rail-foot">
        <button class="btn small ghost" data-action="new-project" style="justify-self:start">+ New project</button>
        ${syncLineHtml()}
        <div class="btns">
          <button class="btn small" data-action="sync">Sync now</button>
          <button class="btn small ghost" data-action="sign-out">Sign out</button>
        </div>
      </div>
    </aside>`;
}

function bottomNavHtml() {
  const r = state.route;
  const c = counts();
  const link = (href, label, on, badge) =>
    `<a href="${href}" class="${on ? "on" : ""}">${label}${badge ? `<span class="badge">${badge}</span>` : ""}</a>`;
  return `<nav class="bottom-nav" aria-label="Views">
    ${link("#/today", "Today", r.view === "today")}
    ${link("#/upcoming", "Upcoming", r.view === "upcoming")}
    ${link("#/projects", "Projects", r.view === "projects" || r.view === "project")}
    ${link("#/review", "Review", r.view === "review", c.review)}
  </nav>`;
}

// ---------------------------------------------------------------------------
// Center views
// ---------------------------------------------------------------------------

function reviewerOf(task) {
  if (task.claimedBy && !isOwner(task.claimedBy)) return task.claimedBy;
  const lastAgent = M.progressFor(state.cache, task.id).find((p) => !isOwner(p.actorId));
  return lastAgent?.actorId ?? null;
}

/** One task row. `due`: "all" shows any due date, "late" only overdue ones. */
function rowHtml(task, { showProject = true, due = "all" } = {}) {
  const project = projectOf(task);
  const domain = domainOf(project);
  const pending = state.pending.has(task.id);
  const closed = task.status === "done" || task.status === "cancelled";
  const recurring = M.isRecurring(task);
  const selected = state.route.taskId === task.id;
  const meta = [];
  if (showProject) meta.push(`<span>${esc(project?.title ?? "Unknown project")}</span>`);
  const rec = M.recurrenceText(task);
  if (rec) meta.push(`<span>${esc(rec)}</span>`);
  const dl = M.dueLabel(task);
  if (dl && !closed && (due === "all" || dl.late)) meta.push(`<span class="${dl.late ? "late" : ""}">${esc(dl.text)}</span>`);
  if (task.status === "needs_review") {
    const who = reviewerOf(task);
    meta.push(`<span class="chip review">${who ? `${esc(who)} · ` : ""}review</span>`);
  } else if (task.status === "blocked") meta.push(`<span class="chip late">blocked</span>`);
  else if (task.status === "in_progress") meta.push(`<span>in progress</span>`);
  else if (task.status === "cancelled") meta.push(`<span>cancelled</span>`);
  if (!closed && task.claimedBy && !isOwner(task.claimedBy) && task.status !== "needs_review") {
    meta.push(`<span class="chip ai">${esc(task.claimedBy)} has it</span>`);
  }
  if (task.evidenceUrl && task.status === "needs_review") {
    meta.push(`<a href="${esc(task.evidenceUrl)}" target="_blank" rel="noopener noreferrer">evidence ↗</a>`);
  }
  if (!closed) meta.push(`<span>${esc(task.priority)}</span>`);

  const tick = closed
    ? `<span class="tick static${task.status === "done" ? " on" : ""}" aria-hidden="true">${task.status === "done" ? CHECK : ""}</span>`
    : `<button class="tick${recurring ? " recur" : ""}${pending ? " on" : ""}" data-action="complete" data-id="${esc(task.id)}"
         aria-label="${recurring ? "Mark done (repeats)" : "Mark done"}: ${esc(task.title)}"${pending ? " disabled" : ""}>${CHECK}</button>`;
  return `
    <div class="row ${domain}${selected ? " sel" : ""}${pending ? " pending" : ""}${closed ? " closed" : ""}"
         data-open="${esc(task.id)}" tabindex="0" role="link" aria-label="${esc(task.title)}">
      ${tick}
      <div><div class="t">${esc(task.title)}</div>${meta.length ? `<div class="m">${meta.join("")}</div>` : ""}</div>
      <span class="dom">${domainTag(domain)}</span>
    </div>`;
}

function groupHtml(label, tasks, rowOpts) {
  if (!tasks.length) return "";
  return `<section class="grp" aria-label="${esc(label)}">
    <div class="grp-label"><span>${esc(label)}</span><span>${tasks.length}</span></div>
    ${tasks.map((t) => rowHtml(t, rowOpts)).join("")}
  </section>`;
}

function headHtml(title, sub = "", actions = "", kicker = "") {
  return `<header class="page-head">
    <div class="topbar"><span class="logo">The Process</span>${syncLineHtml()}</div>
    ${kicker}
    <h1>${esc(title)}</h1>
    ${sub ? `<div class="sub">${sub}</div>` : ""}
    ${actions ? `<div class="row-actions">${actions}</div>` : ""}
  </header>`;
}

function todayDateText() {
  return new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function centerHtml() {
  switch (state.route.view) {
    case "upcoming":
      return upcomingHtml();
    case "review":
      return reviewHtml();
    case "projects":
      return projectsHtml();
    case "project":
      return projectHtml();
    default:
      return todayHtml();
  }
}

function todayHtml() {
  const groups = M.todayGroups(state.cache);
  const any = groups.some((g) => g.tasks.length);
  const neverSynced = !state.cache.lastSyncedAt;
  return `${headHtml("Today", `<span>${esc(todayDateText())}</span>`)}
    ${
      any
        ? groups.map((g) => groupHtml(g.label, g.tasks)).join("")
        : `<p class="empty">${
            neverSynced
              ? "Loading your tasks…"
              : "<b>Nothing needs you today.</b> Flag a task <span class='mono'>now</span> to put it here, or check Upcoming."
          }</p>`
    }`;
}

function upcomingHtml() {
  const groups = M.upcomingGroups(state.cache);
  return `${headHtml("Upcoming", "<span>next 14 days</span>")}
    ${
      groups.length
        ? groups.map((g) => groupHtml(g.label, g.tasks, { due: "late" })).join("")
        : `<p class="empty"><b>Nothing due in the next two weeks.</b> Repeating tasks show up here as their next due date comes near.</p>`
    }`;
}

function reviewHtml() {
  const tasks = M.reviewTasks(state.cache);
  return `${headHtml("Review", "<span>finished work waiting on you</span>")}
    ${
      tasks.length
        ? `<section class="grp">${tasks.map((t) => rowHtml(t)).join("")}</section>`
        : `<p class="empty"><b>Nothing to review.</b> When an agent finishes a task, it lands here with its evidence.</p>`
    }`;
}

function countsLineHtml(c) {
  const part = (k, n, label) => `<span class="k-${k}"><b>${n}</b> ${label}</span>`;
  return `<div class="counts-line">
    ${part("done", `${c.done} of ${c.total}`, "done")}
    ${part("review", c.review, "needs review")}
    ${part("claimed", c.claimed, "claimed by an agent")}
    ${part("open", c.open, "open")}
    ${c.cancelled ? `<span>${c.cancelled} cancelled</span>` : ""}
  </div>`;
}

function projectCardHtml(p) {
  const domain = domainOf(p);
  const c = M.projectCounts(state.cache, p.id, ownerId());
  return `<a class="row project-card ${domain}" href="${projectHref(p.id)}">
    <span class="t">${esc(p.title)}${p.status !== "active" ? ` <span class="muted mono" style="font-size:12px">${esc(p.status)}</span>` : ""}</span>
    <span class="m">${c.done} of ${c.total} done · ${c.review} review · ${c.claimed} claimed · ${c.open} open</span>
    <span class="dom">${domainTag(domain)}</span>
  </a>`;
}

function projectsHtml() {
  const { ai, personal } = M.railProjects(state.cache);
  const finished = M.finishedProjects(state.cache);
  const sec = (label, list) =>
    list.length
      ? `<section class="grp"><div class="grp-label"><span>${label}</span><span>${list.length}</span></div>${list.map(projectCardHtml).join("")}</section>`
      : "";
  const empty = !ai.length && !personal.length && !finished.length;
  return `${headHtml("Projects", "", `<button class="btn small" data-action="new-project">+ New project</button>`)}
    ${empty ? `<p class="empty">No projects yet.</p>` : ""}
    ${sec("AI work", ai)}${sec("Life", personal)}${sec("Finished", finished)}`;
}

function projectHtml() {
  const p = state.cache.projects[state.route.projectId];
  if (!p) {
    return `${headHtml("Project not found")}<p class="empty">It may not have synced yet. <a href="#/projects">All projects</a></p>`;
  }
  const domain = domainOf(p);
  const c = M.projectCounts(state.cache, p.id, ownerId());
  const tasks = M.projectTasks(state.cache, p.id);
  const open = tasks.filter((t) => M.OPEN.has(t.status));
  const closed = tasks.filter((t) => !M.OPEN.has(t.status));
  const decisions = M.decisionsFor(state.cache, p.id);
  const kicker = `<div class="kicker"><span class="chip ${domain}">${domain === "ai" ? "AI project" : "Life project"}</span>${
    p.status !== "active" ? `<span>${esc(p.status)}</span>` : ""
  }</div>`;
  const links = [
    ["Repo", p.repoUrl],
    ["Live", p.deployedUrl],
    ["Docs", p.docsUrl],
  ].filter(([, u]) => u);
  const fact = (label, value) => (value ? `<div><div class="label">${label}</div><div class="v">${esc(value)}</div></div>` : "");
  const k = `dec-${p.id}`;
  return `${headHtml(
    p.title,
    p.nextAction ? `<span>next: ${esc(p.nextAction)}</span>` : "",
    `<button class="btn small" data-action="quick-add" data-project="${esc(p.id)}">+ Add task here</button>`,
    kicker,
  )}
    <section class="counts" aria-label="Counts">${countsLineHtml(c)}</section>
    <section class="facts">
      ${fact("Purpose", p.purpose)}${fact("Outcome", p.outcome)}${fact("Summary", p.summary)}
      ${
        links.length
          ? `<div><div class="label">Links</div><div class="v links">${links
              .map(([l, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${l} ↗</a>`)
              .join("")}</div></div>`
          : ""
      }
    </section>
    ${open.length ? groupHtml("Tasks", open, { showProject: false }) : `<p class="empty">No open tasks.</p>`}
    ${
      closed.length
        ? `<details class="grp"><summary class="grp-label" style="cursor:pointer"><span>Done and cancelled</span><span>${closed.length}</span></summary>
             <div class="grp" style="margin-top:7px">${closed.map((t) => rowHtml(t, { showProject: false })).join("")}</div></details>`
        : ""
    }
    <section class="grp" aria-label="Decisions">
      <div class="grp-label"><span>Decisions</span><span>${decisions.length}</span></div>
      <form class="decision-form" data-form="decision" data-project="${esc(p.id)}">
        <input type="hidden" name="id" value="${uuid()}" data-keep="${k}-id">
        <label class="field"><span class="sr-only">Record a decision</span>
          <textarea name="text" rows="2" maxlength="2000" required placeholder="Record a decision…" data-keep="${k}-text"></textarea></label>
        <div class="error" role="alert"></div>
        <div class="btns"><button class="btn small primary">Record decision</button></div>
      </form>
      ${decisions
        .map(
          (d) => `<div class="decision"><span class="prose">${esc(d.text)}</span>
            <span class="m">${esc(M.fmtWhen(d.createdAt))} · ${esc(actorName(d.decidedBy))}</span></div>`,
        )
        .join("")}
    </section>`;
}

// ---------------------------------------------------------------------------
// Detail pane
// ---------------------------------------------------------------------------

function detailHtml(task) {
  if (!state.route.taskId) {
    return `<div class="detail-inner"><p class="empty">Select a task to see its details, notes and history.</p></div>`;
  }
  const back = `<a class="btn small ghost back" href="${baseHref()}" aria-label="Close details">← Back</a>`;
  if (!task) {
    return `<div class="detail-inner"><div class="detail-top">${back}</div>
      <p class="empty">This task isn't in your local copy. It may not have synced yet.</p></div>`;
  }
  const project = projectOf(task);
  const domain = domainOf(project);
  const closed = task.status === "done" || task.status === "cancelled";
  const pending = state.pending.has(task.id);
  const editing = state.edit?.taskId === task.id;

  const actions = [];
  if (!editing) {
    if (task.status === "needs_review") {
      actions.push(`<button class="btn good" data-action="approve" data-id="${esc(task.id)}"${pending ? " disabled" : ""}>Approve · mark done</button>`);
      actions.push(`<button class="btn" data-action="send-back" data-id="${esc(task.id)}">Send back</button>`);
      if (task.evidenceUrl) actions.push(`<a class="btn" href="${esc(task.evidenceUrl)}" target="_blank" rel="noopener noreferrer">Open evidence ↗</a>`);
    } else if (!closed) {
      actions.push(`<button class="btn good" data-action="complete" data-id="${esc(task.id)}"${pending ? " disabled" : ""}>${
        M.isRecurring(task) ? "Mark done · it repeats" : "Mark done"
      }</button>`);
    } else {
      actions.push(`<button class="btn" data-action="reopen" data-id="${esc(task.id)}">Reopen</button>`);
    }
    actions.push(`<button class="btn" data-action="edit" data-id="${esc(task.id)}">Edit</button>`);
  }

  return `<div class="detail-inner">
    <div class="detail-top">
      <div class="kicker"><span class="dot" style="background:var(--${domain === "ai" ? "ai" : "personal"})"></span>
        <span>${esc(M.STATUS_LABEL[task.status] ?? task.status)}</span><span>·</span>
        ${project ? `<a href="${projectHref(project.id)}" style="color:inherit">${esc(project.title)}</a>` : "<span>Unknown project</span>"}
        <span class="chip ${domain}">${domainTag(domain)}</span>
      </div>
      ${back}
    </div>
    <h2>${esc(task.title)}</h2>
    ${noticeHtml(task)}
    ${actions.length ? `<div class="btns">${actions.join("")}</div>` : ""}
    ${state.sendBack === task.id ? sendBackHtml(task) : ""}
    ${editing ? editFormHtml(task) : factsHtml(task)}
    ${progressHtml(task)}
  </div>`;
}

function noticeHtml(task) {
  const n = state.notices[task.id];
  if (!n) return "";
  return `<div class="notice${n.tone === "bad" ? " bad" : ""}" role="alert">
    <h3>${esc(n.title)}</h3>
    ${diffListHtml(n.diff)}
    ${n.body ? `<p>${esc(n.body)}</p>` : ""}
    <div class="btns"><button class="btn small" data-action="dismiss-notice" data-id="${esc(task.id)}">OK</button></div>
  </div>`;
}

function diffListHtml(diff) {
  if (!diff?.length) return "";
  return `<ul>${diff
    .map((d) => `<li><b>${esc(d.label)}</b>: <span class="from">${esc(d.from)}</span> → ${esc(d.to)}</li>`)
    .join("")}</ul>`;
}

function factsHtml(task) {
  const rows = [];
  const kv = (k, v) => rows.push(`<dt>${k}</dt><dd>${v}</dd>`);
  kv("Status", esc(M.STATUS_LABEL[task.status] ?? task.status));
  kv("Priority", `<span class="mono">${esc(task.priority)}</span>`);
  kv("Repeats", `<span class="${M.isRecurring(task) ? "mono" : "muted"}">${esc(M.recurrenceLong(task))}</span>`);
  const day = M.dueDay(task);
  if (day !== null) {
    const dl = M.dueLabel(task);
    kv("Next due", `<span class="mono">${esc(M.fmtDayLong(day))}</span>${dl?.late ? ` <span class="late mono">${esc(dl.text)}</span>` : ""}`);
  }
  if (task.lastCompletedAt) kv("Last done", `<span class="mono">${esc(M.fmtWhen(task.lastCompletedAt))}</span>`);
  if (task.status === "blocked") kv("Blocked", `<span class="late">${esc(task.blockedReason || "No reason given")}</span>`);
  kv(
    "Evidence",
    task.evidenceUrl
      ? `<a href="${esc(task.evidenceUrl)}" target="_blank" rel="noopener noreferrer">${esc(task.evidenceUrl)}</a>`
      : `<span class="muted">none</span>`,
  );
  if (task.claimedBy) kv("Claimed", `${esc(actorName(task.claimedBy))} <span class="muted mono">${task.claimedAt ? esc(M.fmtAgo(task.claimedAt)) : ""}</span>`);
  const deps = M.dependenciesOf(state.cache, task.id);
  if (deps.length) {
    kv(
      "Waits on",
      deps
        .map((d) => `<a href="${taskHref(d.id)}">${esc(d.title)}</a> <span class="muted mono">${esc(M.STATUS_LABEL[d.status] ?? d.status)}</span>`)
        .join("<br>"),
    );
  }
  kv("Created", `<span class="mono">${esc(M.fmtWhen(task.createdAt))}</span> <span class="muted">by ${esc(actorName(task.createdBy))}</span>`);
  return `<dl class="kv">${rows.join("")}</dl>
    ${task.description ? `<div class="grp"><div class="label">Description</div><div class="prose">${esc(task.description)}</div></div>` : ""}
    ${task.completionCriteria ? `<div class="grp"><div class="label">Done when</div><div class="prose">${esc(task.completionCriteria)}</div></div>` : ""}`;
}

function sendBackHtml(task) {
  const k = `sb-${task.id}`;
  return `<form class="note-form" data-form="send-back" data-id="${esc(task.id)}">
    <input type="hidden" name="id" value="${uuid()}" data-keep="${k}-id">
    <label class="field"><span>What needs another pass?</span>
      <textarea name="note" rows="3" maxlength="3900" required data-keep="${k}-note"></textarea></label>
    <div class="error" role="alert"></div>
    <div class="btns"><button type="button" class="btn small ghost" data-action="cancel-send-back">Cancel</button>
      <button class="btn small primary">Send back · in progress</button></div>
  </form>`;
}

function progressHtml(task) {
  const items = M.progressFor(state.cache, task.id);
  const k = `pg-${task.id}`;
  return `<section class="grp" aria-label="Progress">
    <div class="label">Progress</div>
    <form class="note-form" data-form="progress" data-id="${esc(task.id)}">
      <input type="hidden" name="id" value="${uuid()}" data-keep="${k}-id">
      <label class="field"><span class="sr-only">Add a note</span>
        <textarea name="note" rows="2" maxlength="4000" required placeholder="Add a note…" data-keep="${k}-note"></textarea></label>
      <label class="field"><span class="sr-only">Link (optional)</span>
        <input name="linkUrl" type="url" placeholder="Link (optional)" data-keep="${k}-link"></label>
      <div class="error" role="alert"></div>
      <div class="btns"><button class="btn small">Add note</button></div>
    </form>
    <div class="log">
      ${
        items.length
          ? items
              .map(
                (p) => `<div class="log-item${isOwner(p.actorId) ? "" : " agent"}">
              <span class="note">${esc(p.note)}</span>
              ${p.linkUrl ? `<a href="${esc(p.linkUrl)}" target="_blank" rel="noopener noreferrer">${esc(p.linkUrl)}</a>` : ""}
              <span class="m">${esc(actorName(p.actorId))} · ${esc(M.fmtWhen(p.createdAt))}</span></div>`,
              )
              .join("")
          : `<p class="muted" style="font-size:14px">No notes yet.</p>`
      }
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Forms shared by quick add and edit
// ---------------------------------------------------------------------------

function priorityFieldHtml(value, keep = "") {
  return `<div class="field"><span>Priority</span><div class="seg" role="radiogroup" aria-label="Priority">
    ${["now", "soon", "someday"]
      .map(
        (p) => `<label><input type="radio" name="priority" value="${p}"${p === value ? " checked" : ""}${keep ? ` data-keep="${keep}"` : ""}><span>${p}</span></label>`,
      )
      .join("")}
  </div></div>`;
}

function repeatFieldHtml(task, keep = "") {
  const type = task?.recurrenceType ?? "none";
  const kp = (name) => (keep ? ` data-keep="${keep}-${name}"` : "");
  return `<div class="field repeat-opts"><span>Repeats</span>
    <select name="repeat"${kp("repeat")}>
      <option value="none"${type === "none" ? " selected" : ""}>Doesn't repeat</option>
      <option value="interval_days"${type === "interval_days" ? " selected" : ""}>Every few days, from when it's done</option>
      <option value="calendar_weekday"${type === "calendar_weekday" ? " selected" : ""}>Every week, on a set day</option>
      <option value="calendar_day_of_month"${type === "calendar_day_of_month" ? " selected" : ""}>Every month, on a set date</option>
    </select>
    <div class="inline-fields" data-when="interval_days">
      <span class="hint">every</span>
      <input type="number" name="intervalDays" min="1" max="3650" value="${task?.recurrenceIntervalDays ?? 7}" aria-label="Days between"${kp("interval")}>
      <span class="hint">days after it's done</span>
    </div>
    <div class="inline-fields" data-when="calendar_weekday">
      <span class="hint">every</span>
      <select name="weekday" aria-label="Weekday"${kp("weekday")}>
        ${M.WEEKDAYS.map((d, i) => `<option value="${i}"${i === (task?.recurrenceWeekday ?? 1) ? " selected" : ""}>${d}</option>`).join("")}
      </select>
    </div>
    <div class="inline-fields" data-when="calendar_day_of_month">
      <span class="hint">on day</span>
      <input type="number" name="dayOfMonth" min="1" max="31" value="${task?.recurrenceDayOfMonth ?? 1}" aria-label="Day of month"${kp("dom")}>
      <span class="hint">of each month (29 to 31 fall back to the month's last day)</span>
    </div>
  </div>`;
}

function readRecurrence(form) {
  const f = new FormData(form);
  switch (f.get("repeat")) {
    case "interval_days":
      return { type: "interval_days", intervalDays: Number(f.get("intervalDays")) };
    case "calendar_weekday":
      return { type: "calendar_weekday", weekday: Number(f.get("weekday")) };
    case "calendar_day_of_month":
      return { type: "calendar_day_of_month", dayOfMonth: Number(f.get("dayOfMonth")) };
    default:
      return null;
  }
}

/** Show only the sub-fields that apply, and require only visible ones. */
function syncFormVisibility(form) {
  const repeat = form.querySelector("[name=repeat]");
  if (repeat) {
    for (const el of form.querySelectorAll("[data-when]")) {
      const on = el.dataset.when === repeat.value;
      el.hidden = !on;
      for (const input of el.querySelectorAll("input")) input.required = on;
    }
  }
  const status = form.querySelector("[name=status]");
  const blocked = form.querySelector("[data-when-status]");
  if (status && blocked) {
    const on = status.value === "blocked";
    blocked.hidden = !on;
    blocked.querySelector("textarea").required = on;
  }
}

function projectOptionsHtml(selectedId) {
  const { ai, personal } = M.railProjects(state.cache);
  if (!state.cache.projects[M.LIFE_ADMIN.id] && !personal.some((p) => p.id === M.LIFE_ADMIN.id)) {
    personal.unshift({ id: M.LIFE_ADMIN.id, title: M.LIFE_ADMIN.title });
  }
  const opts = (list) =>
    list.map((p) => `<option value="${esc(p.id)}"${p.id === selectedId ? " selected" : ""}>${esc(p.title)}</option>`).join("");
  return `${personal.length ? `<optgroup label="Life">${opts(personal)}</optgroup>` : ""}${
    ai.length ? `<optgroup label="AI work">${opts(ai)}</optgroup>` : ""
  }`;
}

const EDIT_FIELDS = {
  title: "Title",
  status: "Status",
  blockedReason: "Blocked reason",
  priority: "Priority",
  recurrence: "Repeats",
  evidenceUrl: "Evidence",
  description: "Description",
  completionCriteria: "Done when",
};

/** A task's editable fields, in the same shape readEditForm returns. */
function editValues(task) {
  return {
    title: task.title,
    status: task.status,
    blockedReason: task.blockedReason ?? "",
    priority: task.priority,
    evidenceUrl: task.evidenceUrl ?? "",
    description: task.description ?? "",
    completionCriteria: task.completionCriteria ?? "",
    recurrence: M.recurrenceInput(task),
  };
}
function readEditForm(form) {
  const f = new FormData(form);
  const s = (k) => String(f.get(k) ?? "").trim();
  return {
    title: s("title"),
    status: s("status"),
    blockedReason: s("blockedReason"),
    priority: s("priority"),
    evidenceUrl: s("evidenceUrl"),
    description: s("description"),
    completionCriteria: s("completionCriteria"),
    recurrence: readRecurrence(form),
  };
}
function changedFields(from, to) {
  const out = {};
  for (const k of Object.keys(EDIT_FIELDS)) if (JSON.stringify(from[k]) !== JSON.stringify(to[k])) out[k] = to[k];
  return out;
}
/** Forget typed values under `selector` so the next render starts from state. */
function dropKept(selector) {
  for (const el of root.querySelectorAll(`${selector} [data-keep]`)) el.removeAttribute("data-keep");
}

function editFormHtml(task) {
  const { base, conflict, overlay } = state.edit;
  const v = { ...editValues(base), ...(overlay ?? {}) };
  const r = v.recurrence;
  const repeatLike = {
    recurrenceType: r?.type ?? null,
    recurrenceIntervalDays: r?.intervalDays ?? null,
    recurrenceWeekday: r?.weekday ?? null,
    recurrenceDayOfMonth: r?.dayOfMonth ?? null,
  };
  const k = `ed-${task.id}`;
  const mineLabels = Object.keys(overlay ?? {}).map((f) => EDIT_FIELDS[f]);
  return `<form class="edit-form" data-form="edit" data-id="${esc(task.id)}">
    ${
      conflict
        ? `<div class="notice" role="alert"><h3>This task changed on the server while you were editing.</h3>
             ${diffListHtml(conflict)}
             <p>Nothing was overwritten. The form now shows the server's version${
               mineLabels.length ? ` with your changes to ${esc(mineLabels.join(", ").toLowerCase())} on top` : ""
             }. Save to keep them, or discard yours.</p></div>`
        : ""
    }
    <label class="field"><span>Title</span><input name="title" maxlength="200" required value="${esc(v.title)}" data-keep="${k}-title"></label>
    <label class="field"><span>Status</span><select name="status" data-keep="${k}-status">
      ${Object.entries(M.STATUS_LABEL)
        .map(([s, l]) => `<option value="${s}"${s === v.status ? " selected" : ""}>${l}</option>`)
        .join("")}
    </select></label>
    <label class="field" data-when-status="blocked"><span>Blocked because</span>
      <textarea name="blockedReason" rows="2" maxlength="1000" data-keep="${k}-blocked">${esc(v.blockedReason)}</textarea></label>
    ${priorityFieldHtml(v.priority, `${k}-priority`)}
    ${repeatFieldHtml(repeatLike, k)}
    <label class="field"><span>Evidence link</span><input name="evidenceUrl" type="url" maxlength="2000" value="${esc(v.evidenceUrl)}" data-keep="${k}-evidence"></label>
    <label class="field"><span>Description</span><textarea name="description" rows="4" maxlength="4000" data-keep="${k}-desc">${esc(v.description)}</textarea></label>
    <label class="field"><span>Done when</span><textarea name="completionCriteria" rows="2" maxlength="2000" data-keep="${k}-criteria">${esc(v.completionCriteria)}</textarea></label>
    <div class="error" role="alert"></div>
    <div class="btns">
      <button type="button" class="btn small ghost" data-action="cancel-edit">${conflict ? "Discard my edits" : "Cancel"}</button>
      <button class="btn small primary">${conflict ? "Save mine on top" : "Save"}</button>
    </div>
  </form>`;
}

// ---------------------------------------------------------------------------
// Dialogs: quick add and new project
// ---------------------------------------------------------------------------

function openQuickAdd(projectId = M.LIFE_ADMIN.id) {
  dialog.innerHTML = `<form class="dialog-form" data-form="quick-add">
    <h2>Add a task</h2>
    <input type="hidden" name="id" value="${uuid()}">
    <label class="field"><span>Title</span><input name="title" maxlength="200" required autocomplete="off"></label>
    <label class="field"><span>Project</span><select name="projectId">${projectOptionsHtml(projectId)}</select></label>
    ${priorityFieldHtml("soon")}
    ${repeatFieldHtml(null)}
    <label class="field"><span>Notes <span class="hint">(optional)</span></span><textarea name="description" rows="2" maxlength="4000"></textarea></label>
    <div class="error" role="alert"></div>
    <div class="btns"><button type="button" class="btn ghost" data-action="close-dialog">Cancel</button><button class="btn primary">Add task</button></div>
  </form>`;
  const form = dialog.querySelector("form");
  syncFormVisibility(form);
  dialog.showModal();
  form.querySelector("[name=title]").focus();
}

function openNewProject() {
  dialog.innerHTML = `<form class="dialog-form" data-form="new-project">
    <h2>New project</h2>
    <input type="hidden" name="id" value="${uuid()}">
    <label class="field"><span>Title</span><input name="title" maxlength="200" required autocomplete="off"></label>
    <div class="field"><span>Kind</span><div class="seg" role="radiogroup" aria-label="Kind">
      <label><input type="radio" name="domain" value="personal" checked><span>Life</span></label>
      <label><input type="radio" name="domain" value="ai"><span>AI work</span></label>
    </div><span class="hint">AI agents can never read Life projects.</span></div>
    <label class="field"><span>Purpose</span><textarea name="purpose" rows="2" maxlength="2000" required placeholder="Why this exists"></textarea></label>
    <label class="field"><span>Outcome</span><textarea name="outcome" rows="2" maxlength="2000" required placeholder="What done looks like"></textarea></label>
    <label class="field"><span>Next action <span class="hint">(optional)</span></span><input name="nextAction" maxlength="500"></label>
    <div class="error" role="alert"></div>
    <div class="btns"><button type="button" class="btn ghost" data-action="close-dialog">Cancel</button><button class="btn primary">Create project</button></div>
  </form>`;
  dialog.showModal();
  dialog.querySelector("[name=title]").focus();
}

// ---------------------------------------------------------------------------
// Form submissions
// ---------------------------------------------------------------------------

async function withForm(form, fn) {
  const button = form.querySelector("button:not([type=button])");
  const errorEl = form.querySelector(".error");
  if (button) button.disabled = true;
  if (errorEl) errorEl.textContent = "";
  try {
    await fn();
  } catch (err) {
    if (errorEl) errorEl.textContent = errorText(err);
  } finally {
    if (button && form.isConnected) button.disabled = false;
  }
}

/** After a successful create: clear the form and mint a fresh id, so the
 *  next submit is a new row while a failed one retried keeps its id. */
function resetForm(form) {
  form.reset();
  const id = form.querySelector("[name=id]");
  if (id) id.value = uuid();
}

const SUBMIT = {
  async "quick-add"(form) {
    const f = new FormData(form);
    const projectId = String(f.get("projectId"));
    if (projectId === M.LIFE_ADMIN.id && !state.cache.projects[projectId]) {
      try {
        await api.createLifeAdmin();
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409)) throw err;
      }
    }
    const recurrence = readRecurrence(form);
    const description = String(f.get("description") ?? "").trim();
    const title = String(f.get("title")).trim();
    await api.createTask({
      id: String(f.get("id")),
      projectId,
      title,
      priority: String(f.get("priority") || "soon"),
      ...(description ? { description } : {}),
      ...(recurrence ? { recurrence } : {}),
    });
    dialog.close();
    showToast({ html: `<span><b>Added.</b> ${esc(title)}</span>`, ms: 3000 });
    await doSync();
  },

  async "new-project"(form) {
    const f = new FormData(form);
    const nextAction = String(f.get("nextAction") ?? "").trim();
    const id = String(f.get("id"));
    await api.createProject({
      id,
      title: String(f.get("title")).trim(),
      purpose: String(f.get("purpose")).trim(),
      outcome: String(f.get("outcome")).trim(),
      domain: String(f.get("domain")),
      ...(nextAction ? { nextAction } : {}),
    });
    dialog.close();
    await doSync();
    location.hash = projectHref(id);
  },

  async decision(form) {
    const f = new FormData(form);
    await api.addDecision(form.dataset.project, String(f.get("text")).trim(), String(f.get("id")));
    resetForm(form);
    await doSync();
  },

  async progress(form) {
    const f = new FormData(form);
    const link = String(f.get("linkUrl") ?? "").trim();
    await api.addProgress(form.dataset.id, String(f.get("note")).trim(), link || undefined, String(f.get("id")));
    resetForm(form);
    await doSync();
  },

  async "send-back"(form) {
    const task = state.cache.tasks[form.dataset.id];
    if (!task) return;
    const f = new FormData(form);
    const note = String(f.get("note")).trim();
    const ok = await putTask(task, { status: "in_progress" }, { what: "Sending it back" });
    if (!ok) return;
    state.sendBack = null;
    try {
      await api.addProgress(task.id, `Sent back: ${note}`, undefined, String(f.get("id")));
      showToast({ html: `<span><b>Sent back.</b> It's in progress again.</span>`, ms: 3000 });
    } catch (err) {
      showToast({ html: `<span><b>Sent back, but the note wasn't saved.</b> ${esc(errorText(err))}</span>`, bad: true, ms: 8000 });
    }
    await doSync();
  },

  async edit(form) {
    const taskId = form.dataset.id;
    const base = state.edit?.base;
    if (!base) return;
    const values = readEditForm(form);
    if (values.status === "blocked" && !values.blockedReason) throw new Error("Say what it's blocked on.");
    // Only what the user actually changed; on a conflict this is all that
    // gets laid over the server's newer version.
    const mine = changedFields(editValues(base), values);
    const body = taskBody(base, {
      title: values.title,
      status: values.status,
      blockedReason: values.blockedReason || undefined,
      priority: values.priority,
      evidenceUrl: values.evidenceUrl || undefined,
      description: values.description,
      completionCriteria: values.completionCriteria,
      ...("recurrence" in mine ? { recurrence: values.recurrence } : {}),
    });
    try {
      await api.updateTask(taskId, body);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        dropKept('form[data-form="edit"]');
        await doSync();
        dropKept('form[data-form="edit"]');
        const latest = state.cache.tasks[taskId];
        state.edit = { taskId, base: latest, conflict: M.taskDiff(base, latest), overlay: mine };
        render();
        return;
      }
      throw err;
    }
    state.edit = null;
    delete state.notices[taskId];
    await doSync();
    const after = state.cache.tasks[taskId];
    if (values.status === "done" && after && M.isRecurring(after) && !("recurrence" in mine)) {
      const day = M.dueDay(after);
      showToast({ html: `<span><b>Done.</b> Next due <span class="mono">${esc(M.fmtDay(day))}</span></span>`, ms: 4000 });
    }
  },
};

document.addEventListener("submit", (e) => {
  const form = e.target.closest("form[data-form]");
  if (!form || !SUBMIT[form.dataset.form]) return;
  e.preventDefault();
  withForm(form, () => SUBMIT[form.dataset.form](form));
});

document.addEventListener("change", (e) => {
  const form = e.target.closest("form[data-form]");
  if (form && (e.target.name === "repeat" || e.target.name === "status")) syncFormVisibility(form);
});

// ---------------------------------------------------------------------------
// Clicks
// ---------------------------------------------------------------------------

const ACTIONS = {
  "quick-add": (el) => openQuickAdd(el.dataset.project || M.LIFE_ADMIN.id),
  "new-project": () => openNewProject(),
  "close-dialog": () => dialog.close(),
  sync: () => doSync(),
  "sign-out": () => endSession(""),
  complete: (el) => complete(el.dataset.id),
  approve: (el) => complete(el.dataset.id, { approve: true }),
  "toast-undo": () => state.toast?.undo?.(),
  "send-back": (el) => {
    state.sendBack = el.dataset.id;
    state.edit = null;
    render();
    root.querySelector('form[data-form="send-back"] textarea')?.focus();
  },
  "cancel-send-back": () => {
    state.sendBack = null;
    render();
  },
  edit: (el) => {
    const task = state.cache.tasks[el.dataset.id];
    if (!task) return;
    state.edit = { taskId: task.id, base: { ...task }, conflict: null };
    state.sendBack = null;
    render();
    root.querySelector('form[data-form="edit"] [name=title]')?.focus();
  },
  "cancel-edit": () => {
    // Drop the typed values so a later Edit starts from the current task.
    dropKept('form[data-form="edit"]');
    state.edit = null;
    render();
  },
  "dismiss-notice": (el) => {
    delete state.notices[el.dataset.id];
    render();
  },
  reopen: async (el) => {
    const task = state.cache.tasks[el.dataset.id];
    if (!task) return;
    el.disabled = true;
    try {
      await putTask(task, { status: "not_started" }, { what: "Reopening it" });
    } catch (err) {
      showToast({ html: `<span><b>Not saved.</b> ${esc(errorText(err))}</span>`, bad: true, ms: 8000 });
      render();
    }
  },
};

document.addEventListener("click", (e) => {
  const actionEl = e.target.closest("[data-action]");
  if (actionEl && ACTIONS[actionEl.dataset.action]) {
    e.preventDefault();
    e.stopPropagation();
    ACTIONS[actionEl.dataset.action](actionEl);
    return;
  }
  if (e.target.closest("a, button, input, select, textarea, label, summary")) return;
  const row = e.target.closest("[data-open]");
  if (row) location.hash = taskHref(row.dataset.open);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    const row = e.target.closest?.("[data-open]");
    if (row && e.target === row) {
      e.preventDefault();
      location.hash = taskHref(row.dataset.open);
    }
  }
  if (e.key === "Escape" && !dialog.open && state.route.taskId && !e.target.closest?.("form")) {
    location.hash = baseHref();
  }
});

// Close the dialog on a backdrop click.
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) dialog.close();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (isSignedIn()) startApp();
else renderSignIn();
