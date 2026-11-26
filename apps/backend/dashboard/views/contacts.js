// לקוחות: three views - the bot's activity (the call in progress first), the dialer's next ones, and all contacts
// (searched and paged by the server); they re-read when the server says a contact changed (live.js). A contact
// opens with its Gold fields, the bot's state, its calls and its rep tasks, and a test-dial button.
import { isAdmin, get, post } from "../api.js";
import {
  chip, CONTACT_STATUS_HE, confirmDialog, emptyState, errorState, esc, every, fmtDateTime, fmtRel, GENDER_HE, GOLD_FIELDS, icon,
  loadingState, notesHtml, openDrawer, originChip, outcomeChip, outcomeLabel, pager, PHONE_COL, phoneLink, REP_REASON_HE, statusChip,
  toast, fmtDuration,
} from "../ui.js";
import { onContactsChanged } from "../live.js";
import { openCall } from "./calls.js";

let stopPoll = null;

const nextCall = (b) => b?.callback_at ?? b?.next_call_at ?? null;

// The three views (GET /api/admin/contacts?view=): what the bot does now and did last, who it calls next (the
// dialer's order and courses), and everyone - searched and paged by the server (5,000+ contacts).
const VIEWS = [
  ["activity", "פעילות הבוט"],
  ["queue", "הבאים בתור"],
  ["all", "כל הלקוחות"],
];
const EMPTY = {
  activity: ["הבוט עוד לא התקשר לאף אחד", "כשהחיוג האוטומטי יתחיל, מי שבשיחה יופיע כאן למעלה, ואחריו מי שהבוט התקשר אליו לאחרונה."],
  queue: ["אין אף אחד בתור", "אין לקוחות חדשים, בהמתנה או לשיחה חוזרת בקורסים שהחייגן מתקשר אליהם."],
  all: ["אין לקוחות שמתאימים לחיפוש", ""],
};
const VIEW_KEY = "mishlav_contacts_view";

function rows(list, view) {
  if (!list.length) return emptyState(...EMPTY[view], view === "all" ? "search" : "users");
  const queue = view === "queue";
  return `<div class="table-wrap"><table class="data"><thead><tr>
      ${queue ? "<th>#</th>" : ""}<th>שם</th><th>סטטוס בגולד</th><th>מצב הבוט</th><th>ניסיונות</th><th>שיחה אחרונה</th><th>החיוג הבא</th>
    </tr></thead><tbody>${list
      .map((c, i) => {
        const b = c.bot_state ?? {};
        const next = nextCall(b);
        const open = (c.rep_tasks ?? []).filter((t) => !t.done).length;
        const nextCell = next
          ? `<div>${esc(fmtDateTime(next))}</div><div class="cell-sub">${esc(fmtRel(next))}${b.callback_at ? " · ביקש" : ""}</div>`
          : queue && c.due ? `<span>עכשיו בתור</span>` : `<span class="faint">—</span>`;
        return `<tr class="click" data-id="${esc(c.gold_record_id)}">
          ${queue ? `<td class="num faint">${i + 1}</td>` : ""}
          <td><div class="cell-main">${esc(c.full_name ?? "—")}</div><div class="cell-sub ltr">${esc(c.phone ?? "")}</div></td>
          <td>${c.status ? esc(c.status) : `<span class="faint">—</span>`}</td>
          <td>${statusChip(b.bot_status ?? "new")}${open ? ` ${chip(`${open} לנציג`, "warning")}` : ""}</td>
          <td class="num nowrap">${b.attempts ?? 0}${b.no_answer_streak ? ` <span class="cell-sub">· ${b.no_answer_streak} ברצף</span>` : ""}</td>
          <td class="nowrap">${b.last_call_at ? `<div>${esc(fmtDateTime(b.last_call_at))}</div><div class="cell-sub">${esc(b.last_outcome ? outcomeLabel(b.last_outcome) : "")}</div>` : `<span class="faint">—</span>`}</td>
          <td class="nowrap">${nextCell}</td>
        </tr>`;
      })
      .join("")}</tbody></table></div>`;
}

