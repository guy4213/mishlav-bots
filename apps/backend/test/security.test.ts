/**
 * The server's security checks, kept as tests so they run with `npm test` from now on.
 *
 * Everything here runs against a test server with in-memory fakes and invented data: never Render, never the real
 * Supabase. A check that fails today is NOT fixed here: it is marked `it.fails` (the assertion states the safe
 * behaviour, and the test passes while the server still breaks it) or `it.todo`, with the finding's letter from the
 * security report. When a finding is fixed, its `it.fails` turns red: change it to a plain `it`.
 *
 * Sections: who may call what (every route x every role) - x-view-as - PostgREST injection - the public static
 * files - logging in and sessions - security headers - what the answers and the logs hold.
 */
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { describe, expect, it } from "vitest";
import { mayCall } from "../src/access";
import { type AdminStore, type ContactStore, searchFilter, SupabaseContacts } from "../src/contacts";
import { isDashboardFile, NEW_DASHBOARD_DIR, newDashboardHeaders } from "../src/routes/dashboard";
import { buildServer } from "../src/server";
import { LogOnlySms } from "../src/sms";
import { type DashboardUser, hashPassword, type UserStore, UserExists } from "../src/users";
import { AUTH, FIXED_NOW, SECRET, testConfig } from "./helpers";

// ------------------------------------------------------------------ invented data and in-memory fakes

const CONTACT_ID = "a000000000000001demo";
const TASK_ID = "6f1c2b9e-1a2b-4c3d-8e9f-0123456789ab";
const USER_ID = "00000000-0000-4000-8000-0000000000a1"; // Dana, a Mishlav user
const ADMIN_ID = "00000000-0000-4000-8000-0000000000a2"; // Guy, an admin
const DAY_ID = "2027-02-21-zoom";
const AT = "2026-11-01T00:00:00.000Z"; // when both passwords were set
const HOUR = 3600_000;

