import { describe, expect, it } from "vitest";
import { SupabaseContacts } from "../src/contacts";
import { buildServer } from "../src/server";
import { LogOnlySms } from "../src/sms";
import { LiveKnowledge, StudyDayExists, type StudyDayRow, type StudyDayStore, type StudyDayWrite } from "../src/study-days";
import { AUTH, FIXED_NOW, testConfig } from "./helpers";

const row = (id: string, extra: Partial<StudyDayRow> = {}): StudyDayRow => ({
  id,
  title: "דיני עבודה ומס הכנסה",
  topic: "דיני עבודה ומס הכנסה",
  date: "2027-02-21",
  end_date: "2027-02-22",
  start_time: "10:00",
  end_time: "13:15",
  format: "zoom",
  series: null,
  location: "בזום",
  price_ils: "370.00", // numeric may come as a string
  vat_included: true,
  open_for_registration: true,
  course_number: null,
  purchase_url: null,
  lecturers: ["מיקי בן דב", "אפי נדיב"],
  academic_hours: 7.5,
  description: "",
  archived_at: null,
  updated_at: "2026-11-20T10:00:00Z",
  ...extra,
});

/** In memory, like the table: the id is unique, a day is archived, never deleted. */
class FakeDays implements StudyDayStore {
  rows: StudyDayRow[];
  fail = false;
  constructor(...rows: StudyDayRow[]) {
    this.rows = rows;
  }
  async studyDays() {
    if (this.fail) throw new Error("Supabase down");
    return [...this.rows].sort((a, b) => a.date.localeCompare(b.date));
  }
  async createStudyDay(r: StudyDayWrite & { id: string }) {
    if (this.rows.some((x) => x.id === r.id)) throw new StudyDayExists(r.id);
    const created = { ...r, archived_at: null, updated_at: "2026-11-24T10:00:00Z" };
    this.rows.push(created);
    return created;
  }
  async updateStudyDay(id: string, r: StudyDayWrite) {
    const i = this.rows.findIndex((x) => x.id === id);
    if (i < 0) return null;
    this.rows[i] = { ...this.rows[i]!, ...r, updated_at: new Date().toISOString() };
    return this.rows[i]!;
  }
  async setStudyDayArchived(id: string, archived: boolean) {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return null;
    r.archived_at = archived ? "2026-11-24T10:00:00Z" : null;
    r.updated_at = new Date().toISOString();
    return r;
  }
}

const FORM = {
  title: "ביטוח לאומי",
  topic: "ביטוח לאומי",
  date: "2027-04-12",
  end_date: "2027-04-13",
  start: "10:00",
  end: "13:15",
  format: "zoom",
  location: "בזום",
  price_ils: 370,
  vat_included: true,
  open_for_registration: true,
  lecturers: ["שי עופרי"],
  academic_hours: 7.5,
  course_number: "4512",
  purchase_url: "https://mishlav.co.il/buy/4512",
};

async function setup(store?: FakeDays) {
  const app = await buildServer(testConfig(), { now: () => FIXED_NOW, logger: false, sms: new LogOnlySms(() => {}), studyDays: store });
  const get = (url: string) => app.inject({ method: "GET", url, headers: AUTH });
  const post = (url: string, body?: unknown) => app.inject({ method: "POST", url, headers: AUTH, payload: body ?? {} });
  return { app, get, post };
}

describe("study days in Supabase: what the bot sees", () => {
  it("the bot reads the table: archived and invalid rows left out, numbers converted", async () => {
    const logs: string[] = [];
    const live = new LiveKnowledge(
      new FakeDays(
        row("2027-02-21-zoom"),
        row("2027-03-17-zoom", { date: "2027-03-17", end_date: "2027-03-18", archived_at: "2026-11-01T00:00:00Z" }),
        row("2027-05-17-hotel", { format: "hotel", date: "2027-05-17" }), // hotel with a second date: invalid
      ),
      "general",
      (_k, t) => logs.push(t),
    );
    await live.refresh();
    expect([...live.days.keys()]).toEqual(["2027-02-21-zoom"]);
    const d = live.days.get("2027-02-21-zoom")!;
    expect(d).toMatchObject({ price_ils: 370, academic_hours: 7.5, series: "2027-02-21-zoom", start: "10:00", end: "13:15" });
    expect(d.course_number).toBeUndefined();
    expect(logs.some((l) => l.includes("left out") && l.includes("2027-05-17-hotel"))).toBe(true);
  });

  it("a failed refresh keeps the last good days", async () => {
    const store = new FakeDays(row("2027-02-21-zoom"));
    const live = new LiveKnowledge(store, "");
    await live.refresh();
    store.fail = true;
    await expect(live.refresh()).rejects.toThrow("Supabase down");
    expect(live.days.size).toBe(1);
  });

  it("the server reads them at start; a change from the dashboard reaches the tools and the prompt at once", async () => {
    const store = new FakeDays(row("2027-02-21-zoom"));
    const { app, get, post } = await setup(store);
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toMatchObject({ days: 1, days_source: "supabase" });

    const before = (await post("/tools/get_day_info", { day_id: "2027-02-21-zoom" })).json();
    expect(before.day).toMatchObject({ price_ils: 370, lecturers: ["מיקי בן דב", "אפי נדיב"], academic_hours: 7.5 });

    const edit = { ...FORM, date: "2027-02-21", end_date: "2027-02-22", price_ils: 380 };
    expect((await post("/api/admin/study-days/2027-02-21-zoom", edit)).statusCode).toBe(200);
    const after = (await post("/tools/get_day_info", { day_id: "2027-02-21-zoom" })).json();
    expect(after.day).toMatchObject({ price_ils: 380, course_number: "4512", title: "ביטוח לאומי" });

    const created = (await post("/api/admin/study-days", FORM)).json();
    expect(created).toMatchObject({ ok: true, day: { id: "2027-04-12-zoom", offered_to_bot: true } });
    const vars = (await get("/test/context")).json().variables;
    expect(vars.day_catalog).toContain("`2027-04-12-zoom` – ביטוח לאומי · 12–13.4.2027");

    expect((await post("/api/admin/study-days/2027-04-12-zoom/archive")).json()).toMatchObject({ ok: true, day: { archived: true } });
    expect((await get("/test/context")).json().variables.day_catalog).not.toContain("2027-04-12-zoom");
    expect((await post("/tools/get_day_info", { day_id: "2027-04-12-zoom" })).json()).toMatchObject({ ok: false, error: "unknown_day_id" });
    await post("/api/admin/study-days/2027-04-12-zoom/restore");
    expect((await get("/test/context")).json().variables.day_catalog).toContain("2027-04-12-zoom");
    await app.close();
  });

  it("a server that can't read the table doesn't start", async () => {
    const store = new FakeDays();
    store.fail = true;
    await expect(setup(store)).rejects.toThrow(/study_days/);
  });
});

