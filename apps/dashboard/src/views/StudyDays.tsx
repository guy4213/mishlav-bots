/**
 * ימי עיון (port of views/study-days.js): the study days the bot offers (Supabase study_days). A table with filters
 * (upcoming / past / archive, searched here: there are few); a day opens in the drawer to view and edit every field;
 * new day, duplicate (the next date of the same day), close registration, archive (never deleted: old calls and Gold
 * notes still name it). Read every 60 s. The bot sees a change at once on this server, within a minute on another.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../components/Icon";
import { DrawerView } from "../components/Overlays";
import { Chip, EmptyState, ErrorState, Kv, LoadingState } from "../components/ui";
import { get, post } from "../lib/api";
import { fmtDateTime, todayIso } from "../lib/format";
import { useEvery } from "../lib/hooks";
import { safeUrl } from "../lib/safe-url";
import type { StudyDay, StudyDayRow } from "../lib/types";
import { closeDrawer, confirmDialog, openDrawer, toast } from "../lib/ui-store";

const lastDate = (d: StudyDay) => d.raw.end_date ?? d.raw.date;
const isPast = (d: StudyDay) => lastDate(d) < todayIso();
const FORMAT_HE: Record<string, string> = { zoom: "זום", hotel: "מלון" };
const money = (n: number | string) => `${Number(n).toLocaleString("he-IL", { maximumFractionDigits: 2 })} ₪`;
const beforeVat = (n: number | string) => Math.round((Number(n) / 1.18) * 100) / 100; // VAT 18%

/** What is still missing for the bot to sell the day (the reps' course number, the purchase link). */
const missing = (r: StudyDayRow) => [!r.course_number && "מספר קורס", !r.purchase_url && "קישור לרכישה"].filter(Boolean) as string[];

function StatusChips({ d }: { d: StudyDay }) {
  const r = d.raw;
  if (d.archived) return <Chip label="בארכיון" tone="muted" />;
  if (d.error) return <Chip label="לא תקין – הבוט לא רואה" tone="danger" />;
  if (isPast(d)) return <Chip label="עבר" tone="muted" />;
  const m = missing(r);
  return (
    <>
      {r.open_for_registration ? <Chip label="הרשמה פתוחה" tone="success" dot /> : <Chip label="הרשמה סגורה" tone="warning" dot />}
      {m.length ? (
        <>
          {" "}
          <Chip label={`חסר: ${m.join(", ")}`} tone="warning" />
        </>
      ) : null}
    </>
  );
}

/** The days as last read: the drawers (a day, the form) read them too, after each change. */
let all: StudyDay[] = [];
let reloadDays: () => Promise<void> = async () => {};

type Filter = "upcoming" | "past" | "archived" | "all";

