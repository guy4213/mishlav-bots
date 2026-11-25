// סקירה: today's numbers (dialer calls only), the contacts' funnel, the queue, rep tasks, the dialer and the live call.
import { get, isAdmin, post } from "../api.js";
import { live, liveCall, subscribe } from "../live.js";
import {
  chip, conversationHtml, CONTACT_STATUS_HE, DIALER_STATE_HE, emptyState, errorState, esc, every, fmtDateTime, fmtDuration, fmtRel,
  loadingState, setFollowing, statusChip, statusTone, toast, TONE_VAR,
} from "../ui.js";
import { openCall } from "./calls.js";
import { openContact } from "./contacts.js";

let stops = [];

// the voices' Hebrew words come with the list (GET /api/admin/voice: labels)

/**
 * The pilot's daily limit (admins only: not shown to Mishlav's users nor in "view as Mishlav"): at most N automatic
 * calls a day, so every call can be checked, raised step by step. Rendered once: typing isn't lost to the live refresh.
 */
async function limitCard(el) {
  const head = `<div class="card-head"><h2>מגבלת שיחות יומית (פיילוט)</h2></div>`;
  let d;
  try {
    d = (await get("/api/admin/dialer")).dialer;
  } catch (e) {
    el.innerHTML = head + errorState(e.message, true);
    return;
  }
  el.innerHTML = `${head}<div class="card-body stack">
      <label class="field full">כמה שיחות אוטומטיות ביום, לכל היותר
        <input type="number" id="ovLimit" min="1" max="1000" placeholder="בלי מגבלה" value="${d?.daily_limit ?? ""}">
      </label>
      <div class="row"><button class="btn primary sm" id="ovLimitSave">שמירה</button>
        <span class="small muted">כשמגיעים למספר, החיוג נעצר עד מחר. ריק = בלי מגבלה. שיחות בדיקה לא נספרות.</span></div>
    </div>`;
  el.querySelector("#ovLimitSave").onclick = async (e) => {
    const raw = el.querySelector("#ovLimit").value.trim();
    const daily_limit = raw ? Number(raw) : null;
    e.target.disabled = true;
    try {
      await post("/api/admin/dialer/limit", { daily_limit });
      toast(daily_limit ? `נשמר: עד ${daily_limit} שיחות ביום` : "נשמר: בלי מגבלה", "ok");
    } catch (err) {
      toast(err.message, "bad");
    } finally {
      e.target.disabled = false;
    }
  };
}