export default {
  id: "contacts",
  title: "לקוחות",
  icon: "users",
  mount(root) {
    let view = "activity";
    try { view = VIEWS.some(([v]) => v === sessionStorage.getItem(VIEW_KEY)) ? sessionStorage.getItem(VIEW_KEY) : "activity"; } catch {}
    let page = 1;
    let seq = 0; // the latest request: an older answer that arrives after it is dropped
    root.innerHTML = `
      <div class="toolbar">
        <div class="seg" id="cView">${VIEWS.map(([v, l]) => `<button data-v="${v}">${esc(l)}</button>`).join("")}</div>
        <label class="search" id="cSearchWrap">${icon("search")}<input type="search" id="cSearch" placeholder="חיפוש לפי שם, טלפון, קורס, עיר…"></label>
        <select id="cStatus"><option value="">כל המצבים</option>${Object.entries(CONTACT_STATUS_HE).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select>
        <span class="muted small" id="cCount"></span>
      </div>
      <div class="card"><div id="cBody">${loadingState(8)}</div><div id="cPager"></div></div>`;
    const $ = (id) => root.querySelector(`#${id}`);
    const body = $("cBody");
    const pages = pager($("cPager"), (p) => { page = p; load(); });
    const showControls = () => {
      root.querySelectorAll("#cView button").forEach((b) => b.classList.toggle("on", b.dataset.v === view));
      const all = view === "all";
      $("cSearchWrap").hidden = !all;
      $("cStatus").hidden = !all;
      if (!all) pages.set(1, 1);
    };
    const load = async () => {
      const mine = ++seq;
      const params = new URLSearchParams({ view });
      if (view === "all") {
        const q = $("cSearch").value.trim();
        if (q) params.set("q", q);
        if ($("cStatus").value) params.set("status", $("cStatus").value);
        params.set("page", String(page));
      }
      try {
        const r = await get(`/api/admin/contacts?${params}`);
        if (mine !== seq) return;
        if (!r.available) { body.innerHTML = emptyState("Supabase לא מחובר", "חסרים SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY בשרת הזה."); return; }
        body.innerHTML = rows(r.contacts, view);
        if (view === "all") {
          page = r.page;
          $("cCount").textContent = `${r.total.toLocaleString("he-IL")} לקוחות`;
          pages.set(r.page, r.pages);
        } else {
          $("cCount").textContent = view === "queue" ? `${r.total} הבאים לפי סדר החיוג` : `${r.total} אחרונים · מתעדכן מעצמו`;
        }
      } catch (e) { if (mine === seq) body.innerHTML = errorState(e.message); }
    };
    const reload = () => { body.innerHTML = loadingState(8); load(); };
    $("cView").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-v]");
      if (!b || b.dataset.v === view) return;
      view = b.dataset.v;
      page = 1;
      try { sessionStorage.setItem(VIEW_KEY, view); } catch {}
      showControls();
      reload();
    });
    let typing = null;
    $("cSearch").addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(() => { page = 1; load(); }, 300); });
    $("cStatus").addEventListener("change", () => { page = 1; load(); });
    body.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-id]");
      if (tr) openContact(tr.dataset.id);
    });
    showControls();
    // read once, then only when the server says a contact changed (a call, the bot, the dialer) - no polling.
    // A lost push channel reconnects by itself and re-reads then (live.js).
    load();
    const offPush = onContactsChanged(load);
    stopPoll = () => { offPush(); clearTimeout(typing); };
  },
  unmount() { stopPoll?.(); },
};

