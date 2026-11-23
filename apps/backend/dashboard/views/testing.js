// בדיקות: the old "📞 חיוג" tab, kept as it was - pick a contact or a number, a scenario, a name; dial, hang up,
// follow the transcript and the bot's actions live - plus a short "what to expect" card for the chosen scenario.
import { get, post } from "../api.js";
import { live, refreshLive, subscribe } from "../live.js";
import {
  CONTACT_STATUS_HE, esc, every, fmtDateTime, GENDER_HE, ls, notesHtml, outcomeLabel, PHONE_COL, REP_REASON_HE, setFollowing,
  TOOL_HE, toolItem, chip,
} from "../ui.js";
import { mountGoldCard } from "./gold.js";

let stops = [];
const savedNumber = () => ls.get("mishlav_phone", "");
const saveNumber = (n) => ls.set("mishlav_phone", n);

// Gemini's female voices (apps/phone/src/voices.js), to try one on a test call before picking it in סקירה; Google's own words
const VOICES = [
  ["Kore", "תקיף (ברירת המחדל עד היום)"], ["Leda", "צעיר"], ["Zephyr", "בהיר"], ["Aoede", "קליל"],
  ["Laomedeia", "שמח"], ["Autonoe", "בהיר"], ["Callirrhoe", "רגוע"], ["Despina", "חלק"],
];