/** קול הבוט: the team picks the voice for every call; it is kept in Supabase and used from the next call. */
async function voiceCard(el) {
  const head = `<div class="card-head"><h2>קול הבוט</h2></div>`;
  let r;
  try {
    r = await get("/api/admin/voice");
  } catch (e) {
    el.innerHTML = head + errorState(e.message, true);
    return;
  }
  const opt = (v, cur) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(v)} – ${esc(r.labels?.[v] ?? "")}</option>`;
  el.innerHTML = `${head}<div class="card-body stack">
      <label class="field full">הקול בכל השיחות <select id="ovVoiceSel">
        <option value=""${r.voice ? "" : " selected"}>ברירת המחדל של השרת (${esc(r.server_voice)})</option>
        ${r.voices.map((v) => opt(v, r.voice)).join("")}
      </select></label>
      <div class="row"><button class="btn primary sm" id="ovVoiceSave">שמירה</button>
        <span class="small muted">חל מהשיחה הבאה. לשמוע קול לפני שבוחרים: שיחת בדיקה במסך "בדיקות".</span></div>
    </div>`;
  el.querySelector("#ovVoiceSave").onclick = async (e) => {
    const voice = el.querySelector("#ovVoiceSel").value || null;
    e.target.disabled = true;
    try {
      await post("/api/admin/voice", { voice });
      toast(`הקול נשמר: ${voice ?? "ברירת המחדל של השרת"}`, "ok");
    } catch (err) {
      toast(err.message, "bad");
    } finally {
      e.target.disabled = false;
    }
  };
}

function kpis(s) {
  const t = s.today;
  const o = t.outcomes ?? {};
  const pct = t.total ? Math.round((t.answered / t.total) * 100) : 0;
  const tile = (label, value, color, sub = "") =>
    `<div class="kpi" style="--kpi-c:var(${color})"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub || "&nbsp;"}</div></div>`;
  return `<div class="kpis">
    ${tile("שיחות היום", t.total, "--info", t.manual_total ? `ועוד ${t.manual_total} שיחות בדיקה (לא נספרות)` : "שיחות החיוג האוטומטי")}
    ${tile("ענו", t.answered, "--teal", t.total ? `${pct}% מהשיחות` : "")}
    ${tile("נשלחו קישורים", o.LINK_SENT ?? 0, "--success")}
    ${tile("לידים חמים", o.HOT_LEAD ?? 0, "--warning", o.COMPANY ? `ועוד ${o.COMPANY} דרך החברה` : "")}
    ${tile("שיחות חוזרות", o.CALLBACK ?? 0, "--violet")}
    ${tile("הסרות", o.DO_NOT_CALL ?? 0, "--danger")}
  </div>`;
}

function funnel(s) {
  const f = s.funnel;
  const parts = [["new", "חדשים", "--info"], ["in_queue", "בתור / בתהליך", "--violet"], ["handled", "בטיפול (קישור, נציג)", "--success"], ["closed", "הסתיימו", "--muted"]];
  const total = parts.reduce((a, [k]) => a + Number(f[k] ?? 0), 0) || 1;
  const statuses = Object.entries(s.by_status ?? {}).sort((a, b) => b[1] - a[1]);
  return `<div class="card"><div class="card-head"><h2>משפך הלקוחות</h2><span class="sub">${s.contacts_total} לקוחות</span></div><div class="card-body">
    <div class="funnel-bar">${parts.map(([k, , c]) => (f[k] ? `<span style="flex:${f[k]};background:var(${c})" title="${f[k]}"></span>` : "")).join("")}</div>
    <div class="funnel-legend">${parts.map(([k, l, c]) => `<div><div class="lbl"><span class="sw" style="background:var(${c})"></span>${l}</div><div class="val">${f[k] ?? 0}</div><div class="small faint">${Math.round(((f[k] ?? 0) / total) * 100)}%</div></div>`).join("")}</div>
    <div class="row" style="margin-top:16px">${statuses.map(([k, n]) => `<span class="chip t-${statusTone(k)}">${esc(CONTACT_STATUS_HE[k] ?? k)} · ${n}</span>`).join("")}</div>
  </div></div>`;
}

function queue(s) {
  const now = Date.now();
  const items = s.next_due ?? [];
  return `<div class="card"><div class="card-head"><h2>התור</h2><span class="sub">${s.due_now} מחכים לחיוג עכשיו</span></div>
    ${items.length ? `<ul class="list">${items.map((q) => {
      const due = !q.next_call_at || new Date(q.next_call_at).getTime() <= now;
      return `<li class="click" data-contact="${esc(q.gold_record_id)}"><div class="grow"><div class="cell-main">${esc(q.full_name ?? q.gold_record_id)}</div><div class="cell-sub">${due ? "עכשיו בתור" : `${esc(fmtDateTime(q.next_call_at))} · ${esc(fmtRel(q.next_call_at))}`}</div></div>${statusChip(q.bot_status)}</li>`;
    }).join("")}</ul>` : emptyState("התור ריק", "אין לקוחות שמחכים לחיוג.", "inbox", true)}</div>`;
}

function dialerCard() {
  if (!live.dialerAvailable) return `<div class="card"><div class="card-head"><h2>חיוג אוטומטי</h2></div>${emptyState("לא זמין", "Supabase לא מחובר בשרת הזה.", "alert", true)}</div>`;
  const d = live.dialer;
  if (!d) return `<div class="card"><div class="card-head"><h2>חיוג אוטומטי</h2></div>${loadingState(3)}</div>`;
  const on = d.enabled === true;
  return `<div class="card"><div class="card-head"><h2>חיוג אוטומטי</h2><span class="actions">${on ? chip(DIALER_STATE_HE[d.state] ?? d.state, d.state === "error" ? "danger" : "success", { dot: true }) : chip("כבוי", "muted", { dot: true })}</span></div>
    <div class="card-body"><dl class="kv">
      <dt>שיחות היום</dt><dd class="num">${d.calls_today}${d.daily_limit ? ` / ${d.daily_limit} (מגבלה יומית)` : ""}</dd>
      ${d.reason ? `<dt>סיבה</dt><dd>${esc(d.reason)}</dd>` : ""}
      ${d.changed_at ? `<dt>שונה</dt><dd>${esc(fmtDateTime(d.changed_at))}</dd>` : ""}
      ${d.next_due ? `<dt>הבא בתור</dt><dd><a href="#" data-contact="${esc(d.next_due.gold_record_id)}" class="ltr">${esc(d.next_due.gold_record_id)}</a>${d.next_due.next_call_at ? ` · ${esc(fmtRel(d.next_due.next_call_at))}` : ""}</dd>` : ""}
      ${d.only_numbers ? `<dt>הגבלה</dt><dd>רק מספרים ב-<code>DIALER_ONLY_NUMBERS</code></dd>` : ""}
      ${d.last_error ? `<dt>תקלה אחרונה</dt><dd style="color:var(--danger)">${esc(d.last_error.message)} <span class="faint">(${esc(fmtRel(d.last_error.at))})</span></dd>` : ""}
      ${d.failures ? `<dt>תקלות ברצף</dt><dd>${d.failures} / 3</dd>` : ""}
    </dl></div></div>`;
}

export default {
  id: "overview",
  title: "סקירה",
  icon: "overview",
  mount(root) {
    root.innerHTML = `
      <div id="ovKpis">${loadingState(2)}</div>
      <div class="grid cols-main" style="margin-top:16px">
        <div class="stack">
          <div class="card" id="ovLive"></div>
          <div id="ovFunnel"></div>
        </div>
        <div class="stack">
          <div id="ovDialer"></div>
          ${isAdmin() ? `<div class="card" id="ovLimitCard"></div><div class="card" id="ovVoice"></div>` : ""}
          <div id="ovQueue"></div>
          <div class="card" id="ovTasks"></div>
        </div>
      </div>`;
    const $r = (id) => root.querySelector(`#${id}`);
    if (isAdmin()) {
      limitCard($r("ovLimitCard")); // the pilot's daily limit: ours
      voiceCard($r("ovVoice")); // the bot's voice: ours
    }
    const load = async () => {
      try {
        const { summary: s } = await get("/api/admin/summary");
        $r("ovKpis").innerHTML = kpis(s);
        $r("ovFunnel").innerHTML = funnel(s);
        $r("ovQueue").innerHTML = queue(s);
        $r("ovTasks").innerHTML = `<div class="card-head"><h2>משימות לנציג</h2></div><div class="card-body row"><span class="kpi-value" style="margin:0">${s.open_rep_tasks}</span><span class="muted">משימות פתוחות</span><span class="spacer"></span><a class="btn sm" href="#/reps">לרשימה</a></div>`;
      } catch (e) {
        $r("ovKpis").innerHTML = `<div class="card">${errorState(e.message, true)}</div>`;
      }
    };
    // the live call: transcript every 1.5 s while there is one
    let liveId = null;
    let stopLive = null;
    const renderLive = async () => {
      if (!liveId) return;
      try {
        const r = await get(`/api/admin/calls/${encodeURIComponent(liveId)}`);
        const box = $r("ovConvo");
        if (box) setFollowing(box, conversationHtml(r.transcript, r.tools) || `<p class="small faint">מחכה שיענו…</p>`);
      } catch { /* not on disk yet */ }
    };
    const onLive = () => {
      $r("ovDialer").innerHTML = dialerCard();
      const c = liveCall();
      const el = $r("ovLive");
      if (!c) {
        if (liveId || !el.dataset.idle) {
          stopLive?.();
          liveId = null;
          el.dataset.idle = "1";
          el.innerHTML = `<div class="card-head"><h2>שיחה חיה</h2></div>${emptyState("אין שיחה כרגע", live.dialer?.enabled ? "החיוג האוטומטי פועל: שיחה הבאה תופיע כאן עם התמלול." : "החיוג האוטומטי כבוי.", "phone", true)}`;
        }
        return;
      }
      const secs = (Date.now() - new Date(c.started_at).getTime()) / 1000;
      if (c.id !== liveId) {
        liveId = c.id;
        delete el.dataset.idle;
        el.innerHTML = `<div class="card-head"><h2>שיחה חיה</h2>${chip("חי", "live", { dot: true, cls: "pulse" })}<span class="sub" id="ovLiveSub"></span><span class="actions"><button class="btn sm" data-call="${esc(c.id)}">פתח</button></span></div><div class="card-body"><div class="convo scroll" id="ovConvo"><p class="small faint">מחכה שיענו…</p></div></div>`;
        stopLive?.();
        stopLive = every(1500, renderLive);
      }
      $r("ovLiveSub").textContent = `${c.name ?? c.number} · ${c.origin === "dialer" ? "אוטומטי" : "בדיקה"} · ${fmtDuration(secs)}`;
    };
    root.addEventListener("click", (e) => {
      const a = e.target.closest("[data-contact]");
      if (a) { e.preventDefault(); openContact(a.dataset.contact); }
      const b = e.target.closest("[data-call]");
      if (b) openCall(b.dataset.call);
    });
    stops = [every(20_000, load), subscribe(onLive), () => stopLive?.()];
  },
  unmount() { stops.forEach((s) => s()); stops = []; },
};
