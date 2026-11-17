// The server API. Every call sends TOOLS_SECRET (x-tools-secret). The secret arrives once in the URL hash
// (#k=..., from `npm run lab`) and is kept in this browser's localStorage; a 401 asks for it again.

const KEY = "mishlav_secret";
let secret = null;

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

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "x-tools-secret": secret ?? "", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent("auth-required"));
    throw new AuthError("סיסמת השרת שגויה או חסרה");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.message_he || json.details || json.error || `HTTP ${res.status}`);
  return json;
}

export const get = (path) => api("GET", path);
export const post = (path, body = {}) => api("POST", path, body);
