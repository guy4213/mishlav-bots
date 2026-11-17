// לוגים: the live log of the server this page is connected to (the phone line + dialer, tools, errors, SMS).
import { get } from "../api.js";
import { live } from "../live.js";
import { esc, fmtTimeSec, icon } from "../ui.js";

const KINDS = [["line", "קו"], ["dialer", "חיוג"], ["tool", "כלים"], ["error", "שגיאות"], ["sms", "SMS"]];
const KEEP = 3000;
// kept across screens: coming back shows what was already read
const S = { since: 0, lines: [], kinds: new Set(KINDS.map(([k]) => k)), call: "", follow: true, paused: false };
let timer = null;

// a line of the phone line -> its look (same as the old dashboard)
function sub(text) {
  if (/^לקוח:/.test(text)) return "s-lead";
  if (/^בוט:/.test(text)) return "s-bot";
  if (/^🔧/.test(text)) return "s-tool";
  if (/❌|error|SIP error/i.test(text)) return "s-err";
  if (/^\s+\(/.test(text)) return "s-note";
  return "";
}
const visible = (l) => S.kinds.has(l.kind) && (!S.call || l.call_id === S.call);
const lineHtml = (l) =>
  `<div class="logline k-${l.kind} ${l.kind === "line" ? sub(l.text) : ""}"><span class="t">${esc(fmtTimeSec(l.ts))}</span><span class="k">${esc(l.kind)}</span><span class="x">${esc(l.text.trim())}</span></div>`;

export default {
  id: "logs",
  title: "לוגים",
  icon: "logs",
  mount(root) {
    const where = live.env?.env === "production" ? "שרת הפרודקשן (Render)" : "השרת המקומי";
    root.innerHTML = `
      <div class="banner info" style="margin-bottom:16px">זה הלוג החי של ${where} שהדף מחובר אליו. הוא נשמר בזיכרון בלבד ומתאפס בכל הפעלה מחדש או פריסה.</div>
      <div class="card">
        <div class="card-head">
          <div class="kind-toggle" id="lKinds">${KINDS.map(([k, l]) => `<button data-k="${k}" class="${S.kinds.has(k) ? "on" : ""}">${l}</button>`).join("")}</div>
          <div class="actions">
            <select id="lCall" style="width:auto"><option value="">כל השיחות</option></select>
            <label class="switch"><input type="checkbox" id="lFollow" ${S.follow ? "checked" : ""}> גלילה אוטומטית</label>
            <button class="btn sm" id="lPause">${S.paused ? `${icon("play")} המשך` : `${icon("pause")} השהה`}</button>
            <button class="btn sm ghost" id="lClear">${icon("trash")} נקה</button>
          </div>
        </div>
        <div class="logbox" id="lBox"></div>
      </div>`;
    const box = root.querySelector("#lBox");
    const sel = root.querySelector("#lCall");
    let idsKey = "";
    const renderCalls = () => {
      const ids = [...new Set(S.lines.map((l) => l.call_id).filter(Boolean))].reverse();
      if (ids.join() === idsKey) return; // rebuilt only when a call is added (an open list would close on mobile)
      idsKey = ids.join();
      sel.innerHTML = `<option value="">כל השיחות</option>` + ids.map((id) => {
        const first = S.lines.find((l) => l.call_id === id);
        return `<option value="${esc(id)}" ${id === S.call ? "selected" : ""}>${esc(fmtTimeSec(first.ts))} · ${esc(id.slice(-6))}</option>`;
      }).join("");
    };
    const renderAll = () => {
      const shown = S.lines.filter(visible);
      box.innerHTML = shown.length ? shown.map(lineHtml).join("") : `<p class="small faint" style="padding:12px 16px">עוד אין שורות בלוג</p>`;
      if (S.follow) box.scrollTop = box.scrollHeight;
    };
    const poll = async () => {
      if (S.paused) return;
      try {
        const r = await get(`/api/admin/logs?since=${S.since}`);
        if (r.seq < S.since) { S.since = 0; S.lines = []; return renderAll(); } // the server restarted
        if (!r.lines.length) return;
        S.since = r.lines[r.lines.length - 1].seq;
        S.lines.push(...r.lines);
        const over = S.lines.length - KEEP;
        if (over > 0) S.lines.splice(0, over);
        const add = r.lines.filter(visible);
        if (over > 0 || box.querySelector("p")) renderAll();
        else if (add.length) {
          box.insertAdjacentHTML("beforeend", add.map(lineHtml).join(""));
          if (S.follow) box.scrollTop = box.scrollHeight;
        }
        renderCalls();
      } catch { /* try again */ }
    };
    root.querySelector("#lKinds").onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      S.kinds.has(b.dataset.k) ? S.kinds.delete(b.dataset.k) : S.kinds.add(b.dataset.k);
      b.classList.toggle("on");
      renderAll();
    };
    sel.onchange = () => { S.call = sel.value; renderAll(); };
    root.querySelector("#lFollow").onchange = (e) => { S.follow = e.target.checked; if (S.follow) box.scrollTop = box.scrollHeight; };
    root.querySelector("#lPause").onclick = (e) => {
      S.paused = !S.paused;
      e.currentTarget.innerHTML = S.paused ? `${icon("play")} המשך` : `${icon("pause")} השהה`;
    };
    root.querySelector("#lClear").onclick = () => { S.lines = []; idsKey = ""; renderAll(); renderCalls(); };
    renderAll();
    renderCalls();
    poll();
    timer = setInterval(poll, 1500);
  },
  unmount() { clearInterval(timer); },
};
