// שיחות: every call (the dialer's, the tests - also to a typed number, "שיחה אליי" - and incoming ones), the live one
// pinned on top; each row says who and which phone, and plays its recording right there. A call opens with its
// transcript and the bot's actions in one timeline.
import { get } from "../api.js";
import { liveCall, subscribe } from "../live.js";
import {
  callName, callOriginChip, chip, conversationHtml, emptyState, errorState, esc, every, fmtCost, fmtDateTime, fmtDuration, fmtPhone,
  fmtRel, icon, loadingState, ls, openDrawer, outcomeChip, outcomeLabel, pager, REASON_HE, setFollowing,
} from "../ui.js";
import { openContact } from "./contacts.js";

const ORIGINS = [["all", "הכול"], ["dialer", "אוטומטי"], ["manual", "🧪 בדיקה"]];
let stopPoll = null;
let unsub = null;
let stopAudio = null;

/** The phone under the name: the number the call was on (older calls: the contact's record id). */
const phoneLine = (c) => (c.number ? fmtPhone(c.number) : (c.gold_record_id ?? ""));

/** A recording's link is valid for an hour: asked for only when someone presses play. */
const recordingUrl = async (callId) => (await get(`/api/admin/calls/${encodeURIComponent(callId)}/recording`)).url;

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

/** The play button of a row: the one playing now says so (pressing it again pauses). */
const playButton = (c, playing) =>
  c.recording_path
    ? `<button class="btn sm rec-btn${playing ? " on" : ""}" data-play="${esc(c.call_id)}" title="${playing ? "עצור" : "השמע את ההקלטה"}">${icon(playing ? "pause" : "play")}<span>${playing ? "מתנגן" : "השמע"}</span></button>`
    : `<span class="faint">—</span>`;

function table(calls, playing) {
  if (!calls.length) return emptyState("אין שיחות עדיין", "שיחות של החיוג האוטומטי ושל הבדיקות יופיעו כאן.");
  return `<div class="table-wrap"><table class="data"><thead><tr>
      <th>מתי</th><th>לקוח</th><th>הקלטה</th><th>משך</th><th>עלות AI</th><th>תוצאה</th><th>מקור</th><th>ענה</th>
    </tr></thead><tbody>${calls
      .map(
        (c) => `<tr class="click" data-open="${esc(c.call_id)}">
        <td class="nowrap"><div class="cell-main">${esc(fmtDateTime(c.started_at))}</div><div class="cell-sub">${esc(fmtRel(c.started_at))}</div></td>
        <td><div class="cell-main">${esc(callName(c))}</div><div class="cell-sub ltr nowrap">${esc(phoneLine(c))}</div></td>
        <td class="nowrap">${playButton(c, c.call_id === playing)}</td>
        <td class="num nowrap">${fmtDuration(c.duration_sec)}</td>
        <td class="num nowrap">${c.ai_cost_usd === null || c.ai_cost_usd === undefined ? "—" : `$${Number(c.ai_cost_usd).toFixed(3)}`}</td>
        <td>${outcomeChip(c.outcome)}${c.reason && c.reason.toUpperCase() !== c.outcome ? ` <span class="cell-sub">${esc(REASON_HE[c.reason] ?? c.reason)}</span>` : ""}</td>
        <td>${callOriginChip(c)}${c.scenario ? ` <span class="cell-sub">תרחיש ${esc(c.scenario)}</span>` : ""}</td>
        <td>${c.answered ? chip("ענה", "success") : chip("לא ענה", "muted")}</td>
      </tr>`,
      )
      .join("")}</tbody></table></div>`;
}

/** The player above the list: who, which phone, when - and the recording. */
const playerHtml = (c, url) => `<div class="player-bar">
    <span class="player-ic">${icon("play")}</span>
    <div class="player-who"><div class="cell-main">${esc(callName(c))} <span class="ltr faint">${esc(phoneLine(c))}</span></div>
      <div class="cell-sub">${esc(fmtDateTime(c.started_at))} · ${fmtDuration(c.duration_sec)}</div></div>
    <audio controls autoplay preload="auto" src="${esc(url)}"></audio>
    <button class="icon-btn" data-player-close title="סגור">${icon("x")}</button>
  </div>`;