/** A session cookie signed like users.ts signs it (the test knows the test secret). `exp`: real time, as the server's. */
function token(id: string, passwordChangedAt: string, exp: number, secret = SECRET) {
  const key = createHmac("sha256", "mishlav-dashboard-session").update(secret).digest();
  const body = `${id}.${Date.parse(passwordChangedAt)}.${exp}`;
  return `mishlav_session=${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}
const DANA = { phone: "0521111111", password: "dana-pass-1" };
const GUY = { phone: "0547777777", password: "guy-pass-12" };

class FakeUsers implements UserStore {
  rows: DashboardUser[] = [];
  fail = false;
  private n = 0;
  async dashboardUsers() {
    if (this.fail) throw new Error("Supabase GET /dashboard_users: HTTP 500 internal-detail-do-not-show");
    return this.rows.map((r) => ({ ...r }));
  }
  async createDashboardUser(row: Pick<DashboardUser, "phone" | "name" | "role" | "password_hash">) {
    if (this.rows.some((r) => r.phone === row.phone)) throw new UserExists(row.phone);
    const at = "2026-11-01T00:00:00.000Z";
    const u: DashboardUser = { id: `00000000-0000-4000-8000-${String(++this.n).padStart(12, "0")}`, ...row, active: true, password_changed_at: at, last_login_at: null, created_at: at };
    this.rows.push(u);
    return { ...u };
  }
  async updateDashboardUser(id: string, patch: Partial<DashboardUser>) {
    const u = this.rows.find((r) => r.id === id);
    if (!u) return null;
    Object.assign(u, patch);
    return { ...u };
  }
}

async function fakeUsers() {
  const store = new FakeUsers();
  const at = AT;
  store.rows.push(
    { id: USER_ID, phone: "+972521111111", name: "דנה לוי", role: "mishlav", password_hash: await hashPassword(DANA.password), active: true, password_changed_at: at, last_login_at: null, created_at: at },
    { id: ADMIN_ID, phone: "+972547777777", name: "גיא", role: "admin", password_hash: await hashPassword(GUY.password), active: true, password_changed_at: at, last_login_at: null, created_at: at },
  );
  return store;
}

/** What the dashboard reads, in memory: what each route asked for is kept in `asked`. */
class FakeStore {
  asked: unknown[][] = [];
  fail = false;
  private check() {
    if (this.fail) throw new Error("Supabase GET /contacts: HTTP 500 internal-detail-do-not-show");
  }
  async list() {
    return [];
  }
  async get(id: string) {
    this.asked.push(["get", id]);
    return null;
  }
  async contactsPage(query: unknown) {
    this.check();
    this.asked.push(["page", query]);
    return { contacts: [], total: 0 };
  }
  async recentContacts() {
    return [];
  }
  async queue() {
    return [];
  }
  async contactCalls() {
    return [];
  }
  async contactRepTasks() {
    return [];
  }
  async calls(query: unknown) {
    this.asked.push(["calls", query]);
    return { calls: [], total: 0 };
  }
  async call() {
    return null;
  }
  async recordingUrl(callId: string) {
    this.asked.push(["recording", callId]);
    return null;
  }
  async repTasks(query: unknown) {
    this.asked.push(["tasks", query]);
    return { tasks: [], total: 0 };
  }
  async repTaskDone() {
    return null;
  }
}

class FakeLine extends EventEmitter {
  recent = [{ seq: 1, ts: FIXED_NOW.toISOString(), call_id: null, text: "SIP details" }];
  status() {
    return { registered: true, busy: false, call: null };
  }
  async hangup() {
    return false;
  }
}

async function setup(opts: { logger?: FastifyServerOptions["logger"] } = {}) {
  const users = await fakeUsers();
  const store = new FakeStore();
  const config = testConfig();
  const app = await buildServer(config, {
    now: () => FIXED_NOW,
    logger: opts.logger ?? false,
    env: {},
    sms: new LogOnlySms(() => {}),
    users,
    contacts: store as unknown as ContactStore,
    admin: store as unknown as AdminStore,
    phone: { line: new FakeLine() as never, reason: null },
  });
  const login = async (who: { phone: string; password: string }, headers: Record<string, string> = {}) => {
    const r = await app.inject({ method: "POST", url: "/auth/login", payload: who, headers });
    return { r, cookie: String(r.headers["set-cookie"] ?? "").split(";")[0]! };
  };
  return { app, users, store, config, login };
}

// ------------------------------------------------------------------ who may call what: every route x every role

type Access = "public" | "mishlav" | "admin";

/**
 * Who each route is meant for. A route the server registers that is missing here fails the test below: a new route
 * has to be classified on purpose. Everything not listed as public or mishlav is admin only.
 */
const PUBLIC = new Set([
  "GET /healthz",
  "GET /api/gold/changes", // its own key (X-Api-Key), checked in the handler
  "POST /auth/login",
  "POST /auth/logout",
  "GET /dashboard",
  "GET /dashboard/",
  "GET /dashboard/*", // only names the static-file pattern allows (below)
  "GET /dashboard-new", // the React dashboard: its page and built files only (below)
  "GET /dashboard-new/",
  "GET /dashboard-new/*",
]);
const MISHLAV = new Set([
  "GET /auth/me",
  "POST /auth/password",
  "GET /api/admin/summary",
  "GET /api/admin/dialer",
  "GET /api/admin/contacts",
  "GET /api/admin/contacts/:id",
  "GET /api/admin/stream",
  "GET /api/admin/calls",
  "GET /api/admin/calls/:call_id",
  "GET /api/admin/calls/:call_id/recording",
  "GET /api/admin/rep-tasks",
  "POST /api/admin/rep-tasks/:id/done",
  "GET /api/admin/study-days",
  "POST /api/admin/study-days",
  "POST /api/admin/study-days/:id",
  "POST /api/admin/study-days/:id/archive",
  "POST /api/admin/study-days/:id/restore",
  "GET /test/phone",
  "GET /api/me/test-call",
  "POST /api/me/test-call",
  "POST /api/me/hangup",
]);
const ADMIN = new Set([
  "POST /tools/get_day_info", "POST /tools/send_purchase_link", "POST /tools/schedule_callback", "POST /tools/request_human", "POST /tools/end_call",
  "POST /test/session", "GET /test/session", "POST /test/session/end", "POST /test/metrics",
  "POST /test/manual/session", "POST /test/manual/provider", "POST /test/manual/voice",
  "GET /test/calls", "GET /test/context", "GET /test/contacts",
  "POST /test/elevenlabs/token", "POST /test/elevenlabs/finish",
  "GET /test/overview", "GET /test/report", "POST /test/report/write",
  "GET /test/transcript", "POST /test/transcript", "POST /test/livekit/token",
  "POST /test/phone/call", "POST /test/phone/hangup", "GET /test/gold/changes",
  "GET /api/admin/users", "POST /api/admin/users", "POST /api/admin/users/:id", "POST /api/admin/users/:id/password",
  "GET /api/admin/env", "POST /api/admin/sms/test",
  "POST /api/admin/dialer/limit", "POST /api/admin/dialer/start", "POST /api/admin/dialer/stop",
  "GET /api/admin/voice", "POST /api/admin/voice",
  "GET /api/admin/logs", "GET /api/admin/logs/history",
]);
const accessOf = (key: string): Access | null => (PUBLIC.has(key) ? "public" : MISHLAV.has(key) ? "mishlav" : ADMIN.has(key) ? "admin" : null);

/** Fastify's route tree (printRoutes) as "METHOD /path" keys, HEAD routes included. */
function registeredRoutes(app: FastifyInstance): string[] {
  const stack: string[] = [];
  const out: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
    const m = /^([│ ]*)[├└]── (\S+)(?: \(([A-Z, ]+)\))?$/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    stack.push(m[2]!);
    for (const method of (m[3] ?? "").split(", ").filter(Boolean)) out.push(`${method} ${stack.join("")}`);
  }
  return out;
}

/** A real address for a route pattern. */
const urlFor = (path: string) =>
  path
    .replace("/study-days/:id", `/study-days/${DAY_ID}`)
    .replace("/rep-tasks/:id", `/rep-tasks/${TASK_ID}`)
    .replace("/users/:id", `/users/${USER_ID}`)
    .replace("/contacts/:id", `/contacts/${CONTACT_ID}`)
    .replace(":call_id", "call-a")
    .replace("/dashboard-new/*", "/dashboard-new/theme.js")
    .replace("/dashboard/*", "/dashboard/app.js");

/**
 * The same server, with every handler replaced by "reached" (299): a request that passes the login and the role
 * check gets 299 and nothing else happens (no dialing, no SMS, no files written), so every route can be tried.
 */
async function matrix() {
  const s = await setup();
  s.app.addHook("preHandler", async (_req, reply) => reply.code(299).send({ reached: true }));
  await s.app.ready();
  // the login route is replaced too: the sessions are signed here, the way users.ts signs them
  const dana = token(USER_ID, AT, Date.now() + HOUR);
  const guy = token(ADMIN_ID, AT, Date.now() + HOUR);
  const routes = registeredRoutes(s.app).map((key) => {
    const [method, path] = key.split(" ") as [string, string];
    return { key, method, path, url: urlFor(path) };
  });
  const call = async (r: { method: string; url: string }, headers: Record<string, string> = {}) =>
    (await s.app.inject({ method: r.method as "GET", url: r.url, headers, ...(r.method === "POST" ? { payload: {} } : {}) })).statusCode;
  return { ...s, routes, call, dana, guy };
}

describe("who may call what", () => {
  it("every route the server registers is classified here (a new route must be opened on purpose)", async () => {
    const { routes } = await matrix();
    const real = routes.filter((r) => r.method !== "HEAD");
    expect(real.length).toBeGreaterThan(60);
    expect(real.filter((r) => !accessOf(r.key)).map((r) => r.key)).toEqual([]);
    // and nothing is listed that no longer exists
    const keys = new Set(real.map((r) => r.key));
    expect([...PUBLIC, ...MISHLAV, ...ADMIN].filter((k) => !keys.has(k))).toEqual([]);
  });

  it("without a login: 401 on everything but the public paths", async () => {
    const { routes, call } = await matrix();
    for (const r of routes) {
      const pub = accessOf(r.key.replace(/^HEAD /, "GET ")) === "public";
      expect(await call(r), r.key).toBe(pub ? 299 : 401);
    }
    // a wrong key, a wrong cookie and a path nobody registered: 401 too (never a 404 that maps the server)
    expect(await call({ method: "GET", url: "/api/admin/users" }, { "x-tools-secret": "wrong-secret-0123456789" })).toBe(401);
    expect(await call({ method: "GET", url: "/api/admin/users" }, { authorization: "Bearer wrong-secret-0123456789" })).toBe(401);
    expect(await call({ method: "GET", url: "/api/admin/users" }, { cookie: "mishlav_session=a.b.c.d" })).toBe(401);
    expect(await call({ method: "GET", url: "/no/such/path" })).toBe(401);
  });

  it("a Mishlav user: the routes opened to them, 403 on every admin route", async () => {
    const { routes, call, dana } = await matrix();
    for (const r of routes.filter((x) => x.method !== "HEAD")) {
      const a = accessOf(r.key);
      expect(await call(r, { cookie: dana }), r.key).toBe(a === "admin" ? 403 : 299);
      // access.ts decides the same on its own
      if (a !== "public") expect(mayCall("mishlav", r.method, r.url), r.key).toBe(a === "mishlav");
    }
  });

  it("HEAD never gives a Mishlav user more than GET does", async () => {
    const { routes, call, dana } = await matrix();
    for (const r of routes.filter((x) => x.method === "HEAD")) {
      const pub = accessOf(r.key.replace(/^HEAD /, "GET ")) === "public";
      expect(await call(r, { cookie: dana }), r.key).toBe(pub ? 299 : 403);
    }
  });

  it("an admin (a session, or TOOLS_SECRET): every route", async () => {
    const { routes, call, guy } = await matrix();
    for (const r of routes) {
      expect(await call(r, { cookie: guy }), `session ${r.key}`).toBe(299);
      expect(await call(r, AUTH), `secret ${r.key}`).toBe(299);
    }
  });

  it("x-view-as: an admin becomes exactly a Mishlav user; nobody else is changed by it", async () => {
    const { routes, call, dana, guy } = await matrix();
    const VIEW = { "x-view-as": "mishlav" };
    for (const r of routes.filter((x) => x.method !== "HEAD")) {
      const expected = accessOf(r.key) === "admin" ? 403 : 299;
      expect(await call(r, { cookie: guy, ...VIEW }), `session ${r.key}`).toBe(expected);
      expect(await call(r, { ...AUTH, ...VIEW }), `secret ${r.key}`).toBe(expected);
    }
    const admin = { method: "GET", url: "/api/admin/users" };
    // it only lowers: a Mishlav user stays one whatever the header says, and without a login it is still 401
    for (const v of ["admin", "ADMIN", "mishlav", "Mishlav", "", "admin, mishlav", "true"]) {
      expect(await call(admin, { cookie: dana, "x-view-as": v }), v).toBe(403);
      expect(await call(admin, { "x-view-as": v }), v).toBe(401);
    }
    // only the exact value lowers an admin: anything else leaves them an admin
    for (const v of ["Mishlav", "MISHLAV", " mishlav", "mishlav,mishlav", "admin"]) {
      expect(await call(admin, { cookie: guy, "x-view-as": v }), v).toBe(299);
    }
  });

  it("a Mishlav user can't reach an admin route by spelling its path another way", async () => {
    const { app, login } = await setup();
    const dana = (await login(DANA)).cookie;
    const tricks = [
      "/api/admin/users/", "/api/admin//users", "//api/admin/users", "/api/admin/%75sers", "/API/ADMIN/USERS", "/api/admin/users;x=1",
      "/api/admin/users%2f", "/api/admin/users%00", "/api/admin/users?x=1", "/api/admin/contacts/..%2fusers", "/api/admin/contacts/../users",
      "/api/admin/calls/..%2f..%2fusers", "/api/admin/calls/x/recording/../../../users", "/api/admin/./users", "/api/admin/contacts%2f..%2fusers",
    ];
    for (const url of tricks) {
      const r = await app.inject({ method: "GET", url, headers: { cookie: dana } });
      expect([400, 403, 404], `${url} -> ${r.statusCode}`).toContain(r.statusCode);
      expect(r.body, url).not.toContain("password_changed_at"); // no user rows
    }
  });

  it("the Gold API has its own key: refused without it, and TOOLS_SECRET is not that key", async () => {
    const app = await buildServer(testConfig(), { logger: false, env: { GOLD_API_KEY: "gold-key-0123456789abcdef" }, sms: new LogOnlySms(() => {}) });
    const get = (headers: Record<string, string>) => app.inject({ method: "GET", url: "/api/gold/changes", headers });
    expect((await get({})).statusCode).toBe(401);
    expect((await get({ "x-api-key": "wrong" })).statusCode).toBe(401);
    expect((await get({ "x-api-key": SECRET })).statusCode).toBe(401);
    expect((await get(AUTH)).statusCode).toBe(401);
    expect((await get({ "x-api-key": "gold-key-0123456789abcdef" })).statusCode).toBe(503); // the key is right; no Supabase here
    // no key set on the server: closed to everyone
    const closed = await buildServer(testConfig(), { logger: false, env: {}, sms: new LogOnlySms(() => {}) });
    expect((await closed.inject({ method: "GET", url: "/api/gold/changes", headers: { "x-api-key": "" } })).statusCode).toBe(503);
  });
});

// ------------------------------------------------------------------ PostgREST injection

/** Text nobody should be able to turn into a filter. */
const HOSTILE = [
  "a,b", "a)b", "(a", "a.b", "*", "%", "_", 'a"b', "a\\b", '"', '\\"', '\\\\"', 'x",phone.eq."1', 'x"),or=(id.gt.0', "or=(a.eq.1)", "and=(a.eq.1)",
  "&select=*", "&limit=100000", "&order=phone", "#", "?", "%22", "%2C", "%26select%3D*", "eq.1", "not.is.null", "in.(1,2)", "רועי כהן", "a\nb", "a\tb",
  "x".repeat(10_000),
];

/**
 * A PostgREST list "(a,b,c)" split at its top-level commas, the way PostgREST reads it: inside "double quotes" a
 * comma or a bracket is text, and a backslash keeps the next character. null: the list is not well formed (an
 * unbalanced quote, a bracket outside quotes), which is what an injection would look like.
 */
function splitList(v: string): string[] | null {
  if (!v.startsWith("(") || !v.endsWith(")")) return null;
  const body = v.slice(1, -1);
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      cur += ch;
      if (ch === "\\") cur += body[++i] ?? "";
      else if (ch === '"') quoted = false;
    } else if (ch === '"') {
      quoted = true;
      cur += ch;
    } else if (ch === ",") {
      parts.push(cur);
      cur = "";
    } else if (ch === "(" || ch === ")") {
      return null;
    } else cur += ch;
  }
  if (quoted) return null;
  parts.push(cur);
  return parts;
}
/** "a\"b" as PostgREST reads it -> a"b (null: not one whole quoted value). */
function unquote(v: string): string | null {
  if (v.length < 2 || !v.startsWith('"') || !v.endsWith('"')) return null;
  let out = "";
  const body = v.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '"') return null; // a bare quote inside: the value ended early
    if (body[i] === "\\") {
      if (i + 1 >= body.length) return null;
      out += body[++i];
    } else out += body[i];
  }
  return out;
}

/** A SupabaseContacts whose requests go nowhere: the addresses it asks for are kept. */
function recordingStore(answer: (url: string) => unknown = () => []) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    urls.push(String(url));
    return new Response(JSON.stringify(answer(String(url))), { status: 200, headers: { "content-range": "0-0/0", "content-type": "application/json" } });
  }) as typeof fetch;
  return { store: new SupabaseContacts("https://x.supabase.co", "service-key", fetchImpl), urls };
}

const SEARCH_COLUMNS = ["full_name", "gold_record_id", "email", "company", "city", "requested_course", "phone", "phone2", "phone3"];

describe("PostgREST injection: text from a request stays text", () => {
  it("the search: every hostile text is one quoted value in each condition, and adds no condition", () => {
    for (const q of HOSTILE) {
      const parts = splitList(searchFilter(q));
      expect(parts, q.slice(0, 40)).not.toBeNull();
      const digits = q.replace(/\D/g, "");
      expect(parts!.length, q.slice(0, 40)).toBe(digits.length >= 4 ? 12 : 9);
      parts!.forEach((p, i) => {
        const m = /^([a-z_0-9]+)\.ilike\.(.*)$/s.exec(p);
        expect(m, `${q.slice(0, 40)} #${i}`).not.toBeNull();
        expect([...SEARCH_COLUMNS, "phone", "phone2", "phone3"]).toContain(m![1]);
        // the whole text, and nothing but it, between the wildcards
        expect(unquote(m![2]!), `${q.slice(0, 40)} #${i}`).toBe(`*${i < 9 ? q : digits.slice(-7)}*`);
      });
    }
  });

  it("the contacts page: the address has the same parameters whatever is searched for", async () => {
    for (const q of HOSTILE) {
      const { store, urls } = recordingStore();
      await store.contactsPage({ q, status: "new", page: 2, size: 50 });
      const p = new URL(urls[0]!).searchParams;
      expect([...p.keys()].sort(), q.slice(0, 40)).toEqual(["bot_state.bot_status", "limit", "offset", "or", "order", "select"]);
      expect(p.get("or")).toBe(searchFilter(q));
      expect(p.get("bot_state.bot_status")).toBe("eq.new");
      expect(p.get("limit")).toBe("50");
      expect(p.get("offset")).toBe("50");
      expect(p.get("order")).toBe("full_name.asc.nullslast,gold_record_id.asc");
      // the columns are fixed in the code: the table's own, no ID number, e-mail, address or notes
      expect(p.get("select")).toBe(
        "gold_record_id,full_name,phone,status,requested_course,bot_state!inner(bot_status,attempts,no_answer_streak,last_call_at,last_outcome,next_call_at,callback_at,phone_index),rep_tasks(done)",
      );
    }
  });

  it("an id from a request is one eq. value: a contact, a recording, the log of a call", async () => {
    for (const id of HOSTILE.filter((x) => x.length < 200)) {
      const { store, urls } = recordingStore();
      await store.get(id);
      await store.recordingUrl(id);
      await store.logHistory({ excludeBoot: id, callId: id, limit: 10 });
      const [contact, recording, log] = urls.map((u) => new URL(u).searchParams);
      expect([...contact!.keys()].sort(), id).toEqual(["gold_record_id", "select"]);
      expect(contact!.get("gold_record_id")).toBe(`eq.${id}`);
      expect([...recording!.keys()].sort(), id).toEqual(["call_id", "select"]);
      expect(recording!.get("call_id")).toBe(`eq.${id}`);
      expect([...log!.keys()].sort(), id).toEqual(["boot", "call_id", "limit", "order", "select"]);
      expect(log!.get("call_id")).toBe(`eq.${id}`);
      expect(log!.get("boot")).toBe(`neq.${id}`);
    }
  });

  it("ids in an in.(...) list (they come from the database) are quoted one by one", async () => {
    const ids = ['a"b', "c,d", "e)f", "g\\h", "(i", "j.k"];
    const { store, urls } = recordingStore((url) => (url.includes("/rpc/bot_queue") ? ids.map((gold_record_id) => ({ gold_record_id, due: true })) : []));
    await store.queue(FIXED_NOW, [], 50);
    const value = new URL(urls[1]!).searchParams.get("gold_record_id")!;
    expect(value.startsWith("in.")).toBe(true);
    expect(splitList(value.slice(3))?.map(unquote)).toEqual(ids);
  });

  it("the route: the search is cut to 100 characters; a status, a page or a view that isn't one is dropped", async () => {
    const { app, store } = await setup();
    const get = (qs: string) => app.inject({ method: "GET", url: `/api/admin/contacts?${qs}`, headers: AUTH });
    for (const q of HOSTILE) {
      store.asked.length = 0;
      const r = await get(`q=${encodeURIComponent(q)}`);
      expect(r.statusCode, q.slice(0, 40)).toBe(200);
      expect(store.asked).toEqual([["page", { q: q.trim().slice(0, 100) || undefined, status: undefined, page: 1, size: 50 }]]);
    }
    for (const status of ["new);drop", "new,queued", "eq.new", "NEW", "new&select=*", "a".repeat(33), "not.is.null", "new.or.(a)"]) {
      store.asked.length = 0;
      await get(`status=${encodeURIComponent(status)}`);
      expect((store.asked[0]![1] as { status?: string }).status, status).toBeUndefined();
    }
    for (const page of ["abc", "-5", "0", "1;drop", "1,2", "1&limit=9", "NaN", ""]) {
      store.asked.length = 0;
      await get(`page=${encodeURIComponent(page)}`);
      expect((store.asked[0]![1] as { page: number }).page, page).toBe(1);
    }
    // the size of a page is never the caller's
    store.asked.length = 0;
    await get("page_size=5000&size=5000&limit=5000");
    expect((store.asked[0]![1] as { size: number }).size).toBe(50);
  });

  it("the calls and the rep tasks: only the values the screen has", async () => {
    const { app, store } = await setup();
    await app.inject({ method: "GET", url: "/api/admin/calls?origin=dialer%29%2Cor%3D%28&recorded=true&page=x", headers: AUTH });
    expect(store.asked.at(-1)).toEqual(["calls", { origin: null, recorded: false, page: 1, size: 50 }]);
    await app.inject({ method: "GET", url: "/api/admin/rep-tasks?open=maybe&page=2.9", headers: AUTH });
    expect(store.asked.at(-1)).toEqual(["tasks", { openOnly: true, page: 2, size: 50 }]);
  });

  it("an id in a path that isn't shaped like one never reaches the database", async () => {
    const { app, store } = await setup();
    const bad = ["a%20b", "a%22b", "a,b", "a(b)", "a%26select%3D*", "x".repeat(200)];
    const refused = [400, 404, 414]; // 414: Fastify's own limit on a path part (100 characters)
    for (const id of bad) {
      store.asked.length = 0;
      const tries = [
        await app.inject({ method: "GET", url: `/api/admin/contacts/${id}`, headers: AUTH }),
        await app.inject({ method: "GET", url: `/api/admin/calls/${id}`, headers: AUTH }),
        await app.inject({ method: "POST", url: `/api/admin/rep-tasks/${id}/done`, headers: AUTH, payload: {} }),
        await app.inject({ method: "POST", url: `/api/admin/users/${id}`, headers: AUTH, payload: {} }),
        await app.inject({ method: "POST", url: `/api/admin/users/${id}/password`, headers: AUTH, payload: { password: "a-new-pass-1" } }),
      ];
      for (const r of tries) expect(refused, `${id.slice(0, 30)} -> ${r.statusCode}`).toContain(r.statusCode);
      expect(store.asked, id.slice(0, 30)).toEqual([]);
    }
  });

  // finding ו: the recording route alone skips the call-id check (no injection: the value is one eq. value, above)
  it.fails("FINDING ו: a recording is asked for with a call id shaped like one", async () => {
    const { app, store } = await setup();
    const r = await app.inject({ method: "GET", url: "/api/admin/calls/a%20b%22c/recording", headers: AUTH });
    expect(r.statusCode).toBe(400);
    expect(store.asked).toEqual([]);
  });

  // finding ז: ?page= has no upper limit, and a repeated ?q= breaks the route
  it.fails("FINDING ז: a page number is always a whole number the database can take", async () => {
    const { app, store } = await setup();
    for (const page of ["Infinity", "1e20", "999999999999999999999"]) {
      store.asked.length = 0;
      await app.inject({ method: "GET", url: `/api/admin/contacts?page=${page}`, headers: AUTH });
      const asked = (store.asked[0]![1] as { page: number }).page;
      expect(Number.isSafeInteger(asked) && asked <= 1_000_000, page).toBe(true);
    }
  });
  it.fails("FINDING ז: a search given twice (?q=a&q=b) is refused or read, not a 502", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/admin/contacts?q=a&q=b", headers: AUTH })).statusCode).not.toBe(502);
  });
});

