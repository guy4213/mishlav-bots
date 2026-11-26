// Shared UI: Hebrew labels, status colours, formatting (Asia/Jerusalem), icons, chips, states, drawer, modal, toasts.

export const TZ = "Asia/Jerusalem";

// ------------------------------------------------------------------ labels (Hebrew)
export const CONTACT_STATUS_HE = {
  new: "חדש", queued: "בתור", in_call: "בשיחה", link_sent: "נשלח קישור", callback: "שיחה חוזרת", hot_lead: "ליד חם לנציג",
  company: "דרך החברה", human_followup: "שאלה לנציג", not_interested: "לא מעוניין", already_registered: "כבר רשום",
  do_not_call: "לא להתקשר", wrong_number: "מספר שגוי", voicemail: "תא קולי", no_answer: "לא ענה",
  closed_max_attempts: "נסגר – מקסימום ניסיונות", duplicate: "כפול",
};
export const OUTCOME_HE = {
  LINK_SENT: "נשלח קישור", CALLBACK: "שיחה חוזרת", HOT_LEAD: "ליד חם לנציג", DO_NOT_CALL: "הסרה מהרשימה", VOICEMAIL: "תא קולי",
  HUMAN_FOLLOWUP: "מעקב נציג", NOT_INTERESTED: "לא מעוניין", COMPANY: "רכישת חברה", ALREADY_REGISTERED: "כבר רשום",
  WRONG_NUMBER: "מספר שגוי", UNKNOWN: "לא זוהתה תוצאה", NO_RESULT: "בלי תוצאה", NO_PHONE: "אין מספר תקין", DUPLICATE: "כפול", COMPLETED: "הסתיים",
};
export const REP_REASON_HE = {
  wants_human: "רוצה נציג", pay_via_rep: "תשלום דרך נציג", company_purchase: "רכישה דרך החברה", discount_request: "בקשת הנחה",
  course_interest: "מתעניין בקורס", other: "שאלה פתוחה", unreachable: "ביקש שנחזור ולא השגנו",
};
export const GENDER_HE = { male: "גבר", female: "אישה", unknown: "לא ידוע" };
export const TOOL_HE = {
  get_day_info: "בדק פרטי יום עיון", send_purchase_link: "שלח קישור לרכישה", schedule_callback: "קבע שיחה חוזרת",
  request_human: "העביר לנציג", end_call: "סיים את השיחה",
};
export const REASON_HE = {
  completed: "הסתיים", not_interested: "לא מעוניין", do_not_call: "הסרה מהרשימה", voicemail: "תא קולי", already_registered: "כבר רשום",
  wrong_number: "מספר שגוי", wants_human: "רוצה נציג", pay_via_rep: "תשלום דרך נציג", company_purchase: "רכישה דרך החברה",
  discount_request: "בקשת הנחה", course_interest: "מתעניין בקורס", other: "אחר",
};
export const DIALER_STATE_HE = {
  running: "פעיל", stopped: "כבוי", outside_hours: "מחוץ לשעות הפעילות", queue_empty: "התור ריק", in_call: "בשיחה", error: "תקלה",
  daily_limit: "הגיע למגבלה היומית",
};
export const ORIGIN_HE = { dialer: "אוטומטי", manual: "🧪 בדיקה" };
export const TRI_HE = { PASS: "עבר", FAIL: "נכשל", PENDING: "ממתין לבדיקה ידנית", NONE: "עוד לא נבדק" };
// Gold's 16 columns (the export's Hebrew headers)
export const GOLD_FIELDS = [
  ["gold_record_id", "מזהה רשומה"], ["full_name", "שם מלא"], ["national_id", "ת.ז"], ["phone", "טלפון"], ["phone2", "טלפון 2"],
  ["phone3", "טלפון 3"], ["email", "אימייל"], ["company", "חברה"], ["city", "עיר"], ["address", "כתובת"], ["address2", "כתובת 2"],
  ["department", "מחלקה"], ["requested_course", "קורס מבוקש"], ["source", "מקור"], ["status", "סטטוס"], ["notes", "הערות"],
];
export const PHONE_COL = ["phone", "phone2", "phone3"];

