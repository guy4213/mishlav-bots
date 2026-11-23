// ימי עיון: the study days the bot offers (Supabase study_days). A table with filters (upcoming / past / archive);
// a day opens in the drawer to view and edit every field; new day, duplicate (the next date of the same day),
// close registration, archive (never deleted: old calls and Gold notes still name it). The bot sees a change at once
// on this server, within a minute on another one.
import { get, post } from "../api.js";
import { chip, confirmDialog, emptyState, errorState, esc, every, fmtDateTime, icon, loadingState, openDrawer, toast } from "../ui.js";

let stopPoll = null;
let all = [];
let rerender = () => {};

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
const lastDate = (d) => d.raw.end_date ?? d.raw.date;
const isPast = (d) => lastDate(d) < today();
const FORMAT_HE = { zoom: "זום", hotel: "מלון" };
const money = (n) => `${Number(n).toLocaleString("he-IL", { maximumFractionDigits: 2 })} ₪`;
const beforeVat = (n) => Math.round((Number(n) / 1.18) * 100) / 100; // VAT 18%

/** What is still missing for the bot to sell the day (the reps' course number, the purchase link). */
const missing = (r) => [!r.course_number && "מספר קורס", !r.purchase_url && "קישור לרכישה"].filter(Boolean);

function statusChips(d) {
  const r = d.raw;
  if (d.archived) return chip("בארכיון", "muted");
  if (d.error) return chip("לא תקין – הבוט לא רואה", "danger");
  if (isPast(d)) return chip("עבר", "muted");
  const out = [r.open_for_registration ? chip("הרשמה פתוחה", "success", { dot: true }) : chip("הרשמה סגורה", "warning", { dot: true })];
  const m = missing(r);
  if (m.length) out.push(chip(`חסר: ${m.join(", ")}`, "warning"));
  return out.join(" ");
}

function rows(list) {
  if (!list.length) return emptyState("אין ימי עיון כאן", "אפשר להוסיף יום עיון בכפתור \"יום עיון חדש\".", "calendar");
  return `<div class="table-wrap"><table class="data"><thead><tr>
      <th>תאריך</th><th>יום העיון</th><th>זום / מלון</th><th>שעות</th><th>מחיר</th><th>מספר קורס</th><th>מצב</th>
    </tr></thead><tbody>${list
      .map((d) => {
        const r = d.raw;
        return `<tr class="click" data-id="${esc(r.id)}">
          <td class="nowrap num">${esc(d.dates_he)}</td>
          <td><div class="cell-main">${esc(r.title)}</div><div class="cell-sub">${esc((r.lecturers ?? []).join(", "))}</div></td>
          <td>${chip(FORMAT_HE[r.format] ?? r.format, r.format === "zoom" ? "info" : "violet")}</td>
          <td class="nowrap num">${esc(r.start_time)}–${esc(r.end_time)}</td>
          <td class="nowrap num">${money(r.price_ils)}</td>
          <td class="num">${r.course_number ? esc(r.course_number) : `<span class="faint">—</span>`}</td>
          <td>${statusChips(d)}</td>
        </tr>`;
      })
      .join("")}</tbody></table></div>`;
}