export default {
  id: "testing",
  title: "בדיקות",
  icon: "flask",
  mount(root) {
    const S = { contacts: [], scenarios: [], callId: null, wasBusy: false, contactWasChosen: false, manualNumber: "", calls: [] };
    root.innerHTML = `
      <div class="grid cols-2">
        <div class="stack">
          <div class="card">
            <div class="card-head"><h2>📞 הבוט מתקשר למי שתבחר</h2></div>
            <div class="card-body stack">
              <div id="phStatus"></div>
              <div class="form-grid">
                <label class="field full">סטודנט מ-Supabase <select id="phContact"><option value="">— בלי (מספר ידני) —</option></select></label>
                <div id="phContactCard" class="full" hidden></div>
                <label class="field">מספר טלפון <input type="text" id="phNumber" class="ltr" inputmode="tel" placeholder="0501234567"></label>
                <label class="field">שם הלקוח (רשות) <input type="text" id="phName" placeholder="מהתרחיש"></label>
                <label class="field full">תרחיש <select id="phScenario"><option value="">ללא תרחיש (שם ויום ברירת מחדל)</option></select></label>
                <label class="field full">קול הבוט <select id="phVoice">
                  <option value="">הקול שנבחר בסקירה</option>
                  ${VOICES.map(([v, he]) => `<option value="${v}">${v} – ${he}</option>`).join("")}
                </select></label>
              </div>
              <div class="row">
                <button class="btn success lg" id="phDial">📞 חייג</button>
                <button class="btn danger lg" id="phHangup" disabled>⏹ נתק</button>
                <span class="small" id="phNote"></span>
              </div>
              <p class="small muted" style="margin:0">שיחה לסטודנט מ-Supabase כותבת לשדות של גולד עצמם (שורת [הערת הבוט] בסוף ה"הערות" ו"סטטוס") ומעדכנת את המצב הפנימי של הבוט. היא מסומנת "🧪 בדיקה" ולא נספרת במדדים של הסקירה. הלוג המלא של הקו – במסך <a href="#/logs">לוגים</a>.</p>
            </div>
          </div>
          <div class="card" id="phExpect" hidden></div>
          <div class="card">
            <div class="card-head"><h2>✉️ בדיקת SMS</h2></div>
            <div class="card-body stack">
              <div class="row">
                <input type="text" id="smsNumber" class="ltr" inputmode="tel" placeholder="0501234567" style="max-width:200px">
                <button class="btn" id="smsSend">שלח SMS בדיקה</button>
              </div>
              <span class="small" id="smsNote"></span>
              <p class="small muted" style="margin:0">שולח "משלב: הודעת בדיקה מהבוט" דרך הספק שמוגדר בשרת – בלי שיחה. בודק שהמפתחות של Zadarma, שם השולח והיתרה תקינים.</p>
            </div>
          </div>
        </div>
        <div class="stack">
          <div class="card"><div class="card-head"><h2>📝 מה נאמר</h2></div><div class="card-body"><div class="convo scroll" id="phTranscript"><p class="muted small">התמלול יופיע כאן בזמן השיחה</p></div></div></div>
          <div class="card"><div class="card-head"><h2>🔧 מה הבוט עשה</h2></div><div class="card-body"><ul class="tool-list" id="phTools"><li class="muted">עוד לא ביצע פעולות</li></ul></div></div>
        </div>
      </div>
      <div class="card" id="phGold" style="margin-top:16px"></div>`;
    const $ = (id) => root.querySelector(`#${id}`);
    const reloadGold = mountGoldCard($("phGold"));
    // a test SMS, without a call
    $("smsNumber").value = $("smsNumber").value || (() => { try { return localStorage.getItem("mishlav_phone") ?? ""; } catch { return ""; } })();
    $("smsSend").onclick = async () => {
      const number = $("smsNumber").value.trim();
      if (!number) { $("smsNote").textContent = "הכנס מספר"; return; }
      $("smsSend").disabled = true;
      $("smsNote").textContent = "שולח…";
      try {
        const r = await post("/api/admin/sms/test", { number });
        $("smsNote").innerHTML = r.sent
          ? `<span style="color:var(--success)">✓ נשלח דרך ${esc(r.provider)} – בדוק את הטלפון</span>`
          : `<span class="muted">לא נשלח באמת: אין מפתחות Zadarma בשרת (לוג בלבד)</span>`;
      } catch (e) {
        $("smsNote").innerHTML = `<span style="color:var(--danger)">לא נשלח: ${esc(e.message)}</span>`;
      } finally { $("smsSend").disabled = false; }
    };

    // ---- contacts (as before)
    const loadContacts = async () => {
      try {
        const r = await get("/test/contacts");
        S.contacts = r.contacts ?? [];
        const keep = $("phContact").value;
        $("phContact").innerHTML = `<option value="">${r.available ? "— בלי (מספר ידני) —" : "— Supabase לא מחובר —"}</option>` +
          S.contacts.map((c) => { const st = c.bot_state?.bot_status ?? "new"; return `<option value="${esc(c.gold_record_id)}"${st === "do_not_call" ? " disabled" : ""}>${esc(c.full_name ?? c.gold_record_id)} · ${esc(CONTACT_STATUS_HE[st] ?? st)}</option>`; }).join("");
        $("phContact").value = keep;
        renderContactCard();
      } catch { /* the form still dials numbers */ }
    };
    // a chosen student fills the number (the phone the bot dials now) and the name from Supabase (locked)
    const fillFromContact = (c) => {
      const num = $("phNumber"), name = $("phName");
      if (c) {
        if (!S.contactWasChosen) S.manualNumber = num.value;
        num.value = (c[PHONE_COL[(c.bot_state?.phone_index ?? 1) - 1]] ?? c.phone ?? "").replace(/^\+972/, "0");
        name.value = c.full_name ?? "";
      } else if (S.contactWasChosen) {
        num.value = S.manualNumber || savedNumber();
        name.value = "";
      }
      num.readOnly = name.readOnly = Boolean(c);
      S.contactWasChosen = Boolean(c);
    };
    const renderContactCard = () => {
      const c = S.contacts.find((x) => x.gold_record_id === $("phContact").value);
      fillFromContact(c);
      const card = $("phContactCard");
      card.hidden = !c;
      if (!c) return;
      const b = c.bot_state ?? {};
      const st = b.bot_status ?? "new";
      const pi = b.phone_index ?? 1;
      const dialing = c[PHONE_COL[pi - 1]];
      const row = (k, v) => (v === null || v === undefined || v === "" ? "" : `<dt>${k}</dt><dd>${v}</dd>`);
      const tasks = (c.rep_tasks ?? []).filter((t) => !t.done);
      card.innerHTML = `<div class="banner info" style="display:block"><b>${esc(c.full_name ?? "")}</b> · ${esc(CONTACT_STATUS_HE[st] ?? st)}
        <div class="small muted" style="margin:8px 0 4px">בגולד</div>
        <dl class="kv">
          ${row("סטטוס", esc(c.status))}${row("קורס מבוקש", esc(c.requested_course))}${row("מקור", esc(c.source))}${row("עיר", esc(c.city))}${row("חברה", esc(c.company))}
          ${row("טלפונים", [c.phone, c.phone2, c.phone3].filter(Boolean).map((p) => `<span class="ltr">${esc(p)}</span>`).join("<br>"))}
          ${row("הערות", c.notes ? notesHtml(c.notes) : null)}
        </dl>
        <div class="small muted" style="margin:8px 0 4px">אצל הבוט (גולד לא רואה)</div>
        <dl class="kv">
          ${row("מחייגים ל", dialing ? `${pi === 1 ? "טלפון" : `טלפון ${pi}`} · <span class="ltr">${esc(dialing)}</span>` : "אין מספר")}
          ${row("יום עיון", esc(b.interested_day_id))}
          ${row("מגדר (לבוט)", b.customer_gender ? esc(GENDER_HE[b.customer_gender]) : "ייקבע לפי השם")}
          ${row("ניסיונות", b.attempts ? `${b.attempts}${b.no_answer_streak ? ` · ${b.no_answer_streak} ברצף בלי מענה` : ""}` : null)}
          ${row("ענה בעבר", b.ever_answered ? "כן" : null)}
          ${row("שיחה אחרונה", b.last_call_at ? esc(fmtDateTime(b.last_call_at)) : null)}
          ${row("תוצאה אחרונה", b.last_outcome ? esc(outcomeLabel(b.last_outcome)) : null)}
          ${row("שיחה חוזרת", b.callback_at ? esc(fmtDateTime(b.callback_at)) : null)}
          ${row("החיוג הבא", b.next_call_at ? esc(fmtDateTime(b.next_call_at)) : null)}
          ${row("משימות לנציג", tasks.length ? tasks.map((t) => `${esc(REP_REASON_HE[t.reason] ?? t.reason)} – ${t.callback_at ? esc(fmtDateTime(t.callback_at)) : "בהקדם"}`).join("<br>") : null)}
          ${row("עודכן לגולד", b.gold_changed_at ? esc(fmtDateTime(b.gold_changed_at)) : null)}
        </dl>
        ${st === "do_not_call" ? `<div class="small" style="color:var(--danger)">ביקש לא להתקשר – אי אפשר לחייג</div>` : ""}</div>`;
    };
    $("phContact").onchange = renderContactCard;

    // ---- scenarios + "what to expect"
    const scenario = () => S.scenarios.find((s) => s.id === $("phScenario").value);
    const renderExpect = () => {
      const s = scenario();
      const el = $("phExpect");
      el.hidden = !s;
      if (!s) return;
      const done = new Set(S.calls.filter((c) => c.ok).map((c) => c.tool));
      const req = s.required_tools.map((t) => chip(`${done.has(t) ? "✓ " : ""}${TOOL_HE[t] ?? t}`, done.has(t) ? "success" : "info")).join(" ");
      const forb = s.forbidden_tools.map((t) => chip(`${done.has(t) ? "✗ " : ""}${TOOL_HE[t] ?? t}`, done.has(t) ? "danger" : "muted")).join(" ");
      const g = s.guide ?? {};
      el.innerHTML = `<div class="card-head"><h2>מה צפוי · ${esc(s.id)}</h2><span class="sub">${esc(g.title ?? s.name)}</span></div>
        <div class="card-body stack" style="gap:10px">
          ${g.expect ? `<div>${esc(g.expect)}</div>` : ""}
          <dl class="kv">
            <dt>תוצאה צפויה</dt><dd>${esc(outcomeLabel(s.expected_outcome))}</dd>
            ${s.required_tools.length ? `<dt>חייב לקרות</dt><dd class="row">${req}</dd>` : ""}
            ${s.forbidden_tools.length ? `<dt>אסור</dt><dd class="row">${forb}</dd>` : ""}
          </dl>
          <details class="more"><summary>הצג עוד</summary>
            ${s.actor_script?.length ? `<div class="small muted" style="margin-top:8px">מה להגיד</div><ol class="script">${s.actor_script.map((l) => `<li>${esc(typeof l === "string" ? l : JSON.stringify(l))}</li>`).join("")}</ol>` : ""}
            ${g.tips?.length ? `<div class="small muted" style="margin-top:8px">טיפים</div><ul class="script">${g.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
            ${g.watch?.length ? `<div class="small muted" style="margin-top:8px">לשים לב</div><ul class="script">${g.watch.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
          </details>
        </div>`;
    };
    $("phScenario").onchange = renderExpect;
    get("/test/overview").then((ov) => {
      S.scenarios = ov.scenarios;
      $("phScenario").innerHTML = `<option value="">ללא תרחיש (שם ויום ברירת מחדל)</option>` +
        ov.scenarios.map((s) => `<option value="${esc(s.id)}">${esc(s.id)} · ${esc(s.guide?.title ?? s.name)}</option>`).join("");
    }).catch(() => {});
    if (!$("phNumber").value) $("phNumber").value = savedNumber();

    // ---- the line's status (from the shared poll) + the call's transcript and tools (every 1.5 s)
    const onLive = () => {
      const info = live.phone;
      if (!info) return;
      const st = info.status;
      $("phStatus").innerHTML = !info.available
        ? `<div class="banner bad">קו הטלפון לא פעיל: ${esc(info.reason ?? "לא ידוע")}</div>`
        : st.busy
          ? `<div class="banner live">🔴 שיחה פעילה (${st.call.direction === "out" ? "יוצאת" : "נכנסת"}) · <span class="ltr">${esc(st.call.number)}</span> · תרחיש ${esc(st.call.scenario ?? "—")}</div>`
          : `<div class="banner ok">הקו מוכן ✓ ${st.number ? `· <span class="ltr">${esc(st.number)}</span>` : ""} · <span class="small ltr">${esc(st.model)} · ${esc(st.voice)}</span></div>`;
      // a call just ended: show the contacts' new statuses
      if (S.wasBusy && !st?.busy) setTimeout(() => { loadContacts(); reloadGold(); }, 1500);
      S.wasBusy = Boolean(st?.busy);
      $("phDial").disabled = !info.available || st.busy;
      $("phHangup").disabled = !st?.busy;
      if (st?.call?.id) S.callId = st.call.id;
    };
    const pollCall = async () => {
      if (!S.callId) return;
      const [calls, tr] = await Promise.all([
        get(`/test/calls?call_id=${encodeURIComponent(S.callId)}`).catch(() => null),
        get(`/test/transcript?call_id=${encodeURIComponent(S.callId)}`).catch(() => null),
      ]);
      if (calls) {
        S.calls = calls.calls;
        $("phTools").innerHTML = calls.calls.length ? calls.calls.map(toolItem).join("") : `<li class="muted">עוד לא ביצע פעולות</li>`;
        renderExpect();
      }
      if (tr?.lines.length) {
        setFollowing($("phTranscript"), tr.lines.map((l) => `<div class="bubble ${l.role === "user" ? "user" : "bot"}"><span class="who">${l.role === "user" ? "לקוח" : "הבוט"}</span>${esc(l.text)}</div>`).join(""));
      }
    };

    $("phDial").onclick = async () => {
      const contactId = $("phContact").value;
      const number = $("phNumber").value.trim();
      if (!number && !contactId) { $("phNote").textContent = "הכנס מספר או בחר סטודנט"; return; }
      $("phDial").disabled = true;
      $("phNote").textContent = "מחייג...";
      try {
        const sc = $("phScenario").value;
        // with a student, the server takes the number and the first name from Supabase
        const body = contactId ? { contact_id: contactId } : { number, ...($("phName").value.trim() ? { name: $("phName").value.trim() } : {}) };
        if (!contactId) saveNumber(number);
        const voice = $("phVoice").value;
        const r = await post("/test/phone/call", { ...body, ...(sc ? { scenario: sc } : {}), ...(voice ? { voice } : {}) });
        S.callId = r.call_id;
        S.calls = [];
        $("phTranscript").innerHTML = `<p class="muted small">מחכה שיענו...</p>`;
        $("phTools").innerHTML = `<li class="muted">עוד לא ביצע פעולות</li>`;
        renderExpect();
        $("phNote").textContent = "";
      } catch (e) {
        $("phNote").innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`;
      }
      refreshLive();
    };
    $("phHangup").onclick = async () => { await post("/test/phone/hangup").catch(() => {}); refreshLive(); };

    loadContacts();
    stops = [subscribe(onLive), every(1500, pollCall)];
  },
  unmount() { stops.forEach((s) => s()); stops = []; },
};
