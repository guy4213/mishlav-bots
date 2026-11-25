/**
 * The server API (port of the old dashboard's api.js). Two ways in:
 * - a user logs in with a phone and a password (POST /auth/login): the server sets an HttpOnly cookie, sent with every
 *   request (credentials: same-origin); this page never reads or keeps it. What they see depends on session.role.
 * - TOOLS_SECRET (us): arrives once in the URL hash (#k=..., from `npm run lab`) or typed in the login dialog, kept in
 *   this browser's localStorage and sent as x-tools-secret.
 * A 401 asks to log in again (authRequired listeners: the app clears every screen first); a 403 is an action the role
 * may not do. The server enforces every permission: what this page hides is only for a clean screen.
 */
import { KEYS, readKey, writeKey } from "./storage";
import type { Me, Role, ServerVersion, User } from "./types";

let secret: string | null = null;

/** Who is logged in (GET /auth/me). viewingAs: an admin seeing the dashboard exactly as Mishlav's users do. */
export const session: { role: Role | null; via: "secret" | "session" | null; user: User | null; viewingAs: boolean; server: ServerVersion | null } = {
  role: null,
  via: null,
  user: null,
  viewingAs: false,
  server: null,
};
export const isAdmin = () => session.role === "admin";

/** Forgets who is logged in (a 401, a logout): nothing of the last user stays in memory. */
export function clearSession() {
  Object.assign(session, { role: null, via: null, user: null, viewingAs: false, server: null });
}

// "view as Mishlav": this tab only (sessionStorage); every request carries x-view-as and the server answers as it
// would a Mishlav user. The server takes it from admins only.
let viewAs = readKey(KEYS.viewAs, "session") === "mishlav";
export function setViewAs(on: boolean) {
  viewAs = on;
  writeKey(KEYS.viewAs, on ? "mishlav" : null, "session");
}

/** The key from the address (#k=...): kept, then removed from the address bar and the history, the route after it kept. */
export function loadSecret(): boolean {
  const m = /[#&]k=([^&]+)/.exec(location.hash);
  if (m) {
    try {
      secret = decodeURIComponent(m[1]!);
    } catch {
      secret = m[1]!;
    }
    writeKey(KEYS.secret, secret);
    const rest = location.hash.replace(/[#&]k=[^&]+&?/, "#").replace(/^#$/, "");
    history.replaceState(null, "", location.pathname + location.search + rest);
  } else {
    secret = readKey(KEYS.secret);
  }
  return !!secret;
}

export function setSecret(value: string | null) {
  secret = value || null;
  writeKey(KEYS.secret, value || null);
}

export class AuthError extends Error {}

/** An answer that is not ok: the server's Hebrew message, its status, and the form fields it names. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fields: string[] = [],
  ) {
    super(message);
  }
}

/** Who is asking: the secret (us) and "view as Mishlav", as every request sends them (the push channel too). */
export const authHeaders = (): Record<string, string> => ({
  ...(secret ? { "x-tools-secret": secret } : {}),
  ...(viewAs ? { "x-view-as": "mishlav" } : {}),
});

const authListeners = new Set<() => void>();
/** A 401 outside /auth/*: the session is gone. The app clears every screen and asks to log in. */
export function onAuthRequired(fn: () => void) {
  authListeners.add(fn);
  return () => void authListeners.delete(fn);
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...authHeaders(),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.startsWith("/auth/")) {
    authListeners.forEach((fn) => fn());
    throw new AuthError("צריך להתחבר מחדש");
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || json.ok === false) {
    const message = String(json.message_he || json.details || json.error || `HTTP ${res.status}`);
    throw new ApiError(message, res.status, Array.isArray(json.fields) ? (json.fields as string[]) : []);
  }
  return json as T;
}

export const get = <T = any>(path: string) => api<T>("GET", path);
export const post = <T = any>(path: string, body: unknown = {}) => api<T>("POST", path, body);

/** Who is this browser? null: nobody (show the login). */
export async function whoAmI(): Promise<Me | null> {
  try {
    const me = await api<Me>("GET", "/auth/me");
    Object.assign(session, { role: me.role, via: me.via, user: me.user, viewingAs: !!me.viewing_as, server: me.server ?? null });
    if (viewAs && !me.viewing_as) setViewAs(false); // not an admin: nothing to view as
    return me;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      if (secret) setSecret(null); // a stale or wrong secret: forget it
      return null;
    }
    throw e;
  }
}

export async function login(phone: string, password: string) {
  setSecret(null); // a session replaces the secret in this browser
  setViewAs(false);
  return api("POST", "/auth/login", { phone, password });
}

export async function logout() {
  setSecret(null);
  setViewAs(false);
  clearSession();
  await api("POST", "/auth/logout").catch(() => {});
}
