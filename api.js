import { API_BASE_URL } from "./config.js";
import { getValidJwt } from "./auth.js";
import { LIFE_ADMIN } from "./model.js";

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** One tracker call with the owner JWT, refreshing once on a 401 (a JWT that
 *  expired inside the safety margin). 409 conflicts surface as ApiError with
 *  status 409 — the caller decides whether to reload and retry. */
export async function call(path, { method = "GET", body } = {}) {
  const send = (jwt) =>
    fetch(`${API_BASE_URL}/tracker${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  let response = await send(await getValidJwt());
  if (response.status === 401) {
    response = await send(await getValidJwt({ forceRefresh: true }));
  }
  let json = null;
  try {
    json = await response.json();
  } catch {
    // empty body
  }
  if (!response.ok) {
    throw new ApiError(response.status, json?.message || json?.error || `Request failed (${response.status})`, json);
  }
  return json;
}

const id = () => crypto.randomUUID();

// Creates take a client-generated id so a retry is a no-op on the server.
// Callers that may retry (forms) pass their own `id`, minted once per form.
export const api = {
  issueAgentKey: (id, actorId) => call("/agent-keys", { method: "POST", body: { id, actorId } }),
  changes: (since) => call(`/changes?since=${since}`),
  attention: () => call("/attention"),
  /** Exactly this body, so the Android app's create converges on the same row. */
  createLifeAdmin: () => call("/projects", { method: "POST", body: { ...LIFE_ADMIN } }),
  createProject: (fields) => call("/projects", { method: "POST", body: { id: id(), ...fields } }),
  updateProject: (projectId, fields) => call(`/projects/${encodeURIComponent(projectId)}`, { method: "PUT", body: fields }),
  addDecision: (projectId, text, decisionId = id()) =>
    call(`/projects/${encodeURIComponent(projectId)}/decisions`, { method: "POST", body: { id: decisionId, text } }),
  createTask: (fields) => call("/tasks", { method: "POST", body: { id: id(), ...fields } }),
  updateTask: (taskId, fields) => call(`/tasks/${encodeURIComponent(taskId)}`, { method: "PUT", body: fields }),
  claimTask: (taskId) => call(`/tasks/${encodeURIComponent(taskId)}/claim`, { method: "POST" }),
  releaseTask: (taskId) => call(`/tasks/${encodeURIComponent(taskId)}/release`, { method: "POST" }),
  addProgress: (taskId, note, linkUrl, progressId = id()) =>
    call(`/tasks/${encodeURIComponent(taskId)}/progress`, {
      method: "POST",
      body: { id: progressId, note, ...(linkUrl ? { linkUrl } : {}) },
    }),
  addDependency: (taskId, dependsOnTaskId) =>
    call(`/tasks/${encodeURIComponent(taskId)}/dependencies`, { method: "POST", body: { dependsOnTaskId } }),
};