export default {
  id: "calls",
  title: "שיחות",
  icon: "phone",
  mount(root) {
    let origin = ls.get("mishlav_calls_origin", "all");
    let recOnly = ls.get("mishlav_calls_rec_only", false);
    let calls = [];
    let total = 0;
    let page = 1; // the newest calls are on page 1 (where a call that just ended appears)
    let playing = null; // the call whose recording plays now
    root.innerHTML = `
      <div id="callsLive"></div>
      <div class="card">
        <div class="card-head">
          <h2>היסטוריית שיחות</h2><span class="sub" id="callsCount"></span>
          <div class="actions">
            <button class="btn sm${recOnly ? " on" : ""}" id="callsRecOnly" aria-pressed="${recOnly}">${icon("play")}<span>רק עם הקלטה</span></button>
            <div class="seg" id="callsOrigin">${ORIGINS.map(([v, l]) => `<button data-v="${v}" class="${v === origin ? "on" : ""}">${l}</button>`).join("")}</div>
            <button class="icon-btn" id="callsRefresh" title="רענון">${icon("refresh")}</button>
          </div>
        </div>
        <div id="callsPlayer"></div>
        <div id="callsBody">${loadingState(6)}</div>
        <div id="callsPager"></div>
      </div>`;
    const body = root.querySelector("#callsBody");
    const player = root.querySelector("#callsPlayer");
    const audio = () => player.querySelector("audio");
    stopAudio = () => audio()?.pause();
    const render = () => {
      const a = audio();
      const now = playing && a && !a.paused ? playing : null;
      body.innerHTML = recOnly && !calls.length
        ? emptyState("אין הקלטות", "שיחות שענו בהן נשמרות עם הקלטה, גם שיחות בדיקה.", "phone")
        : table(calls, now);
      root.querySelector("#callsCount").textContent = `${total.toLocaleString("he-IL")} שיחות${recOnly ? " עם הקלטה" : ""}`;
    };
    // the server pages and filters (the origin, only with a recording): 50 a page, newest first
    let seq = 0;
    const load = async () => {
      const mine = ++seq;
      try {
        const r = await get(`/api/admin/calls?origin=${origin}&page=${page}${recOnly ? "&recorded=1" : ""}`);
        if (mine !== seq) return;
        calls = r.calls;
        total = r.total;
        page = r.page;
        pages.set(r.page, r.pages);
        render();
      } catch (e) {
        if (mine === seq) body.innerHTML = errorState(e.message);
      }
    };
    const pages = pager(root.querySelector("#callsPager"), (p) => { page = p; body.innerHTML = loadingState(6); load(); });
    // the recording plays in the bar above the list (the list refreshes every 15 s; the bar stays)
    const stopPlayer = () => {
      audio()?.pause();
      player.innerHTML = "";
      playing = null;
      render();
    };
    const play = async (callId, btn) => {
      if (playing === callId && audio()) {
        const a = audio();
        if (a.paused) void a.play();
        else a.pause();
        return;
      }
      const c = calls.find((x) => x.call_id === callId);
      if (!c) return;
      btn.disabled = true;
      try {
        player.innerHTML = playerHtml(c, await recordingUrl(callId));
        playing = callId;
        const a = audio();
        const mark = () => {
          const b = body.querySelector(`[data-play="${CSS.escape(callId)}"]`);
          if (!b) return;
          b.classList.toggle("on", !a.paused);
          b.innerHTML = `${icon(a.paused ? "play" : "pause")}<span>${a.paused ? "השמע" : "מתנגן"}</span>`;
        };
        a.addEventListener("play", mark);
        a.addEventListener("pause", mark);
        render();
      } catch (e) {
        player.innerHTML = `<div class="banner bad small" style="margin:10px 16px">${esc(e.message)}</div>`;
        playing = null;
      } finally {
        btn.disabled = false;
      }
    };
    player.addEventListener("click", (e) => {
      if (e.target.closest("[data-player-close]")) stopPlayer();
    });
    root.querySelector("#callsRecOnly").onclick = (e) => {
      recOnly = !recOnly;
      ls.set("mishlav_calls_rec_only", recOnly);
      e.currentTarget.classList.toggle("on", recOnly);
      e.currentTarget.setAttribute("aria-pressed", String(recOnly));
      page = 1;
      body.innerHTML = loadingState(6);
      load();
    };
    root.querySelector("#callsOrigin").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      origin = b.dataset.v;
      ls.set("mishlav_calls_origin", origin);
      root.querySelectorAll("#callsOrigin button").forEach((x) => x.classList.toggle("on", x === b));
      page = 1;
      body.innerHTML = loadingState(6);
      load();
    });
    root.querySelector("#callsRefresh").onclick = load;
    root.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-play]");
      if (btn) { void play(btn.dataset.play, btn); return; } // plays here, without opening the call
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
    stopAudio?.();
  },
};