export default {
  id: "study-days",
  title: "ימי עיון",
  icon: "calendar",
  mount(root) {
    let filter = "upcoming";
    root.innerHTML = `
      <div class="toolbar">
        <div class="seg" id="sdFilter">
          <button data-f="upcoming" class="on">קרובים</button><button data-f="past">עברו</button><button data-f="archived">ארכיון</button><button data-f="all">הכול</button>
        </div>
        <label class="search">${icon("search")}<input type="search" id="sdSearch" placeholder="חיפוש לפי נושא, מרצה, מספר קורס…"></label>
        <span class="muted small" id="sdCount"></span>
        <span class="spacer"></span>
        <button class="btn primary" id="sdNew">${icon("plus")} יום עיון חדש</button>
      </div>
      <div class="card" id="sdBody">${loadingState(8)}</div>
      <div class="card" style="margin-top:16px">
        <div class="card-head"><h2>מה הבוט רואה עכשיו</h2><span class="sub">רשימת ימי העיון שנכנסת לכל שיחה (ימים שעברו או בארכיון לא מופיעים)</span></div>
        <div class="card-body"><pre class="small" dir="auto" id="sdCatalog" style="white-space:pre-wrap;margin:0;font:inherit"></pre></div>
      </div>`;
    const body = root.querySelector("#sdBody");
    rerender = () => {
      const q = root.querySelector("#sdSearch").value.trim().toLowerCase();
      const inFilter = (d) =>
        filter === "all" ? true : filter === "archived" ? d.archived : !d.archived && (filter === "past" ? isPast(d) : !isPast(d));
      const text = (d) => [d.raw.title, d.raw.topic, d.raw.course_number, d.raw.location, ...(d.raw.lecturers ?? []), d.dates_he].join(" ").toLowerCase();
      const list = all.filter((d) => inFilter(d) && (!q || text(d).includes(q)));
      if (filter === "past") list.reverse();
      root.querySelector("#sdCount").textContent = `${list.length} ימי עיון`;
      body.innerHTML = rows(list);
    };
    const load = async () => {
      try {
        const r = await get("/api/admin/study-days");
        all = r.days;
        root.querySelector("#sdCatalog").textContent = r.catalog_he;
        rerender();
      } catch (e) {
        body.innerHTML = /Supabase לא מחובר/.test(e.message)
          ? emptyState("Supabase לא מחובר", "בשרת הזה ימי העיון נקראים מקבצי הבדיקה, ואי אפשר לערוך אותם כאן.")
          : errorState(e.message);
      }
    };
    root.querySelector("#sdFilter").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-f]");
      if (!b) return;
      filter = b.dataset.f;
      root.querySelectorAll("#sdFilter button").forEach((x) => x.classList.toggle("on", x === b));
      rerender();
    });
    root.querySelector("#sdSearch").addEventListener("input", () => rerender());
    root.querySelector("#sdNew").onclick = () => openForm(null, load);
    body.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-id]");
      if (tr) openDay(tr.dataset.id, load);
    });
    stopPoll = every(60_000, load);
  },
  unmount() {
    stopPoll?.();
  },
};

// ------------------------------------------------------------------ one day: view

