// שיחות: every call (the dialer's and the tests), the live one pinned on top; a call opens with its transcript and
// the bot's actions in one timeline.
import { get } from "../api.js";
import { liveCall, subscribe } from "../live.js";
import {
  chip, conversationHtml, emptyState, errorState, esc, every, fmtCost, fmtDateTime, fmtDuration, fmtRel, icon, loadingState, ls,
  openDrawer, originChip, outcomeChip, outcomeLabel, REASON_HE, setFollowing,
} from "../ui.js";
import { openContact } from "./contacts.js";

const ORIGINS = [["all", "הכול"], ["dialer", "אוטומטי"], ["manual", "🧪 בדיקה"]];
let stopPoll = null;
let unsub = null;

function liveBanner(c) {
  if (!c) return "";
  const secs = (Date.now() - new Date(c.started_at).getTime()) / 1000;
  return `<div class="card" style="margin-bottom:16px;border-color:color-mix(in srgb,var(--live) 45%,var(--border))">
    <div class="card-body row">
      ${chip("שיחה חיה", "live", { dot: true, cls: "pulse" })}
      <b>${esc(c.name ?? c.number)}</b>
      <span class="muted small">${c.direction === "out" ? "יוצאת" : "נכנסת"} · ${c.origin === "dialer" ? "אוטומטי" : "🧪 בדיקה"}${c.scenario ? ` · תרחיש ${esc(c.scenario)}` : ""} · <span class="num">${fmtDuration(secs)}</span></span>
      <span class="spacer"></span>
      <button class="btn primary sm" data-open="${esc(c.id)}">פתח את השיחה</button>
    </div></div>`;
}

function table(calls) {
  if (!calls.length) return emptyState("אין שיחות עדיין", "שיחות של החיוג האוטומטי ושל הבדיקות יופיעו כאן.");
  return `<div class="table-wrap"><table class="data"><thead><tr>
      <th>מתי</th><th>לקוח</th><th>משך</th><th>עלות AI</th><th>תוצאה</th><th>מקור</th><th>ענה</th>
    </tr></thead><tbody>${calls
      .map(
        (c) => `<tr class="click" data-open="${esc(c.call_id)}">
        <td class="nowrap"><div class="cell-main">${esc(fmtDateTime(c.started_at))}</div><div class="cell-sub">${esc(fmtRel(c.started_at))}</div></td>
        <td><div class="cell-main">${esc(c.full_name ?? "—")}</div><div class="cell-sub ltr">${esc(c.gold_record_id)}</div></td>
        <td class="num nowrap">${fmtDuration(c.duration_sec)}</td>
        <td class="num nowrap">${c.ai_cost_usd === null || c.ai_cost_usd === undefined ? "—" : `$${Number(c.ai_cost_usd).toFixed(3)}`}</td>
        <td>${outcomeChip(c.outcome)}${c.reason && c.reason.toUpperCase() !== c.outcome ? ` <span class="cell-sub">${esc(REASON_HE[c.reason] ?? c.reason)}</span>` : ""}</td>
        <td>${originChip(c.origin)}</td>
        <td>${c.answered ? chip("ענה", "success") : chip("לא ענה", "muted")}</td>
      </tr>`,
      )
      .join("")}</tbody></table></div>`;
}

export default {
  id: "calls",
  title: "שיחות",
  icon: "phone",
  mount(root) {
    let origin = ls.get("mishlav_calls_origin", "all");
    root.innerHTML = `
      <div id="callsLive"></div>
      <div class="card">
        <div class="card-head">
          <h2>היסטוריית שיחות</h2><span class="sub" id="callsCount"></span>
          <div class="actions">
            <div class="seg" id="callsOrigin">${ORIGINS.map(([v, l]) => `<button data-v="${v}" class="${v === origin ? "on" : ""}">${l}</button>`).join("")}</div>
            <button class="icon-btn" id="callsRefresh" title="רענון">${icon("refresh")}</button>
          </div>
        </div>
        <div id="callsBody">${loadingState(6)}</div>
      </div>`;
    const body = root.querySelector("#callsBody");
    const load = async () => {
      try {
        const r = await get(`/api/admin/calls?limit=300&origin=${origin}`);
        body.innerHTML = table(r.calls);
        root.querySelector("#callsCount").textContent = `${r.calls.length} שיחות`;
      } catch (e) {
        body.innerHTML = errorState(e.message);
      }
    };
    root.querySelector("#callsOrigin").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      origin = b.dataset.v;
      ls.set("mishlav_calls_origin", origin);
      root.querySelectorAll("#callsOrigin button").forEach((x) => x.classList.toggle("on", x === b));
      body.innerHTML = loadingState(6);
      load();
    });
    root.querySelector("#callsRefresh").onclick = load;
    root.addEventListener("click", (e) => {
      const row = e.target.closest("[data-open]");
      if (row) openCall(row.dataset.open);
    });
    // the live call on top; when one ends, the list picks it up
    let wasLive = null;
    unsub = subscribe(() => {
      const c = liveCall();
      root.querySelector("#callsLive").innerHTML = liveBanner(c);
      if (wasLive && !c) setTimeout(load, 1500);
      wasLive = c?.id ?? null;
    });
    stopPoll = every(15_000, load);
  },
  unmount() {
    stopPoll?.();
    unsub?.();
  },
};

