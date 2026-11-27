// שיחת בדיקה אליי (Mishlav's users): the bot calls the phone this user logged in with - never another number - as a
// customer who asked about the study day they pick, by their own first name. They follow the call live here; it
// doesn't touch any contact or Gold (apps/backend/src/routes/phone.ts /api/me/test-call).
import { get, post } from "../api.js";
import { live, refreshLive, subscribe } from "../live.js";
import { conversationHtml, emptyState, errorState, esc, every, loadingState, setFollowing } from "../ui.js";

let stops = [];

export default {
  id: "self-test",
  title: "שיחת בדיקה אליי",
  icon: "phone",
  async mount(root) {
    const S = { callId: null, following: false, info: null };
    root.innerHTML = `<div class="grid cols-2">
        <div class="card" id="stCard">${loadingState(4)}</div>
        <div class="card"><div class="card-head"><h2>📝 מה נאמר</h2></div>
          <div class="card-body"><div class="convo scroll" id="stConvo"><p class="muted small">התמלול יופיע כאן בזמן השיחה</p></div></div></div>
      </div>`;
    const $ = (id) => root.querySelector(`#${id}`);
    try {
      S.info = await get("/api/me/test-call");
    } catch (e) {
      $("stCard").innerHTML = errorState(e.message);
      return;
    }
    const { phone, days, voices = [], voice } = S.info;
    $("stCard").innerHTML = `<div class="card-head"><h2>📞 הבוט יתקשר אליך</h2></div>
      <div class="card-body stack">
        <div id="stLine"></div>
        <p style="margin:0">הבוט יתקשר למספר שלך, <b class="ltr">${esc(phone)}</b>, ויתנהג כאילו השארת פרטים על יום העיון שתבחר. אפשר לשאול אותו שאלות, לבקש קישור, לבקש נציג – כמו לקוח.</p>
        <label class="field full">יום העיון שהתעניינת בו
          <select id="stDay"><option value="">לא ידוע (הבוט ישאל)</option>${days.map((d) => `<option value="${esc(d.id)}">${esc(d.label)}</option>`).join("")}</select>
        </label>
        <label class="field full">קול הבוט בשיחה הזאת
          <select id="stVoice">${voices.map((v) => `<option value="${esc(v.id)}"${v.id === voice ? " selected" : ""}>${esc(v.id)} – ${esc(v.he)}${v.id === voice ? " (הקול הנוכחי)" : ""}</option>`).join("")}</select>
        </label>
        <div class="row">
          <button class="btn success lg" id="stDial">📞 התקשרו אליי</button>
          <button class="btn danger lg" id="stHangup" disabled>⏹ נתק</button>
          <span class="small" id="stNote"></span>
        </div>
        <p class="small muted" style="margin:0">שיחת בדיקה לא נוגעת באף לקוח ולא בגולד. אם תבקש קישור לרכישה, הוא יישלח בוואטסאפ למספר שלך.</p>
      </div>`;

    const onLive = () => {
      const ph = live.phone;
      const busy = !!ph?.status?.busy;
      const mine = busy && ph.status.call?.id === S.callId;
      $("stLine").innerHTML = !ph
        ? ""
        : !ph.available
          ? `<div class="banner bad">קו הטלפון לא פעיל כרגע. נסה שוב מאוחר יותר.</div>`
          : busy
            ? `<div class="banner live">🔴 ${mine ? "השיחה אליך פעילה" : "הקו תפוס בשיחה אחרת. אפשר לנסות שוב כשתסתיים."}</div>`
            : `<div class="banner ok">הקו פנוי ✓</div>`;
      $("stDial").disabled = !ph?.available || busy;
      $("stHangup").disabled = !mine;
    };

    const follow = async () => {
      if (!S.following) return;
      try {
        const r = await get(`/api/admin/calls/${encodeURIComponent(S.callId)}`);
        if (!r.live) S.following = false; // ended: this read is the last
        const html = conversationHtml(r.transcript ?? [], r.tools ?? [], { customer: "אתה" });
        setFollowing($("stConvo"), html || `<p class="muted small">${r.live ? "מחכה שתענה…" : "השיחה הסתיימה בלי מה להציג"}</p>`);
      } catch (e) {
        if (e.status !== 404) $("stConvo").innerHTML = errorState(e.message, true);
      }
    };

    $("stDial").onclick = async () => {
      $("stDial").disabled = true;
      $("stNote").textContent = "מחייג…";
      try {
        const day = $("stDay").value;
        const voice = $("stVoice")?.value;
        const r = await post("/api/me/test-call", { ...(day ? { day_id: day } : {}), ...(voice ? { voice } : {}) });
        S.callId = r.call_id;
        S.following = true;
        $("stConvo").innerHTML = `<p class="muted small">מחכה שתענה…</p>`;
        $("stNote").textContent = "הטלפון שלך אמור לצלצל";
      } catch (e) {
        $("stNote").innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`;
      }
      refreshLive();
    };
    $("stHangup").onclick = async () => { await post("/api/me/hangup").catch(() => {}); refreshLive(); };

    if (!days.length) $("stDay").closest("label").insertAdjacentHTML("afterend", emptyState("אין ימי עיון קרובים", "", "calendar", true));
    stops = [subscribe(onLive), every(1500, follow)];
  },
  unmount() { stops.forEach((s) => s()); stops = []; },
};
