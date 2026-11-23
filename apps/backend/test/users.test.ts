import { describe, expect, it } from "vitest";
import { mayCall, viewAs } from "../src/access";
import { SupabaseContacts } from "../src/contacts";
import { buildServer } from "../src/server";
import { LogOnlySms } from "../src/sms";
import { type DashboardUser, hashPassword, LoginLimiter, type UserStore, UserExists, verifyPassword } from "../src/users";
import { AUTH, FIXED_NOW, testConfig } from "./helpers";

/** In memory, like the table: the phone is unique, a user is blocked, never deleted. */
class FakeUsers implements UserStore {
  rows: DashboardUser[] = [];
  fail = false;
  private n = 0;
  async dashboardUsers() {
    if (this.fail) throw new Error("Supabase down");
    return this.rows.map((r) => ({ ...r }));
  }
  async createDashboardUser(row: Pick<DashboardUser, "phone" | "name" | "role" | "password_hash">) {
    if (this.rows.some((r) => r.phone === row.phone)) throw new UserExists(row.phone);
    const id = `00000000-0000-4000-8000-${String(++this.n).padStart(12, "0")}`;
    const at = new Date(Date.UTC(2026, 10, 1, 0, 0, this.n)).toISOString();
    const u: DashboardUser = { id, ...row, active: true, password_changed_at: at, last_login_at: null, created_at: at };
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

/** The phone line: who it was asked to dial. */
class FakeLine {
  dialed: { number: string; opts: Record<string, unknown> }[] = [];
  call: { id: string } | null = null;
  recent = [{ seq: 1, ts: FIXED_NOW.toISOString(), call_id: null, text: "SIP details" }];
  async dial(number: string, opts: Record<string, unknown>) {
    this.dialed.push({ number, opts });
    this.call = { id: `call-${this.dialed.length}` };
    return { call_id: this.call.id };
  }
  status() {
    return { registered: true, busy: !!this.call, call: this.call };
  }
  async hangup() {
    const had = !!this.call;
    this.call = null;
    return had;
  }
}

const DANA = "0521111111";
const GUY = "0547777777";

async function setup(withUsers = true) {
  const store = new FakeUsers();
  store.rows.push(
    { id: "00000000-0000-4000-8000-0000000000a1", phone: "+972521111111", name: "דנה לוי", role: "mishlav", password_hash: await hashPassword("dana-pass-1"), active: true, password_changed_at: "2026-11-01T00:00:00.000Z", last_login_at: null, created_at: "2026-11-01T00:00:00.000Z" },
    { id: "00000000-0000-4000-8000-0000000000a2", phone: "+972547777777", name: "גיא", role: "admin", password_hash: await hashPassword("guy-pass-12"), active: true, password_changed_at: "2026-11-01T00:00:00.000Z", last_login_at: null, created_at: "2026-11-01T00:00:01.000Z" },
  );
  const line = new FakeLine();
  const app = await buildServer(testConfig(), {
    now: () => FIXED_NOW,
    logger: false,
    sms: new LogOnlySms(() => {}),
    users: withUsers ? store : undefined,
    phone: { line: line as never, reason: null },
  });
  const login = async (phone: string, password: string) => {
    const r = await app.inject({ method: "POST", url: "/auth/login", payload: { phone, password } });
    const cookie = String(r.headers["set-cookie"] ?? "").split(";")[0]!;
    return { r, cookie };
  };
  const as = (cookie: string) => ({
    get: (url: string) => app.inject({ method: "GET", url, headers: { cookie } }),
    post: (url: string, payload: object = {}) => app.inject({ method: "POST", url, headers: { cookie }, payload }),
  });
  return { app, store, line, login, as };
}

describe("passwords", () => {
  it("are kept as scrypt hashes and checked", async () => {
    const h = await hashPassword("secret-123");
    expect(h).toMatch(/^scrypt\$/);
    expect(h).not.toContain("secret-123");
    expect(await verifyPassword("secret-123", h)).toBe(true);
    expect(await verifyPassword("secret-124", h)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });

  it("5 wrong ones in 15 minutes: wait", () => {
    let t = FIXED_NOW.getTime();
    const lim = new LoginLimiter(() => new Date(t));
    for (let i = 0; i < 5; i++) lim.fail(["phone:x"]);
    expect(lim.waitSeconds(["phone:x"])).toBe(900);
    t += 15 * 60_000;
    expect(lim.waitSeconds(["phone:x"])).toBe(0);
  });
});

describe("logging in", () => {
  it("phone + password -> an HttpOnly cookie; who am I; logout", async () => {
    const { login, as } = await setup();
    const { r, cookie } = await login("052-111-1111", "dana-pass-1");
    expect(r.statusCode).toBe(200);
    expect(r.json().user).toMatchObject({ name: "דנה לוי", role: "mishlav", phone: "+972521111111" });
    expect(r.json().user.password_hash).toBeUndefined();
    expect(String(r.headers["set-cookie"])).toMatch(/HttpOnly; SameSite=Strict/);
    expect((await as(cookie).get("/auth/me")).json()).toMatchObject({ role: "mishlav", via: "session", user: { name: "דנה לוי" } });
    const out = await as(cookie).post("/auth/logout");
    expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");
  });

  it("a wrong password or phone: 401, the same message; then too many attempts", async () => {
    const { login } = await setup();
    const a = await login(DANA, "nope-nope");
    const b = await login("0500000000", "dana-pass-1");
    expect([a.r.statusCode, b.r.statusCode]).toEqual([401, 401]);
    expect(a.r.json().message_he).toBe(b.r.json().message_he);
    for (let i = 0; i < 4; i++) await login(DANA, "nope-nope"); // 5 for Dana's phone
    const locked = await login(DANA, "dana-pass-1"); // even the right password, for now
    expect(locked.r.statusCode).toBe(429);
  });

  it("a forged or old cookie is refused; TOOLS_SECRET still works for everything", async () => {
    const { app, as, login } = await setup();
    const { cookie } = await login(DANA, "dana-pass-1");
    const forged = cookie.replace(/\.[^.]+$/, ".AAAA");
    expect((await as(forged).get("/auth/me")).statusCode).toBe(401);
    expect((await as("mishlav_session=x").get("/auth/me")).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: AUTH })).json()).toMatchObject({ role: "admin", via: "secret", user: null });
    expect((await app.inject({ method: "GET", url: "/api/admin/logs", headers: AUTH })).statusCode).toBe(200);
  });

  it("without Supabase: no logins, the secret works", async () => {
    const { login, app } = await setup(false);
    expect((await login(DANA, "dana-pass-1")).r.statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: AUTH })).statusCode).toBe(200);
  });
});