export default function StudyDays() {
  const [days, setDays] = useState<StudyDay[] | null>(null);
  const [catalog, setCatalog] = useState("");
  const [error, setError] = useState<{ msg: string; noSupabase: boolean } | null>(null);
  const [filter, setFilter] = useState<Filter>("upcoming");
  const [search, setSearch] = useState("");
  const load = async () => {
    try {
      const r = await get<{ days: StudyDay[]; catalog_he: string }>("/api/admin/study-days");
      all = r.days;
      setDays(r.days);
      setCatalog(r.catalog_he);
      setError(null);
    } catch (e) {
      setError({ msg: (e as Error).message, noSupabase: /Supabase לא מחובר/.test((e as Error).message) });
    }
  };
  reloadDays = load;
  useEffect(
    () => () => {
      all = [];
      reloadDays = async () => {};
    },
    [],
  );
  useEvery(60_000, load);

  const q = search.trim().toLowerCase();
  const inFilter = (d: StudyDay) => (filter === "all" ? true : filter === "archived" ? d.archived : !d.archived && (filter === "past" ? isPast(d) : !isPast(d)));
  const text = (d: StudyDay) => [d.raw.title, d.raw.topic, d.raw.course_number, d.raw.location, ...(d.raw.lecturers ?? []), d.dates_he].join(" ").toLowerCase();
  const list = (days ?? []).filter((d) => inFilter(d) && (!q || text(d).includes(q)));
  if (filter === "past") list.reverse();
  return (
    <>
      <div className="toolbar">
        <div className="seg" id="sdFilter">
          {(
            [
              ["upcoming", "קרובים"],
              ["past", "עברו"],
              ["archived", "ארכיון"],
              ["all", "הכול"],
            ] as [Filter, string][]
          ).map(([f, l]) => (
            <button key={f} data-f={f} className={filter === f ? "on" : undefined} onClick={() => setFilter(f)}>
              {l}
            </button>
          ))}
        </div>
        <label className="search">
          <Icon name="search" />
          <input type="search" id="sdSearch" placeholder="חיפוש לפי נושא, מרצה, מספר קורס…" onInput={(e) => setSearch((e.target as HTMLInputElement).value)} />
        </label>
        <span className="muted small" id="sdCount">
          {days ? `${list.length} ימי עיון` : ""}
        </span>
        <span className="spacer" />
        <button className="btn primary" id="sdNew" onClick={() => openForm(null)}>
          <Icon name="plus" /> יום עיון חדש
        </button>
      </div>
      <div className="card" id="sdBody">
        {error ? (
          error.noSupabase ? (
            <EmptyState title="Supabase לא מחובר" text="בשרת הזה ימי העיון נקראים מקבצי הבדיקה, ואי אפשר לערוך אותם כאן." />
          ) : (
            <ErrorState msg={error.msg} />
          )
        ) : !days ? (
          <LoadingState rows={8} />
        ) : !list.length ? (
          <EmptyState title="אין ימי עיון כאן" text='אפשר להוסיף יום עיון בכפתור "יום עיון חדש".' icon="calendar" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>תאריך</th>
                  <th>יום העיון</th>
                  <th>זום / מלון</th>
                  <th>שעות</th>
                  <th>מחיר</th>
                  <th>מספר קורס</th>
                  <th>מצב</th>
                </tr>
              </thead>
              <tbody>
                {list.map((d) => {
                  const r = d.raw;
                  return (
                    <tr key={r.id} className="click" data-id={r.id} onClick={() => openDay(r.id)}>
                      <td className="nowrap num">{d.dates_he}</td>
                      <td>
                        <div className="cell-main">{r.title}</div>
                        <div className="cell-sub">{(r.lecturers ?? []).join(", ")}</div>
                      </td>
                      <td>
                        <Chip label={FORMAT_HE[r.format] ?? r.format} tone={r.format === "zoom" ? "info" : "violet"} />
                      </td>
                      <td className="nowrap num">
                        {r.start_time}–{r.end_time}
                      </td>
                      <td className="nowrap num">{money(r.price_ils)}</td>
                      <td className="num">{r.course_number ? r.course_number : <span className="faint">—</span>}</td>
                      <td>
                        <StatusChips d={d} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2>מה הבוט רואה עכשיו</h2>
          <span className="sub">רשימת ימי העיון שנכנסת לכל שיחה (ימים שעברו או בארכיון לא מופיעים)</span>
        </div>
        <div className="card-body">
          <pre className="small" dir="auto" id="sdCatalog" style={{ whiteSpace: "pre-wrap", margin: 0, font: "inherit" }}>
            {catalog}
          </pre>
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ one day: view

function openDay(id: string) {
  const d = all.find((x) => x.raw.id === id);
  if (!d) return;
  openDrawer(<DayDrawer d={d} />);
}

function DayDrawer({ d }: { d: StudyDay }) {
  const r = d.raw;
  const seriesOf = all.find((x) => x.raw.id !== r.id && r.series && (x.raw.id === r.series || x.raw.series === r.series));
  const purchase = safeUrl(r.purchase_url, ["https:"]);
  const toggle = async () => {
    try {
      await post(`/api/admin/study-days/${encodeURIComponent(r.id)}`, { ...formFromRow(r), open_for_registration: !r.open_for_registration });
      toast(r.open_for_registration ? "ההרשמה נסגרה – הבוט לא ישלח קישור ליום הזה" : "ההרשמה נפתחה", "ok");
      await reloadDays();
      openDay(r.id);
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };
  const archive = async () => {
    if (!d.archived) {
      const ok = await confirmDialog({
        title: `להעביר את "${r.title}" (${d.dates_he}) לארכיון?`,
        text: "הבוט יפסיק להציע אותו מיד. לא נמחק כלום: אפשר להחזיר אותו מהארכיון.",
        okLabel: "העברה לארכיון",
        danger: true,
      });
      if (!ok.ok) return;
    }
    try {
      await post(`/api/admin/study-days/${encodeURIComponent(r.id)}/${d.archived ? "restore" : "archive"}`);
      toast(d.archived ? "הוחזר מהארכיון" : "הועבר לארכיון", "ok");
      await reloadDays();
      openDay(r.id);
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };
  return (
    <DrawerView
      title={
        <>
          {r.title} <StatusChips d={d} />
        </>
      }
      sub={
        <>
          <span className="ltr">{r.id}</span> · {d.dates_he}
        </>
      }
    >
      <div className="row" style={{ marginBottom: 18 }}>
        <button className="btn primary" id="sdEdit" onClick={() => openForm(d)}>
          עריכה
        </button>
        <button className="btn" id="sdDup" onClick={() => openForm(d, { duplicate: true })}>
          שכפול למועד נוסף
        </button>
        {d.archived ? null : (
          <button className="btn" id="sdToggle" onClick={() => void toggle()}>
            {r.open_for_registration ? "סגירת ההרשמה" : "פתיחת ההרשמה"}
          </button>
        )}
        <span className="spacer" />
        <button className={`btn ${d.archived ? "" : "ghost"}`} id="sdArchive" onClick={() => void archive()}>
          {d.archived ? (
            "החזרה מהארכיון"
          ) : (
            <>
              <Icon name="trash" /> העברה לארכיון
            </>
          )}
        </button>
      </div>
      {d.error ? (
        <div className="state error compact">
          <div className="state-text">{d.error}</div>
        </div>
      ) : null}
      <div className="section-title">פרטים</div>
      <Kv
        pairs={[
          ["תאריכים", r.format === "zoom" ? `${d.dates_he} – יום עיון אחד בשני מפגשים` : d.dates_he],
          [
            "שעות",
            <>
              <span className="num">
                {r.start_time}–{r.end_time}
              </span>
              {r.format === "zoom" ? " בכל מפגש" : null}
            </>,
          ],
          ["זום / מלון", d.format_he],
          ["מקום", r.location],
          ["נושא", r.topic],
          ["מרצים", (r.lecturers ?? []).join(", ") || <span className="faint">—</span>],
          [
            "מחיר",
            <>
              {money(r.price_ils)}{" "}
              {r.vat_included ? (
                <>
                  כולל מע"מ <span className="faint">({money(beforeVat(r.price_ils))} לפני מע"מ)</span>
                </>
              ) : (
                `לפני מע"מ`
              )}
            </>,
          ],
          ["שעות אקדמיות", r.academic_hours ? String(r.academic_hours) : null],
          ["מספר קורס", r.course_number ? <span className="num">{r.course_number}</span> : <span className="faint">חסר</span>],
          [
            "קישור לרכישה",
            r.purchase_url ? (
              purchase ? (
                <a className="ltr" href={purchase} target="_blank" rel="noopener noreferrer">
                  {r.purchase_url}
                </a>
              ) : (
                <span className="ltr">{r.purchase_url}</span>
              )
            ) : (
              <span className="faint">חסר – הבוט יציע שנציג יחזור עם הקישור</span>
            ),
          ],
          ["אותו תוכן כמו", seriesOf ? `${seriesOf.raw.title} (${seriesOf.dates_he}, ${FORMAT_HE[seriesOf.raw.format]})` : null],
          ["עודכן", r.updated_at ? fmtDateTime(r.updated_at) : null],
        ]}
      />
      {r.description ? (
        <>
          <div className="section-title">סדר יום</div>
          <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{r.description}</p>
        </>
      ) : null}
      <div className="section-title">איך הבוט רואה את זה</div>
      <Kv
        pairs={[
          ["בשיחה", d.offered_to_bot ? (isPast(d) ? "עבר – לא מוצע" : "מוצע ללקוחות") : "לא מוצע"],
          ["הערה בגולד", d.note_he ? d.note_he : null],
        ]}
      />
    </DrawerView>
  );
}

// ------------------------------------------------------------------ one day: the form (new / edit / duplicate)

/** A row -> what POST /api/admin/study-days takes (every field; empty ones left out). */
function formFromRow(r: StudyDayRow) {
  const f: Record<string, unknown> = {
    title: r.title,
    topic: r.topic,
    date: r.date,
    end_date: r.end_date ?? undefined,
    start: r.start_time,
    end: r.end_time,
    format: r.format,
    series: r.series ?? undefined,
    location: r.location,
    price_ils: Number(r.price_ils),
    vat_included: r.vat_included,
    open_for_registration: r.open_for_registration,
    course_number: r.course_number ?? undefined,
    purchase_url: r.purchase_url ?? undefined,
    lecturers: r.lecturers ?? [],
    academic_hours: r.academic_hours === null || r.academic_hours === undefined ? undefined : Number(r.academic_hours),
    description: r.description ?? "",
  };
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
}

const DEFAULTS = {
  zoom: { start_time: "10:00", end_time: "13:15", location: "בזום", price_ils: 370 },
  hotel: { start_time: "09:00", end_time: "16:00", location: "מלון דן פנורמה, תל אביב", price_ils: 790 },
} as const;

/** Same labels as the server's message (routes/study-days.ts FIELD_HE), to mark the fields it names. */
const FIELD_LABELS: Record<string, string> = {
  title: "שם יום העיון",
  topic: "נושא",
  date: "תאריך",
  end_date: "תאריך המפגש השני",
  start: "שעת התחלה",
  end: "שעת סיום",
  location: "מקום",
  price_ils: "מחיר",
  course_number: "מספר קורס",
  purchase_url: "קישור לרכישה",
  lecturers: "מרצים",
  academic_hours: "שעות אקדמיות",
  description: "סדר יום",
};

function openForm(d: StudyDay | null, { duplicate = false } = {}) {
  openDrawer(<DayForm d={d} duplicate={duplicate} />);
}

type Base = Partial<StudyDayRow> & { format: "zoom" | "hotel" };

function DayForm({ d, duplicate }: { d: StudyDay | null; duplicate: boolean }) {
  const editing = !!d && !duplicate;
  const base: Base = d
    ? { ...d.raw, ...(duplicate ? { date: "", end_date: null, course_number: null, purchase_url: null, series: d.raw.series ?? d.raw.id } : {}) }
    : { format: "zoom", ...DEFAULTS.zoom, vat_included: true, open_for_registration: true, lecturers: [], academic_hours: 7.5, description: "" };
  const [format, setFormat] = useState<"zoom" | "hotel">(base.format);
  const [vat, setVat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [bad, setBad] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const field = (n: string) => form.current?.elements.namedItem(n) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  const others = all.filter((x) => !editing || x.raw.id !== d!.raw.id);
  const seriesOptions = [...new Map(others.map((x) => [x.raw.series ?? x.raw.id, x])).entries()];

  const syncVat = () => {
    const p = Number(field("price_ils")?.value);
    setVat(p > 0 && (field("vat_included") as HTMLInputElement | null)?.checked ? `${money(beforeVat(p))} לפני מע"מ` : "");
  };
  useEffect(syncVat, []);

  const pickFormat = (f: "zoom" | "hotel") => {
    if (f === format) return;
    setFormat(f);
    // a new format: its usual hours, place and price (still editable)
    const def = DEFAULTS[f];
    const set = (n: string, v: string | number) => {
      const el = field(n);
      if (el) el.value = String(v);
    };
    set("start", def.start_time);
    set("end", def.end_time);
    set("location", def.location);
    set("price_ils", def.price_ils);
    if (f === "hotel") set("end_date", "");
    syncVat();
  };

  const submit = async () => {
    const txt = (n: string) => (field(n)?.value ?? "").trim();
    const num = (n: string) => (txt(n) === "" ? undefined : Number(txt(n)));
    const title = txt("title");
    const body = {
      title,
      topic: txt("topic") || title,
      date: txt("date"),
      ...(format === "zoom" && txt("end_date") ? { end_date: txt("end_date") } : {}),
      start: txt("start"),
      end: txt("end"),
      format,
      ...(txt("series") ? { series: txt("series") } : {}),
      location: txt("location"),
      price_ils: num("price_ils"),
      vat_included: (field("vat_included") as HTMLInputElement).checked,
      open_for_registration: (field("open_for_registration") as HTMLInputElement).checked,
      ...(txt("course_number") ? { course_number: txt("course_number") } : {}),
      ...(txt("purchase_url") ? { purchase_url: txt("purchase_url") } : {}),
      lecturers: (field("lecturers")?.value ?? "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      ...(num("academic_hours") !== undefined ? { academic_hours: num("academic_hours") } : {}),
      description: (field("description")?.value ?? "").trim(),
    };
    setBad(new Set());
    setError(null);
    setSaving(true);
    try {
      const path = editing ? `/api/admin/study-days/${encodeURIComponent(d!.raw.id)}` : "/api/admin/study-days";
      const res = await post(path, body);
      toast(res.warning_he ?? (editing ? "נשמר – הבוט כבר רואה את השינוי" : "נוסף – הבוט כבר מציע אותו"), res.warning_he ? "" : "ok");
      await reloadDays();
      openDay(res.day.raw.id);
    } catch (ex) {
      const msg = (ex as Error).message;
      setError(msg);
      // the server names the bad fields in message_he; mark them too
      const named = msg.startsWith("לא תקין: ") ? msg.slice("לא תקין: ".length).split(", ") : [];
      setBad(new Set(Object.entries(FIELD_LABELS).filter(([, label]) => named.includes(label)).map(([f]) => f)));
      setSaving(false);
    }
  };

  const title = editing ? `עריכה: ${d!.raw.title}` : duplicate ? `מועד נוסף: ${d!.raw.title}` : "יום עיון חדש";
  const F = ({ f, full, children, id }: { f: string; full?: boolean; children: ReactNode; id?: string }) => (
    <label className={`field${full ? " full" : ""}${bad.has(f) ? " bad" : ""}`} data-f={f} id={id}>
      {children}
    </label>
  );
  return (
    <DrawerView title={title} sub={editing ? <span className="ltr">{d!.raw.id}</span> : "המזהה נקבע לפי התאריך הראשון והפורמט"}>
      <form
        id="sdForm"
        className="form-grid"
        noValidate
        ref={form}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="field full">
          זום או מלון
          <div className="seg" id="fFormat">
            <button type="button" data-v="zoom" className={format === "zoom" ? "on" : ""} onClick={() => pickFormat("zoom")}>
              זום – יום עיון אחד בשני מפגשים
            </button>
            <button type="button" data-v="hotel" className={format === "hotel" ? "on" : ""} onClick={() => pickFormat("hotel")}>
              מלון – יום אחד
            </button>
          </div>
        </div>
        {F({ f: "title", full: true, children: <>שם יום העיון (כך הבוט יקרא לו)<input type="text" name="title" defaultValue={base.title ?? ""} maxLength={120} required /></> })}
        {F({ f: "topic", full: true, children: <>נושא<input type="text" name="topic" defaultValue={base.topic ?? ""} maxLength={200} placeholder="למשל: דיני עבודה ומס הכנסה" /></> })}
        {F({
          f: "date",
          children: (
            <>
              <span id="fDateLabel">{format === "zoom" ? "תאריך המפגש הראשון" : "תאריך"}</span>
              <input
                type="date"
                name="date"
                defaultValue={base.date ?? ""}
                required
                onChange={() => {
                  // the second meeting is usually the next day
                  const date = field("date")?.value;
                  const end = field("end_date");
                  if (format !== "zoom" || !end || end.value || !date) return;
                  const t = new Date(`${date}T12:00:00Z`);
                  t.setUTCDate(t.getUTCDate() + 1);
                  end.value = t.toISOString().slice(0, 10);
                }}
              />
            </>
          ),
        })}
        <label className={`field${bad.has("end_date") ? " bad" : ""}`} data-f="end_date" id="fEndWrap" hidden={format !== "zoom"}>
          תאריך המפגש השני
          <input type="date" name="end_date" defaultValue={base.end_date ?? ""} />
        </label>
        {F({ f: "start", children: <>שעת התחלה<input type="time" name="start" defaultValue={base.start_time ?? ""} required /></> })}
        {F({ f: "end", children: <>שעת סיום<input type="time" name="end" defaultValue={base.end_time ?? ""} required /></> })}
        {F({ f: "location", full: true, children: <>מקום<input type="text" name="location" defaultValue={base.location ?? ""} maxLength={200} /></> })}
        {F({
          f: "price_ils",
          children: (
            <>
              מחיר למשתתף (₪)
              <input type="number" name="price_ils" defaultValue={base.price_ils ?? ""} min="1" step="0.5" required onInput={syncVat} />
              <span className="small faint" id="fVat">
                {vat}
              </span>
            </>
          ),
        })}
        {F({ f: "academic_hours", children: <>שעות אקדמיות<input type="number" name="academic_hours" defaultValue={base.academic_hours ?? ""} min="0.5" step="0.5" /></> })}
        <label className="switch full">
          <input type="checkbox" name="vat_included" defaultChecked={!!base.vat_included} onChange={syncVat} /> המחיר כולל מע"מ
        </label>
        {F({ f: "lecturers", full: true, children: <>מרצים (מרצה בכל שורה)<textarea name="lecturers" rows={3} defaultValue={(base.lecturers ?? []).join("\n")} /></> })}
        {F({ f: "course_number", children: <>מספר קורס (לגולד)<input type="text" name="course_number" defaultValue={base.course_number ?? ""} maxLength={40} className="ltr" /></> })}
        {F({ f: "purchase_url", children: <>קישור לרכישה<input type="url" name="purchase_url" defaultValue={base.purchase_url ?? ""} placeholder="https://…" className="ltr" /></> })}
        {F({
          f: "series",
          full: true,
          children: (
            <>
              אותו תוכן כמו (לשאלה "יש מועד אחר?")
              <select name="series" defaultValue={base.series ?? ""}>
                <option value="">— יום עיון בפני עצמו —</option>
                {seriesOptions.map(([s, x]) => (
                  <option key={s} value={s}>
                    {x.raw.title} · {x.dates_he} · {FORMAT_HE[x.raw.format]}
                  </option>
                ))}
              </select>
            </>
          ),
        })}
        {F({
          f: "description",
          full: true,
          children: <>סדר יום / פרטים נוספים (הבוט יכול לספר על זה)<textarea name="description" rows={4} maxLength={5000} defaultValue={base.description ?? ""} /></>,
        })}
        <label className="switch full">
          <input type="checkbox" name="open_for_registration" defaultChecked={!!base.open_for_registration} /> ההרשמה פתוחה (הבוט שולח קישור)
        </label>
        <div className="full small" id="fError" style={{ color: "var(--danger)" }} hidden={!error}>
          {error}
        </div>
        <div className="row full" style={{ marginTop: 6 }}>
          <button className="btn primary" type="submit" id="fSave" disabled={saving}>
            {editing ? "שמירה" : "הוספה"}
          </button>
          <button className="btn ghost" type="button" id="fCancel" onClick={() => (d ? openDay(d.raw.id) : closeDrawer())}>
            ביטול
          </button>
        </div>
      </form>
    </DrawerView>
  );
}