/** The call drawer: details, then the conversation; while the call is live it refreshes every 1.5 s. */
export function openCall(callId) {
  let stop = null;
  const d = openDrawer({ title: "שיחה", sub: `<span class="ltr">${esc(callId)}</span>`, onClose: () => stop?.() });
  let first = true;
  // the recording is uploaded right after the call ends: until it is there, the drawer keeps asking (a minute and a half)
  const saving = (r) => {
    const c = r.call;
    if (r.live || !c || c.recording_path) return false;
    return Date.now() - new Date(c.started_at).getTime() - (c.duration_sec ?? 0) * 1000 < 90_000;
  };
  const render = (r) => {
    const c = r.call;
    d.setTitle(`${esc(c ? callName(c) : "שיחת בדיקה")} ${r.live ? chip("שיחה חיה", "live", { dot: true, cls: "pulse" }) : c ? outcomeChip(c.outcome) : ""}`);
    d.setSub(`${c ? `${esc(fmtDateTime(c.started_at))} · ` : ""}<span class="ltr faint">${esc(callId)}</span>`);
    const src = { db: "התמלול נשמר במסד", file: "התמלול מהדיסק של השרת הזה (יישמר במסד בסוף השיחה)", none: "" }[r.transcript_source];
    const who = c?.gold_record_id
      ? `<a href="#" data-contact="${esc(c.gold_record_id)}">${esc(c.full_name ?? c.gold_record_id)}</a>`
      : `${esc(c ? callName(c) : "")} <span class="faint small">(לא לקוח מהמסד)</span>`;
    const recording = c?.recording_path
      ? `<button class="btn sm" data-rec>${icon("play")}<span>השמע הקלטה</span></button>`
      : r.live ? "תישמר בסוף השיחה" : saving(r) ? "נשמרת…" : "אין";
    const meta = c
      ? `<dl class="kv">
          <dt>לקוח</dt><dd>${who}</dd>
          <dt>טלפון</dt><dd>${c.number ? `<span class="ltr num">${esc(fmtPhone(c.number))}</span>` : "—"}</dd>
          <dt>מקור</dt><dd>${callOriginChip(c)}${c.scenario ? ` <span class="faint small">· תרחיש ${esc(c.scenario)}</span>` : ""}</dd>
          <dt>משך</dt><dd class="num">${r.live ? "בשיחה…" : fmtDuration(c.duration_sec)}</dd>
          <dt>ענה</dt><dd>${c.answered ? "כן" : "לא"}</dd>
          <dt>עלות AI</dt><dd class="num">${fmtCost(c.ai_cost_usd, c.duration_sec)}</dd>
          <dt>הקלטה</dt><dd data-rec-box>${recording}</dd>
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
      // a playing recording stays (the read that found it was the last one)
      if (!d.body.querySelector("[data-rec-box] audio")) render(r);
      if (!r.live && !saving(r)) stop?.(); // a finished call with its recording (or none to wait for): no more polling
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
