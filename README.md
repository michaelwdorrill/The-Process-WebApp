# The Process — web client

The web client for The Process, the single tracker for AI-collaborative work and
personal life tasks. It's served at **https://theprocess.website** from GitHub Pages.
The backend is the `tracker` Worker in the Home Base repo (`workers/tracker`), and
its README is the API reference.

Plain HTML/CSS/ES modules with no build step, the same pattern as the Heavy
Machinery and Disciplined Dollar web apps.

## Files

| File | What it does |
|---|---|
| `index.html`, `style.css`, `favicon.svg` | Page shell and the dark-first look from the approved concept |
| `app.js` | Routing, the three panes, forms, writes, conflict handling |
| `model.js` | Pure derivations: Today / Upcoming / Review lists, due days, recurrence text, project counts, conflict diffs |
| `sync.js` | Local copy in `localStorage`, kept current through `GET /tracker/changes` |
| `api.js` | Tracker API wrapper (owner JWT, one retry on 401) |
| `auth.js`, `storage.js`, `config.js` | Email + password + TOTP sign-in and JWT refresh, copied from the sibling apps |
| `CNAME` | `theprocess.website` for GitHub Pages |

## Screens

Three panes on a desktop (rail, list, detail). Below 1180px the detail slides over
the list. Below 760px it's one column with a bottom nav and a + button.

- **Today** (home): open tasks from both domains in one list, grouped Now / Needs
  your review / Due today / Soon / Someday (the last two collapsible). A blocked
  task is demoted out of Now by the same `effectivePriorityRank` rule as the
  project page, rather than always forced into Now.
- **Upcoming**: open tasks due in the next 14 days, by day, overdue first.
- **Review**: `needs_review` tasks. Approve marks it done. Send back sets it to
  `in_progress` and logs a "Sent back: …" progress note.
- **Projects / project page**: counts (done of total, needs review, claimed by an
  agent, open — never a percentage), tasks, the decisions log, a form to record a
  decision. Open tasks group into collapsible Now/Soon/Someday sections; a task
  waiting on an unfinished dependency displays one tier behind its most urgent
  unmet blocker (never above its own stored priority), recomputed live so it
  moves back up once that dependency clears — same rule as the Android client's
  `effectivePriorityRank` (`domain/TodayLogic.kt`), ported here as
  `effectivePriorityRank` in `model.js`. A task marked `blocked` with no tracked
  dependency is still demoted one tier behind itself (a web-only extension of
  the rule; the Android client only demotes via a tracked dependency).
- **Task detail**: status, priority, recurrence, next due, blocked reason, evidence,
  claim, dependencies, and the progress log, which is where agent notes live.
  Edit, mark done, reopen, add a note.
- **Quick add**: a plain form: title, project (defaults to Life admin), priority,
  optional repeat, optional notes.

AI work has a periwinkle edge and an "AI" tag, personal work an apricot edge and a
"Life" tag. Priority is shown by position, never by color. Repeating tasks have a
dashed check circle.

## Rules the client follows

- **Server is the source of truth.** Agents write too, so writes go straight to the
  API and every write is followed by `syncNow()`.
- **Creates are idempotent.** Each form mints its id once. A failed submit retried
  reuses it; a successful one mints a fresh id.
- **Updates are full replaces with `expectedUpdatedAt`.** On a 409 the client
  re-syncs and shows what changed. A one-click action (mark done, approve, reopen)
  isn't retried. An edit form switches to the server's version with only the fields
  you changed laid on top, and "Save mine on top" is a deliberate second click.
- **Check-off waits 5 seconds** before sending, so Undo sends nothing. The server
  can't undo a recurring completion (it can't set `nextDueAt` back, and the
  completion note is permanent). Closing the tab inside the window still tries
  to send it (best effort).
- **Recurring tasks** cycle back to `not_started` server-side. The toast shows
  "Done. Next due …" from a port of the server's `computeNextDueAt`.
- **Due dates are civil days.** Calendar recurrences are stored as UTC midnight, so
  their day is read in UTC. Interval recurrences are real instants, read in local
  time. "Overdue" and "due today" compare days, not milliseconds.
- **Life admin** (`5f1c0d2e-7a4b-4c3e-9b1a-2d8e6f0a4c71`) is created with the exact
  body the Android app uses, only after a sync shows it's missing. A 409 means it
  already exists.
- **Nothing is deleted.** There's no delete anywhere. Cancelling is a status.

## Known gap

One-off tasks can't have a due date: the tracker API only sets `nextDueAt` from a
recurrence. Quick add offers "repeat" only, and Upcoming / Due today only contain
repeating tasks until the server accepts a due date on create and update.

## Local development

```bash
python -m http.server 8080
```

The page loads from `localhost`, but signing in there fails. The auth Worker trusts
only `https://theprocess.website` and `https://michaelwdorrill.github.io` for
sign-in, and the tracker Worker's CORS allows the same two.

## Hosting

GitHub Pages from `main` / root, with the custom domain in `CNAME`. Namecheap DNS
for the apex domain:

- `A @` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
- `AAAA @` → `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`
- `CNAME www` → `michaelwdorrill.github.io.`

Turn on **Enforce HTTPS** in the repo's Pages settings once GitHub has issued the
certificate.

## Session storage

The session token lives in `localStorage`, the same accepted tradeoff the sibling
sites make: a single-owner site with no third-party script. The only third-party
request is the Google Fonts stylesheet. Sign-out clears everything.