// ------------------------------------------------------------------ the public static files

describe("the dashboard's static files", () => {
  const OUTSIDE = [
    "/dashboard/../src/server.ts", "/dashboard/..%2fsrc%2fserver.ts", "/dashboard/%2e%2e/src/server.ts", "/dashboard/%2e%2e%2fsrc%2fserver.ts",
    "/dashboard/..\\src\\server.ts", "/dashboard/..%5csrc%5cserver.ts", "/dashboard/views/../../src/server.ts", "/dashboard/views/..%2f..%2fsrc%2fserver.ts",
    "/dashboard/../../../.env", "/dashboard/.env", "/dashboard/app.js/../../../../.env", "/dashboard/app.js%00.html", "/dashboard/app.js%00",
    "/dashboard/App.js", "/dashboard/views/views/calls.js", "/dashboard/views/Calls.js", "/dashboard/styles.css.map", "/dashboard/app.ts",
    "/dashboard/index.html", "/dashboard//app.js", "/dashboard/app.js/", "/dashboard/a/b.js", "/dashboard/.js", "/dashboard/1.js",
    "/dashboard/app.json", "/dashboard/app.js.bak", "/dashboard/package.json", "/dashboardx/app.js", "/dashboard/views/", "/dashboard/views",
  ];

  it("only the page, its stylesheet and its modules are public; nothing leaves the folder", async () => {
    const { app } = await setup();
    for (const url of ["/dashboard", "/dashboard/", "/dashboard/app.js", "/dashboard/styles.css", "/dashboard/views/calls.js"]) {
      expect(isDashboardFile(url), url).toBe(true);
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(200);
    }
    for (const url of OUTSIDE) {
      expect(isDashboardFile(url), url).toBe(false);
      // not public: a login is asked for first; with one, there is no such file
      const anon = await app.inject({ method: "GET", url });
      expect([400, 401, 404], `${url} -> ${anon.statusCode}`).toContain(anon.statusCode);
      const admin = await app.inject({ method: "GET", url, headers: AUTH });
      expect([400, 404], `${url} (admin) -> ${admin.statusCode}`).toContain(admin.statusCode);
      for (const body of [anon.body, admin.body]) {
        expect(body, url).not.toContain("buildServer");
        expect(body, url).not.toContain("TOOLS_SECRET=");
      }
    }
  });

  it("a query string doesn't make another path public", async () => {
    const { app } = await setup();
    for (const url of ["/api/admin/users?/dashboard/app.js", "/api/admin/users?x=/healthz", "/api/admin/users#/dashboard", "/auth/login/../../api/admin/users"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
  });

  // the React dashboard: only its page, its theme script and its built files (assets/<name>-<hash>.js|css)
  const NEW_OUTSIDE = [
    "/dashboard-new/../src/server.ts", "/dashboard-new/..%2f..%2fsrc%2fserver.ts", "/dashboard-new/%2e%2e/%2e%2e/package.json",
    "/dashboard-new/assets/../../package.json", "/dashboard-new/assets/..%2f..%2fpackage.json", "/dashboard-new/assets/%2e%2e%2f%2e%2e%2fpackage.json",
    "/dashboard-new/assets/..\\..\\package.json", "/dashboard-new/assets/x.js%00", "/dashboard-new/assets/x.js.map", "/dashboard-new/assets/x.map",
    "/dashboard-new/assets/a.b.js", "/dashboard-new/assets/sub/x.js", "/dashboard-new/assets/.js", "/dashboard-new/assets/x.html", "/dashboard-new/assets/x.json",
    "/dashboard-new/index.html", "/dashboard-new/vite.config.ts", "/dashboard-new/src/main.tsx", "/dashboard-new/../../../.env", "/dashboard-new/.env",
    "/dashboard-new/theme.js/", "/dashboard-new//theme.js", "/dashboard-new/Theme.js", "/dashboard-newx/theme.js", "/dashboard-new/assets/", "/dashboard-new/assets",
  ];

  it("the React dashboard is public the same way: its page and built files, nothing else, nothing outside dist/", async () => {
    const { app } = await setup();
    for (const url of ["/dashboard-new", "/dashboard-new/", "/dashboard-new/theme.js", "/dashboard-new/assets/index-AbC_12-x.js", "/dashboard-new/assets/index-x.css"]) {
      expect(isDashboardFile(url), url).toBe(true);
      // built or not, a public path answers without a login (200, or 404 when there is no such built file)
      expect([200, 404], url).toContain((await app.inject({ method: "GET", url })).statusCode);
    }
    for (const url of NEW_OUTSIDE) {
      expect(isDashboardFile(url), url).toBe(false);
      const anon = await app.inject({ method: "GET", url });
      expect([400, 401, 404], `${url} -> ${anon.statusCode}`).toContain(anon.statusCode);
      const admin = await app.inject({ method: "GET", url, headers: AUTH });
      expect([400, 404], `${url} (admin) -> ${admin.statusCode}`).toContain(admin.statusCode);
      for (const body of [anon.body, admin.body]) {
        expect(body, url).not.toContain("buildServer");
        expect(body, url).not.toContain('"name": "mishlav-bots"');
      }
    }
  });

  it("the React dashboard's headers: a CSP with no inline script, no framing, nosniff, no referrer", () => {
    const h = newDashboardHeaders({ SUPABASE_URL: "https://abc.supabase.co/" }, true);
    const csp = h["content-security-policy"]!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("media-src https://abc.supabase.co");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("no-referrer");
    expect(h["strict-transport-security"]).toBe("max-age=31536000");
    // no Supabase (or a broken address): recordings play from nowhere
    expect(newDashboardHeaders({ SUPABASE_URL: "not a url" }, false)["content-security-policy"]).toContain("media-src 'none'");
    expect(newDashboardHeaders({}, false)["strict-transport-security"]).toBeUndefined();
  });

  it.runIf(existsSync(join(NEW_DASHBOARD_DIR, "index.html")))("the built React dashboard is sent with those headers, and holds no secret", async () => {
    const app = await buildServer(testConfig(), { logger: false, env: { SUPABASE_URL: "https://abc.supabase.co" }, sms: new LogOnlySms(() => {}) });
    const page = await app.inject({ method: "GET", url: "/dashboard-new" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.body).not.toMatch(/<script>(?!\s*<\/script>)/); // no inline script (the CSP would block it anyway)
    const theme = await app.inject({ method: "GET", url: "/dashboard-new/theme.js" });
    expect(theme.statusCode).toBe(200);
    expect(theme.headers["x-content-type-options"]).toBe("nosniff");
    for (const m of page.body.matchAll(/\/dashboard-new\/(assets\/[^"]+)"/g)) {
      const r = await app.inject({ method: "GET", url: `/dashboard-new/${m[1]}` });
      expect(r.statusCode, m[1]).toBe(200);
      expect(r.body).not.toContain(SECRET);
      // values of secrets, not their names (an error message may name SUPABASE_SERVICE_ROLE_KEY): a JWT (Supabase keys),
      // Supabase's new secret keys, API keys, a private key, an assignment from an env file
      expect(r.body).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|sb_secret_|sk-[A-Za-z0-9]{20}|-----BEGIN|TOOLS_SECRET=|_KEY=/);
    }
  });

  it("the files carry no data and are not cached", async () => {
    const { app } = await setup();
    const page = await app.inject({ method: "GET", url: "/dashboard" });
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).not.toContain(SECRET);
    expect((await app.inject({ method: "GET", url: "/dashboard/app.js" })).headers["content-type"]).toBe("text/javascript; charset=utf-8");
  });
});

// ------------------------------------------------------------------ logging in and sessions

describe("logging in and sessions", () => {
  it("the cookie: HttpOnly, SameSite=Strict, 12 hours, Secure behind https", async () => {
    const { login } = await setup();
    const http = String((await login(DANA)).r.headers["set-cookie"]);
    expect(http).toMatch(/^mishlav_session=[^;]+; Max-Age=43200; Path=\/; HttpOnly; SameSite=Strict$/);
    const https = String((await login(DANA, { "x-forwarded-proto": "https" })).r.headers["set-cookie"]);
    expect(https).toMatch(/; HttpOnly; SameSite=Strict; Secure$/);
  });

  it("a token: ours, not expired, for an active user whose password hasn't changed since", async () => {
    const { app } = await setup();
    const me = (cookie: string) => app.inject({ method: "GET", url: "/auth/me", headers: { cookie } }).then((r) => r.statusCode);
    const soon = Date.now() + HOUR;
    expect(await me(token(USER_ID, AT, soon))).toBe(200);
    expect(await me(token(USER_ID, AT, Date.now() - 1000))).toBe(401); // expired
    expect(await me(token(USER_ID, AT, soon, "another-secret-0123456789"))).toBe(401); // not signed by this server
    expect(await me(token(USER_ID, "2026-10-01T00:00:00.000Z", soon))).toBe(401); // an older password
    expect(await me(token("00000000-0000-4000-8000-00000000ffff", AT, soon))).toBe(401); // nobody
    expect(await me(`${token(USER_ID, AT, soon)}x`)).toBe(401);
    expect(await me(token(USER_ID, AT, soon).replace(USER_ID, ADMIN_ID))).toBe(401); // someone else's id on her signature
    expect(await me("mishlav_session=")).toBe(401);
    expect(await me("mishlav_session=a.b.c")).toBe(401);
  });

  it("the role is the database's, never the token's: a demoted admin is a Mishlav user on the next request", async () => {
    const { app, users, login } = await setup();
    const guy = (await login(GUY)).cookie;
    expect((await app.inject({ method: "GET", url: "/api/admin/logs", headers: { cookie: guy } })).statusCode).toBe(200);
    // another admin (the key) demotes him: the server re-reads the users after its own change
    const r = await app.inject({ method: "POST", url: `/api/admin/users/${ADMIN_ID}`, headers: AUTH, payload: { role: "mishlav" } });
    expect(r.statusCode).toBe(200);
    expect(users.rows[1]!.role).toBe("mishlav");
    expect((await app.inject({ method: "GET", url: "/api/admin/logs", headers: { cookie: guy } })).statusCode).toBe(403);
  });

  it("a blocked user and a reset password end the open sessions", async () => {
    const { app, login } = await setup();
    const me = (cookie: string) => app.inject({ method: "GET", url: "/auth/me", headers: { cookie } }).then((r) => r.statusCode);
    const first = (await login(DANA)).cookie;
    expect(await me(first)).toBe(200);
    await app.inject({ method: "POST", url: `/api/admin/users/${USER_ID}/password`, headers: AUTH, payload: { password: "a-new-pass-1" } });
    expect(await me(first)).toBe(401);
    const second = (await login({ phone: DANA.phone, password: "a-new-pass-1" })).cookie;
    expect(await me(second)).toBe(200);
    await app.inject({ method: "POST", url: `/api/admin/users/${USER_ID}`, headers: AUTH, payload: { active: false } });
    expect(await me(second)).toBe(401);
    expect((await login({ phone: DANA.phone, password: "a-new-pass-1" })).r.statusCode).toBe(401); // and can't log in
  });

  it("the answer never says whether a phone is a user: unknown, wrong password, blocked, locked", async () => {
    const { app, login } = await setup();
    await app.inject({ method: "POST", url: `/api/admin/users/${USER_ID}`, headers: AUTH, payload: { active: false } });
    const answers = [
      (await login({ phone: "0500000001", password: "whatever-1" })).r, // nobody
      (await login({ phone: GUY.phone, password: "wrong-pass-1" })).r, // a wrong password
      (await login(DANA)).r, // blocked, the right password
    ];
    for (const r of answers) {
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ ok: false, error: "wrong_login", message_he: "מספר הטלפון או הסיסמה שגויים" });
      expect(r.headers["set-cookie"]).toBeUndefined();
    }
    // a phone nobody has locks after 5 tries exactly like a real one
    for (let i = 0; i < 4; i++) await login({ phone: "0500000001", password: "whatever-1" });
    expect((await login({ phone: "0500000001", password: "whatever-1" })).r.statusCode).toBe(429);
  });

  it("5 wrong passwords for a phone, 20 from an address: 429, even with the right password", async () => {
    const { login } = await setup();
    for (let i = 0; i < 5; i++) expect((await login({ phone: DANA.phone, password: "nope-nope" })).r.statusCode).toBe(401);
    expect((await login(DANA)).r.statusCode).toBe(429);
    // 15 more wrong ones from the same address, each for another phone: the address is locked for everyone
    for (let i = 0; i < 15; i++) await login({ phone: `05000001${String(i).padStart(2, "0")}`, password: "nope-nope" });
    const r = (await login(GUY)).r;
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toBe("too_many_attempts");
  });

  // finding ג: req.ip is taken from X-Forwarded-For (trustProxy: true), which the caller writes
  it.fails("FINDING ג: the limit per address can't be reset by sending another X-Forwarded-For", async () => {
    const { login } = await setup();
    for (let i = 0; i < 20; i++) {
      await login({ phone: `05000002${String(i).padStart(2, "0")}`, password: "nope-nope" }, { "x-forwarded-for": `203.0.113.${i}` });
    }
    const r = (await login({ phone: "0500000299", password: "nope-nope" }, { "x-forwarded-for": "203.0.113.200" })).r;
    expect(r.statusCode).toBe(429);
  });

  it("a login takes a phone and a password, nothing else, and not a long one", async () => {
    const { app } = await setup();
    const post = (payload: unknown) => app.inject({ method: "POST", url: "/auth/login", payload: payload as object });
    for (const bad of [{}, { phone: DANA.phone }, { ...DANA, role: "admin" }, { phone: ["0521111111"], password: "x" }, { phone: { $ne: "" }, password: { $ne: "" } },
      { phone: DANA.phone, password: "x".repeat(201) }, { phone: "0".repeat(31), password: "x" }]) {
      expect((await post(bad)).statusCode, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    // 64 KB is the most a request body may be
    const big = await app.inject({ method: "POST", url: "/auth/login", headers: { "content-type": "application/json" }, payload: JSON.stringify({ phone: DANA.phone, password: "x".repeat(70_000) }) });
    expect(big.statusCode).toBe(413);
  });

  it("a user changes only their own password, with the current one", async () => {
    const { app, login } = await setup();
    const dana = (await login(DANA)).cookie;
    const post = (payload: object) => app.inject({ method: "POST", url: "/auth/password", headers: { cookie: dana }, payload });
    expect((await post({ current: "wrong-pass-1", password: "brand-new-1" })).statusCode).toBe(400);
    expect((await post({ current: DANA.password, password: "short" })).statusCode).toBe(400);
    expect((await post({ current: DANA.password, password: "brand-new-1", id: ADMIN_ID })).statusCode).toBe(400); // no way to name someone else
    expect((await login(GUY)).r.statusCode).toBe(200); // Guy's password is untouched
  });

  it.todo("FINDING ג: wrong passwords sent at the same moment are counted before they are checked (today all of them get through)");
  it.todo("FINDING ג: the limiter forgets a phone or an address nobody asks about again (today its map only grows)");
  it.todo("FINDING יב: POST /auth/password limits wrong guesses of the current password");
});

// ------------------------------------------------------------------ security headers

describe("security headers", () => {
  it("no CORS: another site can't read an answer, and a preflight is not answered", async () => {
    const { app } = await setup();
    const origin = { origin: "https://evil.example" };
    for (const r of [
      await app.inject({ method: "GET", url: "/dashboard", headers: origin }),
      await app.inject({ method: "GET", url: "/auth/me", headers: { ...origin, ...AUTH } }),
      await app.inject({ method: "OPTIONS", url: "/api/admin/users", headers: { ...origin, "access-control-request-method": "GET", "access-control-request-headers": "x-tools-secret" } }),
    ]) {
      expect(r.headers["access-control-allow-origin"]).toBeUndefined();
      expect(r.headers["access-control-allow-credentials"]).toBeUndefined();
      expect(r.headers["access-control-allow-headers"]).toBeUndefined();
    }
  });

  // finding א: none of these is sent today
  it.fails("FINDING א: the dashboard page has a Content-Security-Policy", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/dashboard" })).headers["content-security-policy"]).toBeTruthy();
  });
  it.fails("FINDING א: the dashboard page can't be framed by another site", async () => {
    const { app } = await setup();
    const h = (await app.inject({ method: "GET", url: "/dashboard" })).headers;
    expect(h["x-frame-options"] || /frame-ancestors/.test(String(h["content-security-policy"] ?? ""))).toBeTruthy();
  });
  it.fails("FINDING א: X-Content-Type-Options: nosniff on every answer", async () => {
    const { app } = await setup();
    for (const url of ["/dashboard", "/dashboard/app.js", "/auth/me"]) {
      expect((await app.inject({ method: "GET", url, headers: AUTH })).headers["x-content-type-options"], url).toBe("nosniff");
    }
  });
  it.fails("FINDING א: a Referrer-Policy on the dashboard page", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/dashboard" })).headers["referrer-policy"]).toBeTruthy();
  });
});

// ------------------------------------------------------------------ what the answers and the logs hold

const CARD = "4580123412341234";

describe("what the answers hold", () => {
  it("a user never leaves the server with a password hash", async () => {
    const { app, login } = await setup();
    const answers = [
      (await login(GUY)).r,
      await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: (await login(GUY)).cookie } }),
      await app.inject({ method: "GET", url: "/api/admin/users", headers: AUTH }),
      await app.inject({ method: "POST", url: "/api/admin/users", headers: AUTH, payload: { name: "עופר", phone: "0532222222", role: "mishlav", password: "ofer-pass-1" } }),
      await app.inject({ method: "POST", url: `/api/admin/users/${USER_ID}`, headers: AUTH, payload: { name: "דנה" } }),
      await app.inject({ method: "POST", url: `/api/admin/users/${USER_ID}/password`, headers: AUTH, payload: { password: "a-new-pass-1" } }),
    ];
    for (const r of answers) {
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain("password_hash");
      expect(r.body).not.toContain("scrypt$");
      expect(r.body).not.toContain("a-new-pass-1");
      expect(r.body).not.toContain("ofer-pass-1");
    }
  });

  it("the recording link: only for a logged-in user, and signed for one hour", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/admin/calls/call-a/recording" })).statusCode).toBe(401);
    const asked: { url: string; body: string }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      asked.push({ url: String(url), body: String(init?.body ?? "") });
      const answer = String(url).includes("/storage/v1/") ? { signedURL: "/object/sign/recordings/call-a.mp3?token=t" } : [{ recording_path: "call-a.mp3" }];
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as typeof fetch;
    const url = await new SupabaseContacts("https://x.supabase.co", "service-key", fetchImpl).recordingUrl("call-a");
    expect(url).toBe("https://x.supabase.co/storage/v1/object/sign/recordings/call-a.mp3?token=t");
    expect(asked[1]).toEqual({ url: "https://x.supabase.co/storage/v1/object/sign/recordings/call-a.mp3", body: JSON.stringify({ expiresIn: 3600 }) });
  });

  it("the line's log (numbers, SIP details) and the server's version are for admins", async () => {
    const { app, login } = await setup();
    const dana = (await login(DANA)).cookie;
    expect((await app.inject({ method: "GET", url: "/test/phone", headers: { cookie: dana } })).json().log).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/test/phone", headers: AUTH })).json().log).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: dana } })).json().server).toBeUndefined();
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: AUTH })).json().server).toBeDefined();
  });

  // finding ב: the phone line writes the transcript to disk as spoken; the call route serves that file while the
  // database has none (every live call), and Mishlav's users may call it
  it.fails("FINDING ב: a card number said in a call is not shown in its live transcript", async () => {
    const { app, config, login } = await setup();
    const dir = join(config.logDir, "transcripts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "live-call-1.jsonl"), `${JSON.stringify({ ts: FIXED_NOW.toISOString(), role: "user", text: `המספר הוא ${CARD}` })}\n`, "utf8");
    const r = await app.inject({ method: "GET", url: "/api/admin/calls/live-call-1", headers: { cookie: (await login(DANA)).cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain(CARD);
  });

  // finding ט: Supabase's own error text (the table, the first 200 characters of its answer) goes back to the caller
  it.fails("FINDING ט: a database error is not sent to the browser as it is", async () => {
    const { app, store } = await setup();
    store.fail = true;
    const r = await app.inject({ method: "GET", url: "/api/admin/contacts", headers: AUTH });
    expect(r.statusCode).toBe(502);
    expect(r.body).not.toContain("internal-detail-do-not-show");
  });
  it.fails("FINDING ט: a database error at the login (no login needed to see it) is not sent as it is", async () => {
    const { app, users } = await setup();
    users.fail = true;
    const r = await app.inject({ method: "POST", url: "/auth/login", payload: DANA });
    expect(r.body).not.toContain("internal-detail-do-not-show");
  });
});

describe("what the logs hold", () => {
  /** A server whose own log (pino) is kept in memory, with everything a browser would send. */
  async function logged() {
    const lines: string[] = [];
    const s = await setup({ logger: { level: "info", stream: { write: (l: string) => void lines.push(l) } } });
    return { ...s, lines };
  }
  const everything = (s: { app: FastifyInstance; config: { logDir: string }; lines: string[] }) =>
    s.app.inject({ method: "GET", url: "/api/admin/logs", headers: AUTH }).then((r) => {
      let toolLog = "";
      try {
        toolLog = readFileSync(join(s.config.logDir, "tool-calls.jsonl"), "utf8");
      } catch {
        // nothing was written
      }
      return [s.lines.join(""), r.body, toolLog].join("\n");
    });

  it("no password, session token or TOOLS_SECRET in the server's log, the dashboard's log or tool-calls.jsonl", async () => {
    const s = await logged();
    const wrong = "wrong-password-ZZ91";
    await s.login({ phone: DANA.phone, password: wrong });
    const { cookie } = await s.login(DANA);
    const value = decodeURIComponent(cookie.split("=")[1]!);
    await s.app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
    await s.app.inject({ method: "GET", url: "/auth/me", headers: AUTH });
    await s.app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${SECRET}` } });
    await s.app.inject({ method: "GET", url: "/api/admin/users", headers: { "x-tools-secret": "a-wrong-secret-0123456789" } });
    await s.app.inject({ method: "POST", url: "/auth/password", headers: { cookie }, payload: { current: DANA.password, password: "brand-new-pw-77" } });
    await s.app.inject({ method: "POST", url: "/api/admin/users", headers: AUTH, payload: { name: "עופר", phone: "0532222222", role: "mishlav", password: "ofer-pass-1" } });
    await s.app.inject({ method: "POST", url: `/api/admin/users/${USER_ID}/password`, headers: AUTH, payload: { password: "reset-pw-4455" } });
    const all = await everything(s);
    expect(all).toContain("logged in"); // the log is really being read
    for (const secret of [wrong, DANA.password, "brand-new-pw-77", "ofer-pass-1", "reset-pw-4455", SECRET, "a-wrong-secret-0123456789", value, value.split(".")[3]!]) {
      expect(all.includes(secret), secret).toBe(false);
    }
    // a failed login is logged with the phone masked
    expect(all).toContain("+97252***1111");
    expect(all).not.toContain("+972521111111");
  });

  it("a card number sent to a tool is removed before it is logged", async () => {
    const s = await logged();
    await s.app.inject({ method: "POST", url: "/tools/request_human", headers: { ...AUTH, "x-call-id": "call-sec-1" }, payload: { reason: "other", note: `כרטיס ${CARD}` } });
    const all = await everything(s);
    expect(all).toContain("call-sec-1");
    expect(all).not.toContain(CARD);
  });

  // finding יא: pino logs each request's address, and the contacts search is in it
  it.fails("FINDING יא: what was searched for (a name, a phone) is not in the server's log", async () => {
    const s = await logged();
    await s.app.inject({ method: "GET", url: `/api/admin/contacts?q=${encodeURIComponent("0534271418")}`, headers: AUTH });
    expect(s.lines.join("")).not.toContain("0534271418");
  });

  it.todo("FINDING ד: requests without a login don't grow tool-calls.jsonl without a limit (each 401 appends a line today, and the file is read whole for every call's details)");
  it.todo("FINDING ד: wrong keys sent to /api/gold/changes don't each write a line to the kept log (server_logs)");
});
