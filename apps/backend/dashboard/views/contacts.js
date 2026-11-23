// לקוחות: the contacts table (search + filter); a contact opens with its Gold fields, the bot's state, its calls
// and its rep tasks, and a test-dial button.
import { isAdmin, get, post } from "../api.js";
import {
  chip, CONTACT_STATUS_HE, confirmDialog, emptyState, errorState, esc, every, fmtDateTime, fmtRel, GENDER_HE, GOLD_FIELDS, icon,
  loadingState, notesHtml, openDrawer, originChip, outcomeChip, outcomeLabel, PHONE_COL, phoneLink, REP_REASON_HE, statusChip,
  toast, fmtDuration,
} from "../ui.js";
import { openCall } from "./calls.js";

let stopPoll = null;

const nextCall = (b) => b?.callback_at ?? b?.next_call_at ?? null;
const matches = (c, q) =>
  !q || [c.full_name, c.phone, c.phone2, c.phone3, c.gold_record_id, c.requested_course, c.city, c.email].some((v) => String(v ?? "").toLowerCase().includes(q));

function rows(list) {
  if (!list.length) return emptyState("אין לקוחות שמתאימים לחיפוש", "", "search");
  return `<div class="table-wrap"><table class="data"><thead><tr>
      <th>שם</th><th>סטטוס בגולד</th><th>מצב הבוט</th><th>ניסיונות</th><th>שיחה אחרונה</th><th>החיוג הבא</th>
    </tr></thead><tbody>${list
      .map((c) => {
        const b = c.bot_state ?? {};
        const next = nextCall(b);
        const open = (c.rep_tasks ?? []).filter((t) => !t.done).length;
        return `<tr class="click" data-id="${esc(c.gold_record_id)}">
          <td><div class="cell-main">${esc(c.full_name ?? "—")}</div><div class="cell-sub ltr">${esc(c.phone ?? "")}</div></td>
          <td>${c.status ? esc(c.status) : `<span class="faint">—</span>`}</td>
          <td>${statusChip(b.bot_status ?? "new")}${open ? ` ${chip(`${open} לנציג`, "warning")}` : ""}</td>
          <td class="num nowrap">${b.attempts ?? 0}${b.no_answer_streak ? ` <span class="cell-sub">· ${b.no_answer_streak} ברצף</span>` : ""}</td>
          <td class="nowrap">${b.last_call_at ? `<div>${esc(fmtDateTime(b.last_call_at))}</div><div class="cell-sub">${esc(b.last_outcome ? outcomeLabel(b.last_outcome) : "")}</div>` : `<span class="faint">—</span>`}</td>
          <td class="nowrap">${next ? `<div>${esc(fmtDateTime(next))}</div><div class="cell-sub">${esc(fmtRel(next))}${b.callback_at ? " · ביקש" : ""}</div>` : `<span class="faint">—</span>`}</td>
        </tr>`;
      })
      .join("")}</tbody></table></div>`;
}

export default {
  id: "contacts",
  title: "לקוחות",
  icon: "users",
  mount(root) {
    let all = [];
    root.innerHTML = `
      <div class="toolbar">
        <label class="search">${icon("search")}<input type="search" id="cSearch" placeholder="חיפוש לפי שם, טלפון, קורס, עיר…"></label>
        <select id="cStatus"><option value="">כל המצבים</option>${Object.entries(CONTACT_STATUS_HE).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select>
        <span class="muted small" id="cCount"></span>
      </div>
      <div class="card" id="cBody">${loadingState(8)}</div>`;
    const body = root.querySelector("#cBody");
    const render = () => {
      const q = root.querySelector("#cSearch").value.trim().toLowerCase();
      const st = root.querySelector("#cStatus").value;
      const list = all.filter((c) => matches(c, q) && (!st || (c.bot_state?.bot_status ?? "new") === st));
      root.querySelector("#cCount").textContent = `${list.length} מתוך ${all.length}`;
      body.innerHTML = rows(list);
    };
    const load = async () => {
      try {
        const r = await get("/api/admin/contacts");
        if (!r.available) { body.innerHTML = emptyState("Supabase לא מחובר", "חסרים SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY בשרת הזה."); return; }
        all = r.contacts;
        render();
      } catch (e) { body.innerHTML = errorState(e.message); }
    };
    root.querySelector("#cSearch").addEventListener("input", render);
    root.querySelector("#cStatus").addEventListener("change", render);
    body.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-id]");
      if (tr) openContact(tr.dataset.id);
    });
    stopPoll = every(20_000, load);
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
