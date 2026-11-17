// משימות לנציג: who a rep should call back, by the time they asked for (overdue highlighted), with a "done" button.
import { get, post } from "../api.js";
import { chip, emptyState, errorState, esc, every, fmtDateTime, fmtRel, loadingState, phoneLink, REP_REASON_HE, toast } from "../ui.js";
import { openContact } from "./contacts.js";

let stopPoll = null;

export default {
  id: "reps",
  title: "משימות לנציג",
  icon: "tasks",
  mount(root) {
    let showDone = false;
    root.innerHTML = `
      <div class="card">
        <div class="card-head"><h2>משימות לנציג</h2><span class="sub" id="rCount"></span>
          <div class="actions"><label class="switch"><input type="checkbox" id="rDone"> הצג גם משימות שטופלו</label></div>
        </div>
        <div id="rBody">${loadingState(5)}</div>
      </div>`;
    const body = root.querySelector("#rBody");
    const load = async () => {
      try {
        const { tasks } = await get(`/api/admin/rep-tasks?open=${showDone ? 0 : 1}`);
        const now = Date.now();
        root.querySelector("#rCount").textContent = `${tasks.filter((t) => !t.done).length} פתוחות`;
        body.innerHTML = tasks.length
          ? `<div class="table-wrap"><table class="data"><thead><tr><th>לחזור</th><th>שם</th><th>טלפון</th><th>סיבה</th><th>הערה</th><th>נוצרה</th><th></th></tr></thead><tbody>${tasks
              .map((t) => {
                const overdue = !t.done && t.callback_at && new Date(t.callback_at).getTime() < now;
                return `<tr class="${overdue ? "overdue" : ""}">
                  <td class="nowrap">${t.callback_at ? `<div class="cell-main">${esc(fmtDateTime(t.callback_at))}</div><div class="cell-sub">${overdue ? `<b style="color:var(--danger)">באיחור</b> · ` : ""}${esc(fmtRel(t.callback_at))}</div>` : chip("בהקדם", "warning")}</td>
                  <td><a href="#" data-contact="${esc(t.gold_record_id)}" class="cell-main">${esc(t.full_name ?? t.gold_record_id)}</a></td>
                  <td class="nowrap">${phoneLink(t.phone)}</td>
                  <td>${esc(REP_REASON_HE[t.reason] ?? t.reason)}</td>
                  <td class="wrap">${t.note ? esc(t.note) : `<span class="faint">—</span>`}</td>
                  <td class="nowrap cell-sub">${esc(fmtDateTime(t.created_at))}</td>
                  <td>${t.done ? chip("טופל", "success") : `<button class="btn sm success" data-done="${esc(t.id)}">טופל</button>`}</td>
                </tr>`;
              })
              .join("")}</tbody></table></div>`
          : emptyState("אין משימות פתוחות", "כשהבוט מעביר לקוח לנציג, המשימה תופיע כאן.", "tasks");
      } catch (e) { body.innerHTML = errorState(e.message); }
    };
    root.querySelector("#rDone").onchange = (e) => { showDone = e.target.checked; load(); };
    body.addEventListener("click", async (e) => {
      const a = e.target.closest("[data-contact]");
      if (a) { e.preventDefault(); openContact(a.dataset.contact); return; }
      const b = e.target.closest("[data-done]");
      if (!b) return;
      b.disabled = true;
      try { await post(`/api/admin/rep-tasks/${b.dataset.done}/done`); toast("סומן כטופל", "ok"); } catch (err) { toast(err.message, "bad"); }
      load();
    });
    stopPoll = every(20_000, load);
  },
  unmount() { stopPoll?.(); },
};