describe("/api/admin/study-days", () => {
  it("lists every day, archived ones too, with the bot's note and the catalogue", async () => {
    const { app, get } = await setup(
      new FakeDays(row("2027-02-21-zoom", { course_number: "4512" }), row("2027-03-17-zoom", { date: "2027-03-17", end_date: "2027-03-18", archived_at: "2026-11-01T00:00:00Z" })),
    );
    const r = (await get("/api/admin/study-days")).json();
    expect(r.ok).toBe(true);
    expect(r.days.map((d: { id: string; archived: boolean; offered_to_bot: boolean }) => [d.id, d.archived, d.offered_to_bot])).toEqual([
      ["2027-02-21-zoom", false, true],
      ["2027-03-17-zoom", true, false],
    ]);
    expect(r.days[0]).toMatchObject({ dates_he: "21–22.2.2027", note_he: "דיני עבודה ומס הכנסה – 21–22.2.2027 · בזום · מספר קורס 4512", error: null });
    expect(r.catalog_he.split("\n")).toEqual(["בזום – יום עיון אחד בשני מפגשים (הקרוב ראשון):", "- `2027-02-21-zoom` – דיני עבודה ומס הכנסה · 21–22.2.2027 · 10:00–13:15"]);
    await app.close();
  });

  it("rejects invalid days in Hebrew, a taken id, an unknown day; needs the secret", async () => {
    const { app, post } = await setup(new FakeDays(row("2027-02-21-zoom")));
    const bad = await post("/api/admin/study-days", { ...FORM, price_ils: -1 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ message_he: "לא תקין: מחיר", fields: ["price_ils"] });
    const oneMeeting = await post("/api/admin/study-days", { ...FORM, end_date: undefined });
    expect(oneMeeting.json().message_he).toBe("לא תקין: תאריך המפגש השני");
    expect((await post("/api/admin/study-days", { ...FORM, nope: 1 })).statusCode).toBe(400);

    const taken = await post("/api/admin/study-days", { ...FORM, date: "2027-02-21", end_date: "2027-02-22" });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe("day_exists");

    expect((await post("/api/admin/study-days/2099-01-01-zoom", FORM)).statusCode).toBe(404);
    expect((await post("/api/admin/study-days/NOT%20AN%20ID/archive")).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/admin/study-days" })).statusCode).toBe(401);
    await app.close();
  });

  it("without Supabase: 409, and the bot uses the fixed days", async () => {
    const { app, get } = await setup();
    expect((await get("/api/admin/study-days")).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toMatchObject({ days: 8, days_source: "files" });
    await app.close();
  });
});

describe("SupabaseContacts study days (REST)", () => {
  it("reads, creates (409 -> StudyDayExists), updates and archives over PostgREST", async () => {
    const seen: { method: string; url: string; body?: unknown }[] = [];
    let status = 200;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ method: init.method!, url, body: init.body ? JSON.parse(init.body as string) : undefined });
      return new Response(status === 200 ? JSON.stringify([row("2027-02-21-zoom")]) : "{}", { status });
    }) as unknown as typeof fetch;
    const s = new SupabaseContacts("https://x.supabase.co", "key", fetchImpl);

    await s.studyDays();
    expect(seen[0]).toMatchObject({ method: "GET", url: "https://x.supabase.co/rest/v1/study_days?select=*&order=date.asc,id.asc" });

    const { id: _id, archived_at: _a, updated_at: _u, ...write } = row("2027-02-21-zoom");
    await s.updateStudyDay("2027-02-21-zoom", write);
    expect(seen[1]).toMatchObject({ method: "PATCH", url: "https://x.supabase.co/rest/v1/study_days?id=eq.2027-02-21-zoom" });
    expect((seen[1]!.body as { updated_at: string }).updated_at).toBeTruthy();

    await s.setStudyDayArchived("2027-02-21-zoom", true);
    expect(seen[2]!.body).toMatchObject({ archived_at: expect.any(String) });

    status = 409;
    await expect(s.createStudyDay({ id: "2027-02-21-zoom", ...write })).rejects.toBeInstanceOf(StudyDayExists);
    expect(seen[3]).toMatchObject({ method: "POST", url: "https://x.supabase.co/rest/v1/study_days" });
  });
});
