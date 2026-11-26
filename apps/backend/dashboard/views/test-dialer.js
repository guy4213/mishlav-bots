// בדיקות חיוג אוטומטי (admins): the real dialer on 10 made-up TEST- contacts, all on the admin's own phone - to see
// before launch that the queue, callbacks, the notes the bot reads and writes, and the WhatsApp link really work.
// Server: apps/backend/src/test-dialer.ts (it dials only the phone of the admin who started it).
import { get, post } from "../api.js";
import { openCall } from "./calls.js";
import {
  chip, confirmDialog, DIALER_STATE_HE, emptyState, errorState, esc, every, fmtDateTime, fmtRel, loadingState, notesHtml,
  REP_REASON_HE, statusChip, toast,
} from "../ui.js";

let stop = null;

const STEPS = `<ol class="small" style="margin:0;padding-inline-start:18px;line-height:1.7">
  <li><b>אפס</b> – 10 לקוחות הדמה חוזרים להתחלה, כולם על המספר שלך, כל אחד עם הערות אחרות.</li>
  <li><b>הפעל</b> – החייגן האמיתי מתקשר אליך, לקוח אחרי לקוח, בדיוק כמו בהשקה (גם מחוץ לשעות הפעילות).</li>
  <li>בכל שיחה תגיד משהו אחר: "תחזרו אליי ב-12:00", "תשלחו קישור", "תעבירו לנציג", "לא מעוניין"…</li>
  <li>כאן רואים מה נכתב בהערות של כל לקוח, מתי השיחה הבאה ומה קרה – והשיחה החוזרת מגיעה בשעה שביקשת.</li>
</ol>`;

function statusCard(s) {
  const on = s.enabled === true;
  const stateChip = on ? chip(DIALER_STATE_HE[s.state] ?? s.state, s.state === "error" ? "danger" : "success", { dot: true }) : chip("כבוי", "muted", { dot: true });
  return `<div class="card-head"><h2>🧪 בדיקת חיוג אוטומטי</h2><span class="actions">${stateChip}</span></div>
    <div class="card-body stack">
      <div class="banner info small">החייגן של הבדיקה רואה רק את 10 לקוחות הדמה, ומחייג <b>רק למספר שלך</b>${s.allowed_number ? ` (<span class="ltr">${esc(s.allowed_number)}</span>)` : ""}. לקוח אמיתי לא יכול לקבל שיחה מהבדיקה.</div>
      <div class="row">
        <button class="btn ${on ? "danger" : "success"}" id="tdToggle">${on ? "⏹ עצור בדיקה" : "▶ הפעל בדיקה"}</button>
        <button class="btn" id="tdReset" ${on ? "disabled" : ""}>↺ אפס את לקוחות הדמה</button>
        <span class="small muted">${s.calls_today ? `${s.calls_today} שיחות בדיקה היום` : ""}</span>
      </div>
      ${s.current_call ? `<div class="banner ok small">בשיחה עכשיו: <b>${esc(s.current_call.name ?? s.current_call.gold_record_id)}</b> · <a href="#" data-call="${esc(s.current_call.call_id)}">פתח את השיחה</a></div>` : ""}
      ${s.next_due ? `<div class="small muted">הבא בתור: ${esc(s.next_due.gold_record_id)}${s.next_due.next_call_at ? ` · ${esc(fmtDateTime(s.next_due.next_call_at))} (${esc(fmtRel(s.next_due.next_call_at))})` : ""}</div>` : ""}
      ${s.last_error ? `<div class="banner bad small">${esc(s.last_error.message)}</div>` : ""}
      ${STEPS}
    </div>`;
}

function contactsTable(list) {
  if (!list.length) return emptyState("אין עדיין לקוחות דמה", "לחץ \"אפס את לקוחות הדמה\" כדי ליצור אותם.", "inbox", true);
  return `<div class="table-wrap"><table class="data"><thead><tr>
      <th>לקוח</th><th>מצב</th><th>שיחה הבאה</th><th>שיחות</th><th>משימות לנציג</th><th>הערות (מה הבוט קורא וכותב)</th>
    </tr></thead><tbody>${list
      .map((c) => {
        const st = c.bot_state ?? {};
        const next = st.bot_status === "callback" ? st.callback_at : st.next_call_at;
        const tasks = (c.rep_tasks ?? []).filter((t) => !t.done);
        return `<tr>
          <td class="nowrap"><div class="cell-main">${esc(c.full_name)}</div><div class="cell-sub ltr">${esc(c.gold_record_id)}</div></td>
          <td>${statusChip(st.bot_status)}${st.last_outcome ? `<div class="cell-sub">${esc(st.last_outcome)}</div>` : ""}</td>
          <td class="nowrap">${next ? `${esc(fmtDateTime(next))}<div class="cell-sub">${esc(fmtRel(next))}</div>` : "—"}</td>
          <td class="num">${st.attempts ?? 0}${st.last_call_at ? `<div class="cell-sub">${esc(fmtRel(st.last_call_at))}</div>` : ""}</td>
          <td>${tasks.length ? tasks.map((t) => `<div class="small">${esc(REP_REASON_HE[t.reason] ?? t.reason)}${t.note ? ` · ${esc(t.note)}` : ""}</div>`).join("") : "—"}</td>
          <td style="min-width:260px">${c.notes ? notesHtml(c.notes) : `<span class="muted small">אין</span>`}</td>
        </tr>`;
      })
      .join("")}</tbody></table></div>`;
}

export default {
  id: "test-dialer",
  title: "בדיקות חיוג אוטומטי",
  icon: "flask",
  mount(root) {
    root.innerHTML = `<div class="stack">
        <div class="card" id="tdStatus">${loadingState(3)}</div>
        <div class="card"><div class="card-head"><h2>10 לקוחות הדמה</h2><span class="sub">מתעדכן כל כמה שניות</span></div><div id="tdContacts">${loadingState(6)}</div></div>
      </div>`;
    const $r = (id) => root.querySelector(`#${id}`);
    let enabled = false;
    const load = async () => {
      try {
        const r = await get("/api/admin/test-dialer");
        enabled = r.status.enabled === true;
        $r("tdStatus").innerHTML = statusCard(r.status);
        $r("tdContacts").innerHTML = contactsTable(r.contacts);
      } catch (e) {
        $r("tdStatus").innerHTML = errorState(e.message);
      }
    };
    root.addEventListener("click", async (e) => {
      const call = e.target.closest("[data-call]");
      if (call) { e.preventDefault(); openCall(call.dataset.call); return; }
      if (e.target.closest("#tdToggle")) {
        e.target.closest("#tdToggle").disabled = true;
        try {
          await post(`/api/admin/test-dialer/${enabled ? "stop" : "start"}`);
          toast(enabled ? "הבדיקה נעצרה" : "הבדיקה התחילה – הטלפון שלך יצלצל", "ok");
        } catch (err) { toast(err.message, "bad"); }
        await load();
        return;
      }
      if (e.target.closest("#tdReset")) {
        const c = await confirmDialog({ title: "לאפס את לקוחות הדמה?", text: "10 הלקוחות יחזרו להתחלה (הערות, מצב, תור), כולם על המספר שלך. השיחות הקודמות נשארות בהיסטוריה.", okLabel: "אפס" });
        if (!c.ok) return;
        try {
          const r = await post("/api/admin/test-dialer/reset");
          toast(`אופסו ${r.reset} לקוחות דמה`, "ok");
        } catch (err) { toast(err.message, "bad"); }
        await load();
      }
    });
    stop = every(4000, load);
  },
  unmount() {
    stop?.();
  },
};