describe("what Mishlav's users may do", () => {
  it("work screens yes; logs, the dialer switch, the voice, test tools, the bot's tools, users: no", async () => {
    const { login, as } = await setup();
    const dana = as((await login(DANA, "dana-pass-1")).cookie);
    // allowed (409 here = no Supabase in this test, past the role check)
    for (const url of ["/api/admin/summary", "/api/admin/contacts", "/api/admin/calls", "/api/admin/rep-tasks", "/api/admin/study-days"]) {
      expect((await dana.get(url)).statusCode, url).not.toBe(403);
    }
    expect((await dana.get("/api/admin/dialer")).statusCode).toBe(200);
    // closed
    const closed: [string, string][] = [
      ["GET", "/api/admin/logs"], ["GET", "/api/admin/env"], ["POST", "/api/admin/dialer/start"], ["POST", "/api/admin/dialer/stop"],
      ["POST", "/api/admin/voice"], ["POST", "/test/phone/call"], ["GET", "/test/overview"], ["GET", "/test/contacts"],
      ["POST", "/tools/get_day_info"], ["GET", "/api/admin/users"], ["POST", "/api/admin/sms/test"], ["GET", "/test/gold/changes"],
    ];
    for (const [m, url] of closed) {
      const r = m === "GET" ? await dana.get(url) : await dana.post(url);
      expect(r.statusCode, `${m} ${url}`).toBe(403);
    }
    expect((await dana.get("/api/admin/logs")).json().message_he).toBe("אין לך הרשאה לפעולה הזו");
  });

  it("the line's state without its log", async () => {
    const { login, as, app } = await setup();
    const dana = as((await login(DANA, "dana-pass-1")).cookie);
    expect((await dana.get("/test/phone")).json()).toMatchObject({ available: true, log: [] });
    expect((await app.inject({ method: "GET", url: "/test/phone", headers: AUTH })).json().log).toHaveLength(1);
  });

  it("an admin can view as Mishlav (x-view-as: the same 403s); the header never raises anyone", async () => {
    const { login, app } = await setup();
    const VIEW = { "x-view-as": "mishlav" };
    const guy = (await login(GUY, "guy-pass-12")).cookie;
    const dana = (await login(DANA, "dana-pass-1")).cookie;
    const req = (method: "GET" | "POST", url: string, headers: Record<string, string>) => app.inject({ method, url, headers, payload: method === "POST" ? {} : undefined });

    // Guy viewing as Mishlav: who am I says so, and the closed screens are closed to him too
    expect((await req("GET", "/auth/me", { cookie: guy, ...VIEW })).json()).toMatchObject({ role: "mishlav", viewing_as: true, user: { name: "גיא" } });
    for (const [m, url] of [["GET", "/api/admin/users"], ["GET", "/api/admin/logs"], ["POST", "/api/admin/dialer/stop"], ["POST", "/test/phone/call"]] as const) {
      expect((await req(m, url, { cookie: guy, ...VIEW })).statusCode, `${m} ${url}`).toBe(403);
    }
    expect((await req("GET", "/api/admin/dialer", { cookie: guy, ...VIEW })).statusCode).toBe(200);
    expect((await req("GET", "/test/phone", { cookie: guy, ...VIEW })).json().log).toEqual([]); // the log hidden, as for them
    // the same with TOOLS_SECRET; without the header he is an admin again
    expect((await req("GET", "/api/admin/logs", { ...AUTH, ...VIEW })).statusCode).toBe(403);
    expect((await req("GET", "/auth/me", { cookie: guy })).json()).toMatchObject({ role: "admin", viewing_as: false, server: { version: expect.stringMatching(/^v\d+\.\d+$/) } });
    // the version is for admins: not for Mishlav's users, nor for an admin viewing as them
    expect((await req("GET", "/auth/me", { cookie: guy, ...VIEW })).json().server).toBeUndefined();
    expect((await req("GET", "/auth/me", { cookie: dana })).json().server).toBeUndefined();
    expect((await req("GET", "/api/admin/users", { cookie: guy })).statusCode).toBe(200);

    // a Mishlav user can't use it to go up
    for (const v of ["admin", "mishlav", "ADMIN"]) {
      expect((await req("GET", "/api/admin/users", { cookie: dana, "x-view-as": v })).statusCode, v).toBe(403);
      expect((await req("GET", "/auth/me", { cookie: dana, "x-view-as": v })).json()).toMatchObject({ role: "mishlav", viewing_as: false });
    }
    expect(viewAs({ role: "mishlav", via: "session", user: null }, "admin").role).toBe("mishlav");
  });

  it("a route nobody opened is closed to them", () => {
    expect(mayCall("mishlav", "GET", "/api/admin/something-new")).toBe(false);
    expect(mayCall("mishlav", "POST", "/api/admin/rep-tasks/x/done")).toBe(true);
    expect(mayCall("admin", "GET", "/api/admin/something-new")).toBe(true);
  });

  it("a test call goes to their own phone only, under their first name; another user can't hang it up", async () => {
    const { login, as, line } = await setup();
    const dana = as((await login(DANA, "dana-pass-1")).cookie);
    const info = (await dana.get("/api/me/test-call")).json();
    expect(info).toMatchObject({ phone: DANA, line: { available: true, busy: false } });
    expect(info.days[0]).toMatchObject({ id: "2027-02-21-zoom" });

    const r = await dana.post("/api/me/test-call", { day_id: "2027-05-17-hotel", number: "0509999999" });
    expect(r.statusCode).toBe(400); // no number field at all
    expect((await dana.post("/api/me/test-call", { day_id: "nope" })).statusCode).toBe(400);
    const ok = await dana.post("/api/me/test-call", { day_id: "2027-05-17-hotel" });
    expect(ok.json()).toMatchObject({ ok: true, call_id: "call-1" });
    expect(line.dialed[0]).toMatchObject({ number: "+972521111111", opts: { name: "דנה", day: "2027-05-17-hotel" } });

    // a second Mishlav user can't end Dana's call
    await as((await login(GUY, "guy-pass-12")).cookie).post("/api/admin/users", { name: "עופר", phone: "0532222222", role: "mishlav", password: "ofer-pass-1" });
    const ofer = as((await login("0532222222", "ofer-pass-1")).cookie);
    expect((await ofer.post("/api/me/hangup")).json()).toMatchObject({ hung_up: false });
    expect((await dana.post("/api/me/hangup")).json()).toMatchObject({ hung_up: true });
  });
});