/** The contact drawer (also opened from the overview, calls and rep tasks). */
export async function openContact(id) {
  const d = openDrawer({ title: "לקוח", sub: `<span class="ltr">${esc(id)}</span>` });
  const load = async () => {
    let r;
    try { r = await get(`/api/admin/contacts/${encodeURIComponent(id)}`); } catch (e) { d.body.innerHTML = errorState(e.message); return; }
    const c = r.contact;
    const b = c.bot_state ?? {};
    const pi = b.phone_index ?? 1;
    const dialing = c[PHONE_COL[pi - 1]];
    const dnc = b.bot_status === "do_not_call";
    d.setTitle(`${esc(c.full_name ?? id)} ${statusChip(b.bot_status ?? "new")}`);
    d.setSub(`<span class="ltr">${esc(id)}</span>${c.status ? ` · בגולד: ${esc(c.status)}` : ""}`);
    const kv = (pairs) => `<dl class="kv">${pairs.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
    const tasks = c.rep_tasks ?? [];
    // calling a customer from here is ours: Mishlav's users test with a call to themselves (שיחת בדיקה אליי)
    d.body.innerHTML = `
      <div class="row" style="margin-bottom:18px" ${isAdmin() ? "" : "hidden"}>
        <button class="btn primary" id="cDial" ${dnc || !dialing ? "disabled" : ""}>${icon("phone")} חייג עכשיו (בדיקה)</button>
        <span class="small muted">${dnc ? "ביקש לא להתקשר – אי אפשר לחייג" : dialing ? `מחייג ל-${pi === 1 ? "טלפון" : `טלפון ${pi}`} <span class="ltr">${esc(dialing)}</span>` : "אין מספר תקין"}</span>
      </div>
      <div class="section-title">אצל הבוט (גולד לא רואה)</div>
      ${kv([
        ["מצב", statusChip(b.bot_status ?? "new")],
        ["ניסיונות", `${b.attempts ?? 0}${b.no_answer_streak ? ` · ${b.no_answer_streak} ברצף בלי מענה` : ""}`],
        ["ענה בעבר", b.ever_answered ? "כן" : "לא"],
        ["שיחה אחרונה", b.last_call_at ? esc(fmtDateTime(b.last_call_at)) : null],
        ["תוצאה אחרונה", b.last_outcome ? esc(outcomeLabel(b.last_outcome)) : null],
        ["שיחה חוזרת", b.callback_at ? esc(fmtDateTime(b.callback_at)) : null],
        ["החיוג הבא", b.next_call_at ? `${esc(fmtDateTime(b.next_call_at))} <span class="faint">(${esc(fmtRel(b.next_call_at))})</span>` : null],
        ["יום עיון", b.interested_day_id ? `<span class="ltr">${esc(b.interested_day_id)}</span>` : null],
        ["מגדר (לבוט)", b.customer_gender ? esc(GENDER_HE[b.customer_gender]) : "ייקבע לפי השם"],
        ["עודכן לגולד", b.gold_changed_at ? esc(fmtDateTime(b.gold_changed_at)) : null],
      ])}
      <div class="section-title">משימות לנציג</div>
      ${tasks.length ? `<ul class="list card">${tasks.map((t) => `<li><div class="grow"><b>${esc(REP_REASON_HE[t.reason] ?? t.reason)}</b> <span class="small muted">· לחזור ${t.callback_at ? esc(fmtDateTime(t.callback_at)) : "בהקדם"}</span>${t.note ? `<div class="small muted">${esc(t.note)}</div>` : ""}</div>${t.done ? chip("טופל", "success") : chip("פתוחה", "warning")}</li>`).join("")}</ul>` : `<p class="small faint">אין משימות</p>`}
      <div class="section-title">שיחות (${r.calls.length})</div>
      ${r.calls.length ? `<ul class="list card">${r.calls.map((k) => `<li class="click" data-call="${esc(k.call_id)}"><div class="grow"><div>${esc(fmtDateTime(k.started_at))} <span class="small faint num">· ${fmtDuration(k.duration_sec)}</span></div></div>${outcomeChip(k.outcome)} ${originChip(k.origin)}</li>`).join("")}</ul>` : `<p class="small faint">עוד לא התקשרו</p>`}
      <div class="section-title">בגולד</div>
      ${kv(GOLD_FIELDS.map(([k, label]) => [label, k === "notes" ? notesHtml(c.notes) : k.startsWith("phone") ? (c[k] ? phoneLink(c[k]) : null) : c[k] ? esc(c[k]) : null]))}`;
    d.body.querySelectorAll("[data-call]").forEach((li) => (li.onclick = () => openCall(li.dataset.call)));
    d.body.querySelector("#cDial").onclick = async () => {
      const ok = await confirmDialog({
        title: `להתקשר עכשיו ל${c.full_name ?? "לקוח"}?`,
        text: `הבוט יחייג ל-<span class="ltr">${esc(dialing)}</span>. זו שיחת בדיקה (מסומנת 🧪), אבל היא מעדכנת את הרשומה ואת גולד כמו שיחה אמיתית.`,
        okLabel: "חייג",
      });
      if (!ok.ok) return;
      try {
        const res = await post("/test/phone/call", { contact_id: id });
        toast("מחייג…", "ok");
        openCall(res.call_id);
      } catch (e) { toast(e.message, "bad"); }
    };
  };
  await load();
}
