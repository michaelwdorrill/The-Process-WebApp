// Same two-step sign-in as Heavy Machinery's web app (web/auth.js there).
// Works from https://theprocess.website and https://michaelwdorrill.github.io:
// the auth Worker trusts both for sign-in (Home Base SECURITY-REVIEW §35) and
// the tracker Worker's CORS allows both.
import { AUTH_BASE_URL } from "./config.js";
import { storage } from "./storage.js";

export class AuthError extends Error {}

async function parseJsonOrThrow(response, fallbackMessage) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    // no JSON body — fall through to the generic message
  }
  if (!response.ok) {
    throw new AuthError(body?.message || body?.error || fallbackMessage);
  }
  return body;
}

/** Step 1: email + password. Sets the short-lived two-factor bridge cookie. */
export async function signInEmail(email, password) {
  const response = await fetch(`${AUTH_BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await parseJsonOrThrow(response, "Sign-in failed — check your email and password.");
  if (!body?.twoFactorRedirect) {
    throw new AuthError("Expected a two-factor prompt but didn't get one.");
  }
}

/** Step 2: TOTP code. On success, persists the long-lived session token. */
export async function verifyTotp(code) {
  const response = await fetch(`${AUTH_BASE_URL}/api/auth/two-factor/verify-totp`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const body = await parseJsonOrThrow(response, "Incorrect code — try again.");
  if (!body?.token) {
    throw new AuthError("Sign-in didn't return a session token.");
  }
  storage.saveSession(body.token);
  return body;
}

function decodeJwtExpiryMs(jwt) {
  try {
    const payload = jwt.split(".")[1];
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function refreshJwt(sessionToken) {
  const response = await fetch(`${AUTH_BASE_URL}/api/auth/token`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  const body = await parseJsonOrThrow(response, "Session expired — please sign in again.");
  if (!body?.token) {
    throw new AuthError("Token refresh didn't return a token.");
  }
  const expiresAt = decodeJwtExpiryMs(body.token) ?? Date.now() + 14 * 60 * 1000;
  storage.cacheJwt(body.token, expiresAt);
  return body.token;
}

/** A JWT valid for the next few minutes, refreshing via the session token if
 *  the cached one is missing, near expiry, or `forceRefresh` is set. */
export async function getValidJwt({ forceRefresh = false } = {}) {
  const sessionToken = storage.sessionToken;
  if (!sessionToken) throw new AuthError("Not signed in.");
  const SAFETY_MARGIN_MS = 60 * 1000;
  if (!forceRefresh && storage.jwt && storage.jwtExpiresAt - SAFETY_MARGIN_MS > Date.now()) {
    return storage.jwt;
  }
  return refreshJwt(sessionToken);
}

/** The signed-in owner's user id (the JWT's `sub`), which is also their
 *  tracker actor id. Null until the first JWT has been fetched. */
export function currentUserId() {
  const jwt = storage.jwt;
  if (!jwt) return null;
  try {
    const json = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json.sub === "string" ? json.sub : null;
  } catch {
    return null;
  }
}

export function isSignedIn() {
  return Boolean(storage.sessionToken);
}

/** Best-effort server-side session revocation; local sign-out always happens. */
export async function signOut() {
  const sessionToken = storage.sessionToken;
  storage.clear();
  if (!sessionToken) return;
  try {
    await fetch(`${AUTH_BASE_URL}/api/auth/sign-out`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
  } catch {
    // local sign-out already happened; the server session expires on its own.
  }
}
