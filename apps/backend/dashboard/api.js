// The server API. Two ways in:
// - a user logs in with a phone and a password (POST /auth/login): the server sets an HttpOnly cookie, sent with
//   every request; what they see depends on their role (session.role).
// - TOOLS_SECRET (us): arrives once in the URL hash (#k=..., from `npm run lab`) or typed in the login dialog, kept
//   in this browser's localStorage and sent as x-tools-secret.
// A 401 asks to log in again; a 403 is an action the role may not do.

const KEY = "mishlav_secret";
let secret = null;

/** Who is logged in (GET /auth/me): role "admin" | "mishlav", via "secret" | "session", user (session only),
 * viewingAs: an admin seeing the dashboard exactly as Mishlav's users do (role is then "mishlav"). */
export const session = { role: null, via: null, user: null, viewingAs: false };
export const isAdmin = () => session.role === "admin";

// "view as Mishlav": this tab only (sessionStorage); every request carries x-view-as and the server answers as it
// would a Mishlav user. The server takes it from admins only.
const VIEW_KEY = "mishlav_view_as";
let viewAs = false;
try { viewAs = sessionStorage.getItem(VIEW_KEY) === "mishlav"; } catch {}
export function setViewAs(on) {
  viewAs = !!on;
  try { on ? sessionStorage.setItem(VIEW_KEY, "mishlav") : sessionStorage.removeItem(VIEW_KEY); } catch {}
}

export function loadSecret() {
  const m = /[#&]k=([^&]+)/.exec(location.hash);
  if (m) {
    secret = decodeURIComponent(m[1]);
    try { localStorage.setItem(KEY, secret); } catch {}
    // drop the secret from the address bar (and from history), keep any route after it
    const rest = location.hash.replace(/[#&]k=[^&]+&?/, "#").replace(/^#$/, "");
    history.replaceState(null, "", location.pathname + location.search + rest);
  } else {
    try { secret = localStorage.getItem(KEY); } catch {}
  }
  return !!secret;
}

export function setSecret(value) {
  secret = value || null;
  try { value ? localStorage.setItem(KEY, value) : localStorage.removeItem(KEY); } catch {}
}

export class AuthError extends Error {}

/** Who is asking: the secret (us) and "view as Mishlav", as every request sends them (the push channel too). */
export const authHeaders = () => ({
  ...(secret ? { "x-tools-secret": secret } : {}),
  ...(viewAs ? { "x-view-as": "mishlav" } : {}),
});

export async function api(method, path, body) {
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
    window.dispatchEvent(new CustomEvent("auth-required"));
    throw new AuthError("צריך להתחבר מחדש");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    const err = new Error(json.message_he || json.details || json.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.fields = json.fields ?? [];
    throw err;
  }
  return json;
}

export const get = (path) => api("GET", path);
export const post = (path, body = {}) => api("POST", path, body);

/** Who is this browser? null: nobody (show the login). */
export async function whoAmI() {
  try {
    const me = await api("GET", "/auth/me");
    Object.assign(session, { role: me.role, via: me.via, user: me.user, viewingAs: !!me.viewing_as, server: me.server ?? null });
    if (viewAs && !me.viewing_as) setViewAs(false); // not an admin: nothing to view as
    return me;
  } catch (e) {
    if (e.status === 401) {
      if (secret) setSecret(null); // a stale or wrong secret: forget it
      return null;
    }
    throw e;
  }
}

export async function login(phone, password) {
  setSecret(null); // a session replaces the secret in this browser
  setViewAs(false);
  return api("POST", "/auth/login", { phone, password });
}

export async function logout() {
  setSecret(null);
  setViewAs(false);
  await api("POST", "/auth/logout").catch(() => {});
}