// ------------------------------------------------------------------ status colours (one tone per status / outcome)
const STATUS_TONE = {
  new: "info", queued: "info", callback: "violet", in_call: "live", link_sent: "success", hot_lead: "warning", company: "teal",
  human_followup: "warning", not_interested: "muted", already_registered: "success", do_not_call: "danger", wrong_number: "danger",
  voicemail: "muted", no_answer: "muted", closed_max_attempts: "muted", duplicate: "muted",
};
const OUTCOME_TONE = {
  LINK_SENT: "success", CALLBACK: "violet", HOT_LEAD: "warning", COMPANY: "teal", HUMAN_FOLLOWUP: "warning", NOT_INTERESTED: "muted",
  DO_NOT_CALL: "danger", ALREADY_REGISTERED: "success", WRONG_NUMBER: "danger", VOICEMAIL: "muted", NO_RESULT: "muted",
  NO_PHONE: "danger", UNKNOWN: "muted",
};
export const TONE_VAR = { info: "--info", violet: "--violet", teal: "--teal", success: "--success", warning: "--warning", danger: "--danger", muted: "--muted", live: "--live" };

// ------------------------------------------------------------------ html helpers
export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const h = (html) => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

export const chip = (label, tone = "muted", { dot = false, cls = "" } = {}) =>
  `<span class="chip t-${tone}${dot ? " dot" : ""}${cls ? ` ${cls}` : ""}">${esc(label)}</span>`;
export const statusChip = (s) => chip(CONTACT_STATUS_HE[s] ?? s ?? "—", STATUS_TONE[s] ?? "muted", { dot: true, cls: s === "in_call" ? "pulse" : "" });
export const outcomeLabel = (o) => (Array.isArray(o) ? o.map((x) => OUTCOME_HE[x] ?? x).join(" / ") : (OUTCOME_HE[o ?? "NO_RESULT"] ?? o));
export const outcomeChip = (o) => chip(outcomeLabel(o), OUTCOME_TONE[o ?? "NO_RESULT"] ?? "muted");
export const originChip = (o) => chip(ORIGIN_HE[o] ?? o ?? "—", o === "dialer" ? "info" : "outline");
/** +972534271418 / 0534271418 -> 053-4271418 (as written in Israel); anything else as it is */
export const fmtPhone = (n) => {
  const d = String(n ?? "").replace(/\D/g, "");
  const local = d.startsWith("972") ? `0${d.slice(3)}` : d;
  return /^0\d{8,9}$/.test(local) ? `${local.slice(0, -7)}-${local.slice(-7)}` : String(n ?? "");
};
/** Who a call was with: the contact, else the name the test call gave the bot (an incoming call: who called). */
export const callName = (c) => c?.full_name ?? c?.contact_name ?? (c?.direction === "in" ? "שיחה נכנסת" : "שיחת בדיקה");
/** Where a call came from: the dialer, a dashboard test, or someone calling the line. */
export const callOriginChip = (c) => (c?.direction === "in" ? chip("📞 נכנסת", "outline") : originChip(c?.origin));
export const statusTone = (s) => STATUS_TONE[s] ?? "muted";

