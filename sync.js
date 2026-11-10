// Local copy of the tracker, kept current via GET /tracker/changes. The server
// is the source of truth (AI agents write to it too), so this is pull-and-merge
// only: every returned row is upserted by id, and since the tracker never
// deletes rows there's nothing to remove. Writes go straight to the API; call
// syncNow() after one to pull the server's version back.
import { api } from "./api.js";
import { storage } from "./storage.js";

function emptyCache() {
  return { nextSince: 0, lastSyncedAt: null, projects: {}, tasks: {}, deps: {}, decisions: {}, progress: {} };
}

export function getCache() {
  return storage.loadCache() ?? emptyCache();
}

function merge(cache, page) {
  for (const p of page.projects) cache.projects[p.id] = p;
  for (const t of page.tasks) cache.tasks[t.id] = t;
  for (const d of page.taskDependencies) cache.deps[`${d.taskId}>${d.dependsOnTaskId}`] = d;
  for (const d of page.decisions) cache.decisions[d.id] = d;
  for (const p of page.progressUpdates) cache.progress[p.id] = p;
  cache.nextSince = page.nextSince;
}

let inFlight = null;

/** Pull every change since the last sync. Concurrent callers share one run. */
export function syncNow() {
  if (!inFlight) {
    inFlight = (async () => {
      const cache = getCache();
      for (;;) {
        const page = await api.changes(cache.nextSince);
        merge(cache, page);
        if (!page.hasMore) break;
      }
      cache.lastSyncedAt = Date.now();
      storage.saveCache(cache);
      return cache;
    })().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}
