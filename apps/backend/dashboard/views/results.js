// התקדמות ותוצאות: the latest automatic result of every scenario (provider C, the phone line) and the test history.
import { get } from "../api.js";
import { chip, emptyState, errorState, esc, every, fmtDateTime, loadingState, outcomeLabel, TRI_HE } from "../ui.js";

const TONE = { PASS: "success", FAIL: "danger", PENDING: "warning", NONE: "muted" };
const COLOR = { PASS: "--success", FAIL: "--danger", PENDING: "--warning", NONE: "--border-strong" };
let stopPoll = null;

const group = (id) => (id.startsWith("S") ? "core" : id.startsWith("X") ? "adversarial" : "real");
const GROUPS = [["core", "תרחישי ליבה"], ["adversarial", "ניסיונות להכשיל"], ["real", "משיחות אמיתיות"]];

export default {
  id: "results",
  title: "התקדמות ותוצאות",
  icon: "chart",
  mount(root) {
    root.innerHTML = `<div id="resBody">${loadingState(6)}</div>`;
    const body = root.querySelector("#resBody");
    const load = async () => {
      try {
        const [ov, rep] = await Promise.all([get("/test/overview"), get("/test/report")]);
        const sessions = rep.sessions.filter((s) => s.provider === "C").sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
        const latest = new Map();
        for (const s of sessions) if (!latest.has(s.scenario)) latest.set(s.scenario, s);
        const passed = ov.scenarios.filter((s) => latest.get(s.id)?.understanding === "PASS").length;
        const tile = (sc) => {
          const r = latest.get(sc.id);
          const st = r?.understanding ?? "NONE";
          return `<div class="tile" style="--tile-c:var(${COLOR[st] ?? "--border-strong"})">
            <div class="tile-head"><span class="tile-id">${esc(sc.id)}</span><span class="spacer"></span>${chip(TRI_HE[st] ?? st, TONE[st] ?? "muted")}</div>
            <div class="tile-name">${esc(sc.guide?.title ?? sc.name)}</div>
            <div class="tile-meta">צפוי: ${esc(outcomeLabel(sc.expected_outcome))}</div>
            ${r ? `<div class="tile-meta">${esc(fmtDateTime(r.started_at))} · זוהה: ${esc(outcomeLabel(r.inferred))}</div>` : ""}
          </div>`;
        };
        body.innerHTML = `
          <div class="card" style="margin-bottom:16px"><div class="card-head"><h2>תרחישים</h2><span class="sub">${passed} מתוך ${ov.scenarios.length} עברו בבדיקה האחרונה · ציון אוטומטי לפי הכלים והתוצאה</span></div>
            <div class="card-body">${GROUPS.map(([g, title]) => {
              const list = ov.scenarios.filter((s) => group(s.id) === g);
              return list.length ? `<div class="group-title">${title}</div><div class="tiles">${list.map(tile).join("")}</div>` : "";
            }).join("")}</div></div>
          <div class="card"><div class="card-head"><h2>היסטוריית בדיקות</h2><span class="sub">${sessions.length} בדיקות</span></div>
            ${sessions.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>מתי</th><th>תרחיש</th><th>צפוי</th><th>זוהה</th><th>תוצאה</th><th>זמן תגובה ממוצע</th><th>ערוץ</th></tr></thead><tbody>${sessions
              .map((s) => `<tr>
                <td class="nowrap">${esc(fmtDateTime(s.started_at))}</td>
                <td><b class="ltr">${esc(s.scenario)}</b></td>
                <td>${esc(outcomeLabel(s.expected))}</td>
                <td>${esc(outcomeLabel(s.inferred))}</td>
                <td>${chip(TRI_HE[s.understanding] ?? s.understanding, TONE[s.understanding] ?? "muted")}${s.reasons?.length ? `<div class="cell-sub">${esc(s.reasons.join(" · "))}</div>` : ""}</td>
                <td class="num nowrap">${s.avg_latency_ms ? `${s.avg_latency_ms} ms` : "—"}</td>
                <td class="cell-sub">${esc(s.channel ?? "")}</td>
              </tr>`)
              .join("")}</tbody></table></div>` : emptyState("עוד אין בדיקות", "בדיקה מהמסך \"בדיקות\" עם תרחיש תופיע כאן.")}
          </div>`;
      } catch (e) { body.innerHTML = `<div class="card">${errorState(e.message)}</div>`; }
    };
    stopPoll = every(30_000, load);
  },
  unmount() { stopPoll?.(); },
};
