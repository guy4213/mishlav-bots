/**
 * What every screen shows at the top: which server, the dialer, the phone line and the call on it (port of the old
 * dashboard's live.js). One poll for the whole page, every 2.5 s while the tab is in front; screens subscribe instead
 * of polling the same things themselves. A tab in the background asks nothing and catches up once it is in front.
 *
 * And the push channel: GET /api/admin/stream (Server-Sent Events) says "contacts" whenever a contact changed; the
 * screens that show contacts re-read. Read with fetch, not EventSource: it has to send the secret header. Reconnects
 * by itself; every (re)connect re-reads too. At most one re-read every 3 s; a tab in the background re-reads once
 * when it is in front again.
 *
 * stopLive() ends all of it and forgets the state (a 401, a logout): nothing of the last user stays in memory.
 */
import { useSyncExternalStore } from "react";
import { authHeaders, get, isAdmin } from "./api";
import type { DialerStatus, Env, PhoneInfo } from "./types";

export interface LiveState {
  env: Env | null; // GET /api/admin/env (admins only)
  dialerAvailable: boolean;
  dialer: DialerStatus | null;
  dialerError: string | null;
  phone: PhoneInfo | null; // GET /test/phone: { available, reason, status }
  updatedAt: number;
}

const EMPTY: LiveState = { env: null, dialerAvailable: false, dialer: null, dialerError: null, phone: null, updatedAt: 0 };
let live: LiveState = { ...EMPTY };
/** a new object on every change: what useSyncExternalStore compares */
export const liveState = () => live;

const subs = new Set<(s: LiveState) => void>();
/** Like the old subscribe(): called now, then after every poll. */
export function subscribeLive(fn: (s: LiveState) => void) {
  subs.add(fn);
  try {
    fn(live);
  } catch (e) {
    console.error(e);
  }
  return () => void subs.delete(fn);
}
const emit = () =>
  subs.forEach((fn) => {
    try {
      fn(live);
    } catch (e) {
      console.error(e);
    }
  });
const reactSubs = new Set<() => void>();
const set = (patch: Partial<LiveState>) => {
  live = { ...live, ...patch };
  reactSubs.forEach((fn) => fn());
  emit();
};

/** The live state, re-rendered after every poll. */
export function useLive(): LiveState {
  return useSyncExternalStore(
    (fn) => {
      reactSubs.add(fn);
      return () => void reactSubs.delete(fn);
    },
    liveState,
  );
}

let running = false;
export async function refreshLive() {
  // since= far ahead: the status only, not the line's log (the logs screen reads that)
  const [d, p] = await Promise.allSettled([get("/api/admin/dialer"), get<PhoneInfo>("/test/phone?since=999999999")]);
  if (!running) return; // stopped meanwhile (a 401): nothing of it is kept
  const patch: Partial<LiveState> = {};
  if (d.status === "fulfilled") {
    patch.dialerAvailable = d.value.available;
    patch.dialer = d.value.dialer;
    patch.dialerError = null;
  } else patch.dialerError = (d.reason as Error)?.message ?? "שגיאה";
  patch.phone = p.status === "fulfilled" ? p.value : null;
  patch.updatedAt = Date.now();
  set(patch);
}

export async function loadEnv() {
  if (!isAdmin()) return; // which server, keys set or not: ours
  let env: Env | null = null;
  try {
    env = await get<Env>("/api/admin/env");
  } catch {
    env = null;
  }
  if (running) set({ env });
}

let timer: ReturnType<typeof setInterval> | null = null;
const onVisible = () => {
  if (!document.hidden) void refreshLive();
};
export function startLive() {
  if (running) return;
  running = true;
  void loadEnv();
  void refreshLive();
  timer = setInterval(() => {
    if (!document.hidden) void refreshLive();
  }, 2500); // a tab in the background asks nothing
  document.addEventListener("visibilitychange", onVisible);
  document.addEventListener("visibilitychange", onVisibleContacts);
  openStream();
}

/** Ends the poll and the push channel and forgets what they read. */
export function stopLive() {
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
  document.removeEventListener("visibilitychange", onVisible);
  document.removeEventListener("visibilitychange", onVisibleContacts);
  stream?.abort();
  stream = null;
  if (pending) clearTimeout(pending);
  pending = null;
  missedWhileHidden = false;
  lastFired = 0;
  contactSubs.clear();
  live = { ...EMPTY };
  reactSubs.forEach((fn) => fn());
}

// ------------------------------------------------------------------ "the contacts changed" (pushed by the server)
const contactSubs = new Set<() => void>();
export function onContactsChanged(fn: () => void) {
  contactSubs.add(fn);
  return () => void contactSubs.delete(fn);
}
export const THROTTLE_MS = 3000;
let lastFired = 0;
let pending: ReturnType<typeof setTimeout> | null = null;
let missedWhileHidden = false;
function contactsChanged() {
  if (document.hidden) {
    missedWhileHidden = true;
    return;
  }
  if (pending) return;
  pending = setTimeout(
    () => {
      pending = null;
      lastFired = Date.now();
      contactSubs.forEach((fn) => {
        try {
          fn();
        } catch (e) {
          console.error(e);
        }
      });
    },
    Math.max(0, lastFired + THROTTLE_MS - Date.now()),
  );
}
function onVisibleContacts() {
  if (!document.hidden && missedWhileHidden) {
    missedWhileHidden = false;
    contactsChanged();
  }
}

let stream: AbortController | null = null;
function openStream() {
  if (stream) return;
  const ctl = new AbortController();
  stream = ctl;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      ctl.signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      });
    });
  void (async () => {
    while (!ctl.signal.aborted) {
      let wait = 3000;
      try {
        const res = await fetch("/api/admin/stream", { credentials: "same-origin", headers: authHeaders(), cache: "no-store", signal: ctl.signal });
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
      } catch {
        // the server restarted, or the network, or stopLive(): try again (unless stopped)
      }
      if (ctl.signal.aborted) break;
      await sleep(wait);
    }
  })();
}

/** The call on the line now (any origin), with the contact's name when the dialer placed it. */
export function liveCall(s: LiveState = live) {
  const c = s.phone?.status?.call;
  if (!c) return null;
  const mine = s.dialer?.current_call?.call_id === c.id ? s.dialer.current_call : null;
  return { ...c, name: mine?.name ?? null, origin: mine ? "dialer" : "manual" };
}
