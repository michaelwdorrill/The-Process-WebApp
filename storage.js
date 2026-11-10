// Thin localStorage wrapper, mirroring the Heavy Machinery and Disciplined
// Dollar web apps' storage.js. Single-owner tool with no third-party script on
// the page, so localStorage (survives tab close, no re-login every visit) is
// the same accepted tradeoff those sites already make. Sign-out clears all of it.
const KEYS = {
  sessionToken: "process_session_token",
  jwt: "process_jwt",
  jwtExpiresAt: "process_jwt_expires_at",
  cache: "process_cache",
};

export const storage = {
  get sessionToken() {
    return localStorage.getItem(KEYS.sessionToken);
  },
  saveSession(sessionToken) {
    localStorage.setItem(KEYS.sessionToken, sessionToken);
  },
  get jwt() {
    return localStorage.getItem(KEYS.jwt);
  },
  get jwtExpiresAt() {
    const raw = localStorage.getItem(KEYS.jwtExpiresAt);
    return raw ? Number(raw) : 0;
  },
  cacheJwt(jwt, expiresAtMs) {
    localStorage.setItem(KEYS.jwt, jwt);
    localStorage.setItem(KEYS.jwtExpiresAt, String(expiresAtMs));
  },
  /** The synced local copy (see sync.js). Null if never synced. */
  loadCache() {
    const raw = localStorage.getItem(KEYS.cache);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },
  saveCache(cache) {
    localStorage.setItem(KEYS.cache, JSON.stringify(cache));
  },
  clear() {
    for (const key of Object.values(KEYS)) localStorage.removeItem(key);
  },
};