/** The call drawer: details, then the conversation; while the call is live it refreshes every 1.5 s. */
export function openCall(callId) {
  let stop = null;
  const d = openDrawer({ title: "שיחה", sub: `<span class="ltr">${esc(callId)}</span>`, onClose: () => stop?.() });
  let first = true;
  const render = (r) => {
    const c = r.call;
    d.setTitle(`${esc(c?.full_name ?? "שיחת בדיקה")} ${r.live ? chip("שיחה חיה", "live", { dot: true, cls: "pulse" }) : c ? outcomeChip(c.outcome) : ""}`);
    d.setSub(`${c ? `${esc(fmtDateTime(c.started_at))} · ` : ""}<span class="ltr faint">${esc(callId)}</span>`);
    const src = { db: "התמלול נשמר במסד", file: "התמלול מהדיסק של השרת הזה (יישמר במסד בסוף השיחה)", none: "" }[r.transcript_source];
    const meta = c
      ? `<dl class="kv">
          <dt>לקוח</dt><dd><a href="#" data-contact="${esc(c.gold_record_id)}">${esc(c.full_name ?? c.gold_record_id)}</a></dd>
          <dt>מקור</dt><dd>${originChip(c.origin)}</dd>
          <dt>משך</dt><dd class="num">${r.live ? "בשיחה…" : fmtDuration(c.duration_sec)}</dd>
          <dt>ענה</dt><dd>${c.answered ? "כן" : "לא"}</dd>
          <dt>עלות AI</dt><dd class="num">${fmtCost(c.ai_cost_usd, c.duration_sec)}</dd>
          <dt>הקלטה</dt><dd data-rec-box>${c.recording_path ? `<button class="btn sm" data-rec>▶ השמע הקלטה</button>` : r.live ? "תישמר בסוף השיחה" : "אין"}</dd>
          <dt>תוצאה</dt><dd>${esc(outcomeLabel(c.outcome))}${c.reason ? ` · ${esc(REASON_HE[c.reason] ?? c.reason)}` : ""}</dd>
          ${c.summary ? `<dt>סיכום</dt><dd>${esc(c.summary)}</dd>` : ""}
        </dl>`
      : `<div class="banner info">שיחת בדיקה למספר ידני (לא של לקוח מהמסד): יש רק את מה שנשמר בשרת הזה.</div>`;
    const errors = r.errors?.length
      ? `<div class="section-title">תקלות בעדכון Supabase</div>${r.errors.map((x) => `<div class="banner bad small">${esc(fmtDateTime(x.ts))} · ${esc(x.what)}: ${esc(x.error)}</div>`).join("")}`
      : "";
    const convo = conversationHtml(r.transcript, r.tools);
    const html = `${meta}
      <div class="section-title">השיחה ${src ? `<span class="faint" style="font-weight:400">· ${esc(src)}</span>` : ""}</div>
      ${convo ? `<div class="convo">${convo}</div>` : emptyState(r.live ? "מחכה שיענו…" : "אין תמלול", r.live ? "" : "אולי לא ענו, או שהשיחה הייתה לפני שהתמלולים נשמרו במסד.", "phone", true)}
      ${errors}`;
    if (first) { d.body.innerHTML = html; first = false; }
    else setFollowing(d.body, html);
  };
  const load = async () => {
    try {
      const r = await get(`/api/admin/calls/${encodeURIComponent(callId)}`);
      render(r);
      if (!r.live) stop?.(); // a finished call (or the last read after the end): no more polling
    } catch (e) {
      if (first) d.body.innerHTML = errorState(e.message);
    }
  };
  stop = every(1500, load, () => d.isOpen());
  d.body.onclick = async (e) => {
    const a = e.target.closest("[data-contact]");
    if (a) { e.preventDefault(); openContact(a.dataset.contact); return; }
    // the recording: a link valid for an hour, asked for only when someone wants to listen
    const play = e.target.closest("[data-rec]");
    if (!play) return;
    const box = play.closest("[data-rec-box]");
    play.disabled = true;
    try {
      const r = await get(`/api/admin/calls/${encodeURIComponent(callId)}/recording`);
      box.innerHTML = `<audio controls autoplay preload="auto" src="${esc(r.url)}" style="width:100%;max-width:360px"></audio>`;
    } catch (err) {
      box.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
    }
  };
}