function openDay(id, reload) {
  const d = all.find((x) => x.raw.id === id);
  if (!d) return;
  const r = d.raw;
  const dr = openDrawer({ title: `${esc(r.title)} ${statusChips(d)}`, sub: `<span class="ltr">${esc(r.id)}</span> · ${esc(d.dates_he)}` });
  const kv = (pairs) =>
    `<dl class="kv">${pairs.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
  const seriesOf = all.find((x) => x.raw.id !== r.id && r.series && (x.raw.id === r.series || x.raw.series === r.series));
  dr.body.innerHTML = `
    <div class="row" style="margin-bottom:18px">
      <button class="btn primary" id="sdEdit">עריכה</button>
      <button class="btn" id="sdDup">שכפול למועד נוסף</button>
      ${d.archived ? "" : `<button class="btn" id="sdToggle">${r.open_for_registration ? "סגירת ההרשמה" : "פתיחת ההרשמה"}</button>`}
      <span class="spacer"></span>
      <button class="btn ${d.archived ? "" : "ghost"}" id="sdArchive">${d.archived ? "החזרה מהארכיון" : `${icon("trash")} העברה לארכיון`}</button>
    </div>
    ${d.error ? `<div class="state error compact"><div class="state-text">${esc(d.error)}</div></div>` : ""}
    <div class="section-title">פרטים</div>
    ${kv([
      ["תאריכים", r.format === "zoom" ? `${esc(d.dates_he)} – יום עיון אחד בשני מפגשים` : esc(d.dates_he)],
      ["שעות", `<span class="num">${esc(r.start_time)}–${esc(r.end_time)}</span>${r.format === "zoom" ? " בכל מפגש" : ""}`],
      ["זום / מלון", esc(d.format_he)],
      ["מקום", esc(r.location)],
      ["נושא", esc(r.topic)],
      ["מרצים", esc((r.lecturers ?? []).join(", ")) || `<span class="faint">—</span>`],
      ["מחיר", `${money(r.price_ils)} ${r.vat_included ? `כולל מע"מ <span class="faint">(${money(beforeVat(r.price_ils))} לפני מע"מ)</span>` : `לפני מע"מ`}`],
      ["שעות אקדמיות", r.academic_hours ? esc(r.academic_hours) : null],
      ["מספר קורס", r.course_number ? `<span class="num">${esc(r.course_number)}</span>` : `<span class="faint">חסר</span>`],
      ["קישור לרכישה", r.purchase_url ? `<a class="ltr" href="${esc(r.purchase_url)}" target="_blank" rel="noopener">${esc(r.purchase_url)}</a>` : `<span class="faint">חסר – הבוט יציע שנציג יחזור עם הקישור</span>`],
      ["אותו תוכן כמו", seriesOf ? `${esc(seriesOf.raw.title)} (${esc(seriesOf.dates_he)}, ${esc(FORMAT_HE[seriesOf.raw.format])})` : null],
      ["עודכן", r.updated_at ? esc(fmtDateTime(r.updated_at)) : null],
    ])}
    ${r.description ? `<div class="section-title">סדר יום</div><p style="white-space:pre-wrap;margin:0">${esc(r.description)}</p>` : ""}
    <div class="section-title">איך הבוט רואה את זה</div>
    ${kv([
      ["בשיחה", d.offered_to_bot ? (isPast(d) ? "עבר – לא מוצע" : "מוצע ללקוחות") : "לא מוצע"],
      ["הערה בגולד", d.note_he ? esc(d.note_he) : null],
    ])}`;
  dr.body.querySelector("#sdEdit").onclick = () => openForm(d, reload);
  dr.body.querySelector("#sdDup").onclick = () => openForm(d, reload, { duplicate: true });
  const toggle = dr.body.querySelector("#sdToggle");
  if (toggle) {
    toggle.onclick = async () => {
      try {
        await post(`/api/admin/study-days/${encodeURIComponent(r.id)}`, { ...formFromRow(r), open_for_registration: !r.open_for_registration });
        toast(r.open_for_registration ? "ההרשמה נסגרה – הבוט לא ישלח קישור ליום הזה" : "ההרשמה נפתחה", "ok");
        await reload();
        openDay(r.id, reload);
      } catch (e) {
        toast(e.message, "bad");
      }
    };
  }
  dr.body.querySelector("#sdArchive").onclick = async () => {
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
      await reload();
      openDay(r.id, reload);
    } catch (e) {
      toast(e.message, "bad");
    }
  };
}

// ------------------------------------------------------------------ one day: the form (new / edit / duplicate)

/** A row -> what POST /api/admin/study-days takes (every field; empty ones left out). */
function formFromRow(r) {
  const f = {
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
};

function openForm(d, reload, { duplicate = false } = {}) {
  const editing = d && !duplicate;
  const base = d
    ? { ...d.raw, ...(duplicate ? { date: "", end_date: null, course_number: null, purchase_url: null, series: d.raw.series ?? d.raw.id } : {}) }
    : { format: "zoom", ...DEFAULTS.zoom, vat_included: true, open_for_registration: true, lecturers: [], academic_hours: 7.5, description: "" };
  const title = editing ? `עריכה: ${esc(d.raw.title)}` : duplicate ? `מועד נוסף: ${esc(d.raw.title)}` : "יום עיון חדש";
  const dr = openDrawer({ title, sub: editing ? `<span class="ltr">${esc(d.raw.id)}</span>` : "המזהה נקבע לפי התאריך הראשון והפורמט" });
  const others = all.filter((x) => !editing || x.raw.id !== d.raw.id);
  const seriesOptions = [...new Map(others.map((x) => [x.raw.series ?? x.raw.id, x])).entries()]
    .map(([s, x]) => `<option value="${esc(s)}" ${base.series === s ? "selected" : ""}>${esc(x.raw.title)} · ${esc(x.dates_he)} · ${esc(FORMAT_HE[x.raw.format])}</option>`)
    .join("");
  const v = (x) => esc(x ?? "");
  dr.body.innerHTML = `
    <form id="sdForm" class="form-grid" novalidate>
      <div class="field full">זום או מלון
        <div class="seg" id="fFormat">
          <button type="button" data-v="zoom" class="${base.format === "zoom" ? "on" : ""}">זום – יום עיון אחד בשני מפגשים</button>
          <button type="button" data-v="hotel" class="${base.format === "hotel" ? "on" : ""}">מלון – יום אחד</button>
        </div>
      </div>
      <label class="field full" data-f="title">שם יום העיון (כך הבוט יקרא לו)<input type="text" name="title" value="${v(base.title)}" maxlength="120" required></label>
      <label class="field full" data-f="topic">נושא<input type="text" name="topic" value="${v(base.topic)}" maxlength="200" placeholder="למשל: דיני עבודה ומס הכנסה"></label>
      <label class="field" data-f="date"><span id="fDateLabel">תאריך</span><input type="date" name="date" value="${v(base.date)}" required></label>
      <label class="field" data-f="end_date" id="fEndWrap">תאריך המפגש השני<input type="date" name="end_date" value="${v(base.end_date)}"></label>
      <label class="field" data-f="start">שעת התחלה<input type="time" name="start" value="${v(base.start_time)}" required></label>
      <label class="field" data-f="end">שעת סיום<input type="time" name="end" value="${v(base.end_time)}" required></label>
      <label class="field full" data-f="location">מקום<input type="text" name="location" value="${v(base.location)}" maxlength="200"></label>
      <label class="field" data-f="price_ils">מחיר למשתתף (₪)<input type="number" name="price_ils" value="${v(base.price_ils)}" min="1" step="0.5" required>
        <span class="small faint" id="fVat"></span></label>
      <label class="field" data-f="academic_hours">שעות אקדמיות<input type="number" name="academic_hours" value="${v(base.academic_hours)}" min="0.5" step="0.5"></label>
      <label class="switch full"><input type="checkbox" name="vat_included" ${base.vat_included ? "checked" : ""}> המחיר כולל מע"מ</label>
      <label class="field full" data-f="lecturers">מרצים (מרצה בכל שורה)<textarea name="lecturers" rows="3">${v((base.lecturers ?? []).join("\n"))}</textarea></label>
      <label class="field" data-f="course_number">מספר קורס (לגולד)<input type="text" name="course_number" value="${v(base.course_number)}" maxlength="40" class="ltr"></label>
      <label class="field" data-f="purchase_url">קישור לרכישה<input type="url" name="purchase_url" value="${v(base.purchase_url)}" placeholder="https://…" class="ltr"></label>
      <label class="field full" data-f="series">אותו תוכן כמו (לשאלה "יש מועד אחר?")
        <select name="series"><option value="">— יום עיון בפני עצמו —</option>${seriesOptions}</select></label>
      <label class="field full" data-f="description">סדר יום / פרטים נוספים (הבוט יכול לספר על זה)<textarea name="description" rows="4" maxlength="5000">${v(base.description)}</textarea></label>
      <label class="switch full"><input type="checkbox" name="open_for_registration" ${base.open_for_registration ? "checked" : ""}> ההרשמה פתוחה (הבוט שולח קישור)</label>
      <div class="full small" id="fError" style="color:var(--danger)" hidden></div>
      <div class="row full" style="margin-top:6px">
        <button class="btn primary" type="submit" id="fSave">${editing ? "שמירה" : "הוספה"}</button>
        <button class="btn ghost" type="button" id="fCancel">ביטול</button>
      </div>
    </form>`;
  const form = dr.body.querySelector("#sdForm");
  let format = base.format;
  const field = (n) => form.elements.namedItem(n);
  const syncFormat = (changed) => {
    form.querySelectorAll("#fFormat button").forEach((b) => b.classList.toggle("on", b.dataset.v === format));
    form.querySelector("#fEndWrap").hidden = format !== "zoom";
    form.querySelector("#fDateLabel").textContent = format === "zoom" ? "תאריך המפגש הראשון" : "תאריך";
    if (changed) {
      // a new format: its usual hours, place and price (still editable)
      const def = DEFAULTS[format];
      field("start").value = def.start_time;
      field("end").value = def.end_time;
      field("location").value = def.location;
      field("price_ils").value = def.price_ils;
      if (format === "hotel") field("end_date").value = "";
    }
    syncVat();
  };
  const syncVat = () => {
    const p = Number(field("price_ils").value);
    form.querySelector("#fVat").textContent = p > 0 && field("vat_included").checked ? `${money(beforeVat(p))} לפני מע"מ` : "";
  };
  form.querySelector("#fFormat").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b || b.dataset.v === format) return;
    format = b.dataset.v;
    syncFormat(true);
  });
  field("price_ils").addEventListener("input", syncVat);
  field("vat_included").addEventListener("change", syncVat);
  // the second meeting is usually the next day
  field("date").addEventListener("change", () => {
    if (format !== "zoom" || field("end_date").value || !field("date").value) return;
    const t = new Date(`${field("date").value}T12:00:00Z`);
    t.setUTCDate(t.getUTCDate() + 1);
    field("end_date").value = t.toISOString().slice(0, 10);
  });
  syncFormat(false);
  dr.body.querySelector("#fCancel").onclick = () => (editing || duplicate ? openDay(d.raw.id, reload) : dr.close());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const txt = (n) => field(n).value.trim();
    const num = (n) => (txt(n) === "" ? undefined : Number(txt(n)));
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
      vat_included: field("vat_included").checked,
      open_for_registration: field("open_for_registration").checked,
      ...(txt("course_number") ? { course_number: txt("course_number") } : {}),
      ...(txt("purchase_url") ? { purchase_url: txt("purchase_url") } : {}),
      lecturers: field("lecturers").value.split("\n").map((s) => s.trim()).filter(Boolean),
      ...(num("academic_hours") !== undefined ? { academic_hours: num("academic_hours") } : {}),
      description: field("description").value.trim(),
    };
    const err = form.querySelector("#fError");
    form.querySelectorAll(".field.bad").forEach((x) => x.classList.remove("bad"));
    err.hidden = true;
    const save = form.querySelector("#fSave");
    save.disabled = true;
    try {
      const path = editing ? `/api/admin/study-days/${encodeURIComponent(d.raw.id)}` : "/api/admin/study-days";
      const res = await post(path, body);
      toast(res.warning_he ?? (editing ? "נשמר – הבוט כבר רואה את השינוי" : "נוסף – הבוט כבר מציע אותו"), res.warning_he ? "" : "ok");
      await reload();
      openDay(res.day.raw.id, reload);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      // the server names the bad fields in message_he; mark them too
      const named = ex.message.startsWith("לא תקין: ") ? ex.message.slice("לא תקין: ".length).split(", ") : [];
      for (const [f, label] of Object.entries(FIELD_LABELS)) if (named.includes(label)) form.querySelector(`[data-f="${f}"]`)?.classList.add("bad");
      save.disabled = false;
    }
  });
}

/** Same labels as the server's message (routes/study-days.ts FIELD_HE), to mark the fields it names. */
const FIELD_LABELS = {
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