// ------------------------------------------------------------------ formatting (always Israel time)
const fmt = (opts) => new Intl.DateTimeFormat("he-IL", { timeZone: TZ, ...opts });
const F_DT = fmt({ weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
const F_DATE = fmt({ day: "numeric", month: "numeric", year: "numeric" });
const F_TIME = fmt({ hour: "2-digit", minute: "2-digit", hour12: false });
const F_TIMES = fmt({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const REL = new Intl.RelativeTimeFormat("he", { numeric: "auto" });
const valid = (iso) => iso && !Number.isNaN(new Date(iso).getTime());

export const fmtDateTime = (iso) => (valid(iso) ? F_DT.format(new Date(iso)) : "—");
export const fmtDate = (iso) => (valid(iso) ? F_DATE.format(new Date(iso)) : "—");
export const fmtTime = (iso) => (valid(iso) ? F_TIME.format(new Date(iso)) : "—");
export const fmtTimeSec = (iso) => (valid(iso) ? F_TIMES.format(new Date(iso)) : "");
export function fmtRel(iso, now = Date.now()) {
  if (!valid(iso)) return "";
  const s = (new Date(iso).getTime() - now) / 1000;
  const a = Math.abs(s);
  if (a < 45) return "עכשיו";
  if (a < 3600) return REL.format(Math.round(s / 60), "minute");
  if (a < 86400) return REL.format(Math.round(s / 3600), "hour");
  return REL.format(Math.round(s / 86400), "day");
}
/** Gemini cost of a call: "$0.124 · $0.062/דקה" (per minute when the duration is known), or — */
export function fmtCost(usd, sec) {
  if (usd === null || usd === undefined || Number.isNaN(Number(usd))) return "—";
  const v = Number(usd);
  const perMin = sec > 0 ? ` · $${((v / sec) * 60).toFixed(3)}/דקה` : "";
  return `$${v.toFixed(3)}${perMin}`;
}
export function fmtDuration(sec) {
  if (sec === null || sec === undefined || Number.isNaN(Number(sec))) return "—";
  const s = Math.max(0, Math.round(Number(sec)));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
/** A phone as written, left-to-right, with a tel: link. */
export const phoneLink = (p) => (p ? `<a class="ltr num" href="tel:${esc(String(p).replace(/[^\d+]/g, ""))}">${esc(p)}</a>` : "—");
/** Gold notes: the bot's "[הערת הבוט]" (older: "[BOT]") lines highlighted. */
export const notesHtml = (t) =>
  t
    ? `<div class="notes">${String(t)
        .split(/\r?\n/)
        .map((l) => (/^\s*\[(הערת הבוט|BOT)\]/.test(l) ? `<span class="botnote">${esc(l)}</span>` : esc(l)))
        .join("\n")}</div>`
    : `<span class="faint">—</span>`;

// ------------------------------------------------------------------ icons (inline SVG, stroke)
const P = {
  overview: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  tasks: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
  flask: '<path d="M9 3h6"/><path d="M10 3v6.5L4.6 18.4A2 2 0 0 0 6.3 21.5h11.4a2 2 0 0 0 1.7-3.1L14 9.5V3"/><path d="M7.5 15h9"/>',
  chart: '<path d="M3 3v18h18"/><path d="M8 17v-5"/><path d="M13 17V8"/><path d="M18 17v-3"/>',
  logs: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  gold: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  menu: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  play: '<polygon points="7 4 20 12 7 20 7 4"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
};
export const icon = (name, cls = "") => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] ?? ""}</svg>`;

// ------------------------------------------------------------------ states
export const loadingState = (rows = 4) =>
  `<div class="card-body stack" aria-busy="true">${Array.from({ length: rows }, (_, i) => `<span class="skeleton" style="width:${90 - i * 12}%"></span>`).join("")}</div>`;
export const emptyState = (title, text = "", ic = "inbox", compact = false) =>
  `<div class="state${compact ? " compact" : ""}"><div class="state-icon">${icon(ic)}</div><div class="state-title">${esc(title)}</div>${text ? `<div class="state-text">${text}</div>` : ""}</div>`;
export const errorState = (msg, compact = false) =>
  `<div class="state error${compact ? " compact" : ""}"><div class="state-icon">${icon("alert")}</div><div class="state-title">לא הצלחתי לטעון</div><div class="state-text">${esc(msg)}</div></div>`;

// ------------------------------------------------------------------ toasts
export function toast(text, tone = "") {
  const el = h(`<div class="toast ${tone}">${esc(text)}</div>`);
  $("toasts").append(el);
  setTimeout(() => el.remove(), 3800);
}

// ------------------------------------------------------------------ modal: confirm, with an optional text input
export function confirmDialog({ title, text = "", input = null, okLabel = "אישור", danger = false }) {
  const dlg = $("modal");
  $("modalTitle").textContent = title;
  $("modalText").innerHTML = text;
  $("modalText").hidden = !text;
  $("modalField").hidden = !input;
  $("modalLabel").textContent = input?.label ?? "";
  $("modalInput").value = "";
  $("modalInput").placeholder = input?.placeholder ?? "";
  $("modalOk").textContent = okLabel;
  $("modalOk").className = `btn ${danger ? "danger" : "primary"}`;
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve({ ok: dlg.returnValue === "ok", value: $("modalInput").value.trim() }), { once: true });
    dlg.returnValue = "";
    dlg.showModal();
    (input ? $("modalInput") : $("modalOk")).focus();
  });
}

// ------------------------------------------------------------------ drawer: one at a time; its timers die with it
let drawerClose = null;
export function openDrawer({ title = "", sub = "", onClose = null } = {}) {
  closeDrawer();
  const d = $("drawer");
  $("drawerTitle").innerHTML = title;
  $("drawerSub").innerHTML = sub;
  $("drawerBody").innerHTML = loadingState(6);
  $("drawerScrim").hidden = false;
  d.classList.add("open");
  d.setAttribute("aria-hidden", "false");
  $("drawerBody").scrollTop = 0;
  const handle = {
    body: $("drawerBody"),
    setTitle: (html) => ($("drawerTitle").innerHTML = html),
    setSub: (html) => ($("drawerSub").innerHTML = html),
    isOpen: () => drawerClose === close,
    close: () => closeDrawer(),
  };
  function close() {
    d.classList.remove("open");
    d.setAttribute("aria-hidden", "true");
    $("drawerScrim").hidden = true;
    onClose?.();
  }
  drawerClose = close;
  return handle;
}
export function closeDrawer() {
  const c = drawerClose;
  drawerClose = null;
  c?.();
}

/**
 * The pager under every long list (contacts, calls, rep tasks, Gold): "הקודם · עמוד 2 מתוך 9 · הבא". The server
 * pages (each list answers { page, pages }); `onGo(page)` loads that page. Hidden while there is one page only.
 * Returns { set(page, pages) } to call after each load.
 */
export function pager(el, onGo) {
  el.classList.add("pager");
  el.hidden = true;
  el.innerHTML = `<button class="btn sm" data-p="-1">הקודם</button><span class="small muted num"></span><button class="btn sm" data-p="1">הבא</button>`;
  let cur = 1;
  let last = 1;
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-p]");
    if (!b) return;
    const p = cur + Number(b.dataset.p);
    if (p >= 1 && p <= last) onGo(p);
  });
  return {
    set(page, pages) {
      cur = page;
      last = Math.max(1, pages);
      el.hidden = last <= 1;
      el.querySelector("span").textContent = `עמוד ${cur} מתוך ${last}`;
      el.querySelector('[data-p="-1"]').disabled = cur <= 1;
      el.querySelector('[data-p="1"]').disabled = cur >= last;
    },
  };
}

/**
 * setInterval that also runs now, and stops itself when `alive()` turns false. Returns a stop function.
 * A tab in the background skips its ticks and runs one as soon as it is in front again: seven people with the
 * dashboard open somewhere don't read the database all day (Supabase's free plan).
 */
export function every(ms, fn, alive = () => true) {
  let t = null;
  let missed = false;
  const tick = async () => {
    if (!alive()) return stop();
    if (document.hidden) { missed = true; return; }
    missed = false;
    try { await fn(); } catch { /* shown by fn; try again next time */ }
  };
  const onVisible = () => { if (!document.hidden && missed) tick(); };
  const stop = () => { clearInterval(t); t = null; document.removeEventListener("visibilitychange", onVisible); };
  t = setInterval(tick, ms);
  document.addEventListener("visibilitychange", onVisible);
  tick();
  return stop;
}

// ------------------------------------------------------------------ the conversation: bubbles + the bot's actions
export function toolText(c) {
  const p = c.params && typeof c.params === "object" ? c.params : {};
  const bits = Object.entries(p).map(([k, v]) => `${esc(k)}: <b>${esc(REASON_HE[v] ?? v)}</b>`).join(" · ");
  const res = c.response?.scheduled_time_he
    ? ` ← ${esc(c.response.scheduled_time_he)}`
    : c.ok
      ? ""
      : ` ← שגיאה: ${esc(c.error ?? c.response?.error ?? "")}`;
  return { title: esc(TOOL_HE[c.tool] ?? c.tool), detail: `${bits}${res}` };
}
export function toolItem(c) {
  const t = toolText(c);
  return `<li><span class="tick ${c.ok ? "ok" : "bad"}">${c.ok ? "✓" : "✗"}</span><div><b>${t.title}</b> <span class="small muted">${t.detail}</span><div class="small faint">${esc(fmtTimeSec(c.ts))}</div></div></li>`;
}
/** Transcript lines and tool actions in one timeline, by time. */
export function conversationHtml(lines, tools = [], { customer = "לקוח" } = {}) {
  const items = [
    ...lines.map((l) => ({ ts: l.ts, kind: "say", l })),
    ...tools.map((c) => ({ ts: c.ts, kind: "tool", c })),
  ].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  if (!items.length) return "";
  return items
    .map((it) => {
      if (it.kind === "tool") {
        const t = toolText(it.c);
        return `<div class="action${it.c.ok ? "" : " bad"}">${it.c.ok ? "🔧" : "⚠"} <b>${t.title}</b> ${t.detail ? `<span>${t.detail}</span>` : ""}</div>`;
      }
      const user = it.l.role === "user";
      return `<div class="bubble ${user ? "user" : "bot"}"><span class="who">${user ? customer : "הבוט"}<span class="ts">${esc(fmtTimeSec(it.l.ts))}</span></span>${esc(it.l.text)}</div>`;
    })
    .join("");
}
/** Re-render a scrolling box, staying at the bottom if the reader was there. */
export function setFollowing(box, html) {
  const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  box.innerHTML = html;
  if (atEnd) box.scrollTop = box.scrollHeight;
}

export const ls = {
  get: (k, d = null) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