describe("managing users (admins)", () => {
  it("add, duplicate phone 409, rename; the new user logs in", async () => {
    const { login, as } = await setup();
    const guy = as((await login(GUY, "guy-pass-12")).cookie);
    const add = await guy.post("/api/admin/users", { name: "ענת", phone: "050-333-3333", role: "mishlav", password: "anat-pass-1" });
    expect(add.json()).toMatchObject({ ok: true, user: { name: "ענת", phone: "+972503333333", role: "mishlav", active: true } });
    expect(add.json().user.password_hash).toBeUndefined();
    expect((await guy.post("/api/admin/users", { name: "x", phone: "0503333333", role: "mishlav", password: "12345678" })).statusCode).toBe(409);
    expect((await guy.post("/api/admin/users", { name: "x", phone: "0504444444", role: "mishlav", password: "short" })).json().fields).toEqual(["password"]);
    expect((await guy.post("/api/admin/users", { name: "x", phone: "12", role: "mishlav", password: "12345678" })).statusCode).toBe(400);
    expect((await login("0503333333", "anat-pass-1")).r.statusCode).toBe(200);
    const list = (await guy.get("/api/admin/users")).json().users;
    expect(list.map((u: { name: string }) => u.name)).toEqual(["דנה לוי", "גיא", "ענת"]);
  });

  it("blocking ends the open session at once; a new password ends it too", async () => {
    const { login, as } = await setup();
    const guy = as((await login(GUY, "guy-pass-12")).cookie);
    const dana = as((await login(DANA, "dana-pass-1")).cookie);
    const id = "00000000-0000-4000-8000-0000000000a1";

    await guy.post(`/api/admin/users/${id}`, { active: false });
    expect((await dana.get("/auth/me")).statusCode).toBe(401);
    expect((await login(DANA, "dana-pass-1")).r.statusCode).toBe(401);
    await guy.post(`/api/admin/users/${id}`, { active: true });

    const again = as((await login(DANA, "dana-pass-1")).cookie);
    expect((await again.get("/auth/me")).statusCode).toBe(200);
    await guy.post(`/api/admin/users/${id}/password`, { password: "new-pass-99" });
    expect((await again.get("/auth/me")).statusCode).toBe(401);
    expect((await login(DANA, "new-pass-99")).r.statusCode).toBe(200);
  });

  it("an admin can't block or demote themselves", async () => {
    const { login, as } = await setup();
    const guy = as((await login(GUY, "guy-pass-12")).cookie);
    const me = "00000000-0000-4000-8000-0000000000a2";
    expect((await guy.post(`/api/admin/users/${me}`, { active: false })).statusCode).toBe(409);
    expect((await guy.post(`/api/admin/users/${me}`, { role: "mishlav" })).statusCode).toBe(409);
    expect((await guy.post(`/api/admin/users/${me}`, { name: "גיא פ." })).statusCode).toBe(200);
  });

  it("a user changes their own password: the right current one, this browser stays in", async () => {
    const { login, as } = await setup();
    const { cookie } = await login(DANA, "dana-pass-1");
    const dana = as(cookie);
    expect((await dana.post("/auth/password", { current: "wrong", password: "dana-pass-2" })).json().error).toBe("wrong_password");
    const r = await dana.post("/auth/password", { current: "dana-pass-1", password: "dana-pass-2" });
    expect(r.statusCode).toBe(200);
    const fresh = String(r.headers["set-cookie"]).split(";")[0]!;
    expect((await as(fresh).get("/auth/me")).statusCode).toBe(200);
    expect((await dana.get("/auth/me")).statusCode).toBe(401); // the old cookie
    expect((await login(DANA, "dana-pass-2")).r.statusCode).toBe(200);
  });
});

describe("SupabaseContacts dashboard users (REST)", () => {
  it("reads, creates (409 -> UserExists) and updates over PostgREST", async () => {
    const seen: { method: string; url: string }[] = [];
    let status = 200;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ method: init.method!, url });
      return new Response(status === 200 ? "[]" : "{}", { status });
    }) as unknown as typeof fetch;
    const s = new SupabaseContacts("https://x.supabase.co", "key", fetchImpl);
    await s.dashboardUsers();
    await s.updateDashboardUser("abc", { active: false });
    status = 409;
    await expect(s.createDashboardUser({ phone: "+972521111111", name: "x", role: "mishlav", password_hash: "h" })).rejects.toBeInstanceOf(UserExists);
    expect(seen).toEqual([
      { method: "GET", url: "https://x.supabase.co/rest/v1/dashboard_users?select=*&order=created_at.asc" },
      { method: "PATCH", url: "https://x.supabase.co/rest/v1/dashboard_users?id=eq.abc" },
      { method: "POST", url: "https://x.supabase.co/rest/v1/dashboard_users" },
    ]);
  });
});
