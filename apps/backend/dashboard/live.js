// What every screen shows at the top: which server, the dialer, the phone line and the call on it.
// One poll for the whole page; screens subscribe instead of polling the same things themselves.
import { get, isAdmin } from "./api.js";

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
  timer = setInterval(refreshLive, 2500);
}

/** The call on the line now (any origin), with the contact's name when the dialer placed it. */
export function liveCall() {
  const c = live.phone?.status?.call;
  if (!c) return null;
  const mine = live.dialer?.current_call?.call_id === c.id ? live.dialer.current_call : null;
  return { ...c, name: mine?.name ?? null, origin: mine ? "dialer" : "manual" };
}
