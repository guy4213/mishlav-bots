/**
 * A pretend server for the dashboard's tests: fetch is replaced by `handle` (invented data only), every request is
 * recorded with its headers, and the push channel (/api/admin/stream) is a stream the test writes to.
 */
import { vi } from "vitest";

export interface Sent {
  method: string;
  path: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Handler = (r: Sent) => { status?: number; json?: unknown } | undefined;

export function installServer(handle: Handler) {
  const sent: Sent[] = [];
  let push: ReadableStreamDefaultController<Uint8Array> | null = null;
  const enc = new TextEncoder();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://dash.test");
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const r: Sent = { method: init.method ?? "GET", path: url.pathname, url: url.pathname + url.search, headers, body: init.body ? JSON.parse(String(init.body)) : undefined };
    sent.push(r);
    if (r.path === "/api/admin/stream") {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          push = c;
          c.enqueue(enc.encode("retry: 3000\n\nevent: hello\ndata: {}\n\n"));
        },
      });
      init.signal?.addEventListener("abort", () => {
        try {
          push?.error(new DOMException("aborted", "AbortError"));
        } catch {
          // already closed
        }
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const out = handle(r) ?? { status: 404, json: { ok: false, error: "not_found" } };
    return new Response(JSON.stringify(out.json ?? {}), { status: out.status ?? 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    sent,
    /** the server says "a contact changed" on the push channel */
    pushContacts: () => push?.enqueue(enc.encode("event: contacts\ndata: {}\n\n")),
    paths: () => sent.map((s) => s.path),
  };
}

/** What jsdom lacks and the page uses. */
export function browserShims() {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  window.scrollTo = () => {};
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement, v?: string) {
      if (v !== undefined) this.returnValue = v;
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  }
}

// ------------------------------------------------------------------ invented data

export const ADMIN_ME = { ok: true, role: "admin", via: "secret", user: null, viewing_as: false, server: { version: "v1.17", started_at: "2026-11-25T10:00:00.000Z", commit: null } };
export const MISHLAV_ME = {
  ok: true,
  role: "mishlav",
  via: "session",
  user: { id: "00000000-0000-4000-8000-000000000001", phone: "+972500000002", name: "עובדת בדיקה", role: "mishlav", active: true, password_changed_at: "2026-11-01T00:00:00Z", last_login_at: null, created_at: "2026-11-01T00:00:00Z" },
  viewing_as: false,
};
export const CONTACT = {
  gold_record_id: "test0001",
  full_name: "לקוח מומצא",
  phone: "050-0000001",
  status: null,
  requested_course: "יום עיון חשבונאות",
  bot_state: { bot_status: "new", attempts: 0, no_answer_streak: 0, next_call_at: null, callback_at: null, last_call_at: null, last_outcome: null, phone_index: 1 },
  rep_tasks: [],
};
const SUMMARY = {
  day_start: "2026-11-25T22:00:00Z",
  today: { total: 3, answered: 2, no_result: 1, outcomes: { LINK_SENT: 1 }, manual_total: 0 },
  funnel: { new: 5, in_queue: 1, handled: 1, closed: 0 },
  by_status: { new: 5 },
  contacts_total: 7,
  due_now: 5,
  open_rep_tasks: 2,
  next_due: [{ gold_record_id: "test0001", full_name: "לקוח מומצא", bot_status: "new", next_call_at: null }],
};

/** The answers a logged-in dashboard needs (`me`: who is logged in). */
export function standardServer(me: unknown, extra: Handler = () => undefined): Handler {
  return (r) => {
    const x = extra(r);
    if (x) return x;
    switch (r.path) {
      case "/auth/me":
        return { json: me };
      case "/api/admin/dialer":
        return { json: { ok: true, available: true, dialer: { state: "stopped", enabled: false, daily_limit: null, changed_at: null, reason: null, current_call: null, next_due: null, calls_today: 0, last_error: null, failures: 0, only_numbers: false, checked_at: null } } };
      case "/test/phone":
        return { json: { ok: true, available: true, reason: null, status: { registered: true, error: null, busy: false, call: null } } };
      case "/api/admin/env":
        return { json: { ok: true, env: "local", commit: null, phone_line: { available: true, registered: true, reason: null }, supabase: true, sms_provider: "log", gold_api_key_set: false, dialer_only_numbers: false, timezone: "Asia/Jerusalem" } };
      case "/api/admin/rep-tasks":
        return { json: { ok: true, open: true, tasks: [], total: 2, page: 1, page_size: 50, pages: 1 } };
      case "/api/admin/summary":
        return { json: { ok: true, summary: SUMMARY } };
      case "/api/admin/voice":
        return { json: { ok: true, voice: null, server_voice: "Kore", voices: ["Kore"], labels: { Kore: "קול" } } };
      case "/api/admin/contacts":
        return { json: { ok: true, available: true, view: "all", contacts: [CONTACT], total: 120, page: Number(new URLSearchParams(r.url.split("?")[1]).get("page") ?? 1), page_size: 50, pages: 3 } };
      default:
        return undefined;
    }
  };
}
