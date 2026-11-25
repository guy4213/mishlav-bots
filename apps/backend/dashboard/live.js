// What every screen shows at the top: which server, the dialer, the phone line and the call on it.
// One poll for the whole page; screens subscribe instead of polling the same things themselves.
import { authHeaders, get, isAdmin } from "./api.js";

export const live = {
  env: null, // GET /api/admin/env
  dialerAvailable: false,
  dialer: null, // DialerStatus
  dialerError: null,
  phone: null, // GET /test/phone: { available, reason, status }
  updatedAt: 0,
};

const subs = new Set();
export function subscribe(fn) {
  subs.add(fn);
  fn(live);
  return () => subs.delete(fn);
}
const emit = () => subs.forEach((fn) => { try { fn(live); } catch (e) { console.error(e); } });

export async function refreshLive() {
  // since= far ahead: the status only, not the line's log (the logs screen reads that)
  const [d, p] = await Promise.allSettled([get("/api/admin/dialer"), get("/test/phone?since=999999999")]);
  if (d.status === "fulfilled") {
    live.dialerAvailable = d.value.available;
    live.dialer = d.value.dialer;
    live.dialerError = null;
  } else live.dialerError = d.reason?.message ?? "שגיאה";
  live.phone = p.status === "fulfilled" ? p.value : null;
  live.updatedAt = Date.now();
  emit();
}

export async function loadEnv() {
  if (!isAdmin()) return; // which server, keys set or not: ours
  try { live.env = await get("/api/admin/env"); } catch { live.env = null; }
  emit();
}

let timer = null;
export function startLive() {
  if (timer) return;
  loadEnv();
  refreshLive();
  timer = setInterval(() => { if (!document.hidden) refreshLive(); }, 2500); // a tab in the background asks nothing
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshLive(); });
  openStream();
}

// ------------------------------------------------------------------ "the contacts changed" (pushed by the server)
// GET /api/admin/stream (Server-Sent Events): the server says "contacts" whenever a contact changed - a call started
// or ended, the bot did something, the dialer marked one. Screens subscribe and re-read what they show, so nothing is
// read while nothing happens. Read with fetch, not EventSource: it has to send the secret header. Reconnects by itself
// (a deploy, the network); on every (re)connect the screens re-read too, since something may have changed meanwhile.
// At most one re-read every 3 s; a tab in the background re-reads once when it is in front again.
const contactSubs = new Set();
export function onContactsChanged(fn) {
  contactSubs.add(fn);
  return () => contactSubs.delete(fn);
}
const THROTTLE_MS = 3000;
let lastFired = 0;
let pending = null;
let missedWhileHidden = false;
function contactsChanged() {
  if (document.hidden) { missedWhileHidden = true; return; }
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    lastFired = Date.now();
    contactSubs.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
  }, Math.max(0, lastFired + THROTTLE_MS - Date.now()));
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && missedWhileHidden) { missedWhileHidden = false; contactsChanged(); }
});

let streaming = false;
async function openStream() {
  if (streaming) return;
  streaming = true;
  for (;;) {
    let wait = 3000;
    try {
      const res = await fetch("/api/admin/stream", { credentials: "same-origin", headers: authHeaders(), cache: "no-store" });
      if (res.status === 401 || res.status === 403) wait = 30_000; // logged out: the login brings the page back
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const msg = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (\w+)/m.exec(msg)?.[1];
          if (ev === "contacts" || ev === "hello") contactsChanged();
        }
      }
    } catch { /* the server restarted, or the network: try again */ }
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** The call on the line now (any origin), with the contact's name when the dialer placed it. */
export function liveCall() {
  const c = live.phone?.status?.call;
  if (!c) return null;
  const mine = live.dialer?.current_call?.call_id === c.id ? live.dialer.current_call : null;
  return { ...c, name: mine?.name ?? null, origin: mine ? "dialer" : "manual" };
}
