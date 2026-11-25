/**
 * לוגים (admins only; port of views/logs.js): the live log of the server this page is connected to (the phone line +
 * dialer, tools, errors, SMS), every 1.5 s, and the lines of earlier server starts from the database (faint).
 * What was read is kept across screens (coming back shows it) and forgotten at a 401 or a logout (resetLogs).
 * As the old screen, it keeps asking while the tab is in the background (listed to change after the move).
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { get } from "../lib/api";
import { fmtTimeSec } from "../lib/format";
import { useLive } from "../lib/live";
import type { LogLine } from "../lib/types";

const KINDS: [string, string][] = [
  ["line", "קו"],
  ["dialer", "חיוג"],
  ["tool", "כלים"],
  ["error", "שגיאות"],
  ["sms", "SMS"],
  ["server", "שרת"],
];
const KEEP = 3000;

// kept across screens: coming back shows what was already read.
// boot: the server start the live lines belong to; older starts are read from the database (history)
const fresh = () => ({ since: 0, lines: [] as LogLine[], kinds: new Set(KINDS.map(([k]) => k)), call: "", follow: true, paused: false, boot: null as string | null, history: false });
let S = fresh();
/** A 401 or a logout: nothing of the log stays in memory. */
export function resetLogs() {
  S = fresh();
}

// a line of the phone line -> its look (same as the old dashboard)
function sub(text: string) {
  if (/^לקוח:/.test(text)) return "s-lead";
  if (/^בוט:/.test(text)) return "s-bot";
  if (/^🔧/.test(text)) return "s-tool";
  if (/❌|error|SIP error/i.test(text)) return "s-err";
  if (/^\s+\(/.test(text)) return "s-note";
  return "";
}

export default function Logs() {
  const env = useLive().env;
  const [where] = useState(() => (env?.env === "production" ? "שרת הפרודקשן (Render)" : "השרת המקומי"));
  const [, redraw] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const draw = () => redraw((n) => n + 1);

  useEffect(() => {
    let alive = true;
    // the lines of earlier server starts (a deploy / restart), from the database, before the live ones
    const loadHistory = async () => {
      S.history = true;
      try {
        const h = await get<{ lines: LogLine[] }>(`/api/admin/logs/history?limit=1000`);
        const old = (h.lines ?? []).map((l) => ({ ...l, old: true }));
        S.lines = [...old, ...S.lines.filter((l) => !l.old)];
        if (alive) draw();
      } catch {
        // no database: the live log only
      }
    };
    const poll = async () => {
      if (S.paused) return;
      try {
        const r = await get<{ seq: number; boot: string | null; lines: LogLine[] }>(`/api/admin/logs?since=${S.since}`);
        // the server restarted (a new boot): what it logged before is in the database now
        if (r.seq < S.since || (S.boot && r.boot && r.boot !== S.boot)) {
          S.since = 0;
          S.lines = [];
          S.boot = r.boot;
          S.history = false;
          if (alive) draw();
          return loadHistory();
        }
        S.boot = r.boot;
        if (!S.history) await loadHistory();
        if (!r.lines.length) return;
        S.since = r.lines[r.lines.length - 1]!.seq;
        S.lines.push(...r.lines);
        const over = S.lines.length - KEEP;
        if (over > 0) S.lines.splice(0, over);
        if (alive) draw();
      } catch {
        // try again
      }
    };
    void poll();
    const timer = setInterval(poll, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const visible = (l: LogLine) => S.kinds.has(l.kind) && (!S.call || l.call_id === S.call);
  const shown = S.lines.filter(visible);
  // follow the end (after each drawing)
  useEffect(() => {
    if (S.follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  });
  // the calls in the log, newest first; the list is rebuilt only when a call is added (an open list would close on mobile)
  const ids = [...new Set(S.lines.map((l) => l.call_id).filter((x): x is string => !!x))].reverse();
  return (
    <>
      <div className="banner info" style={{ marginBottom: 16 }}>
        זה הלוג החי של {where} שהדף מחובר אליו. כל שורה נשמרת גם במסד הנתונים ל-14 יום, כך שאחרי פריסה או הפעלה מחדש מה שהיה לפני מופיע למעלה (באפור).
      </div>
      <div className="card">
        <div className="card-head">
          <div className="kind-toggle" id="lKinds">
            {KINDS.map(([k, l]) => (
              <button
                key={k}
                data-k={k}
                className={S.kinds.has(k) ? "on" : ""}
                onClick={() => {
                  if (S.kinds.has(k)) S.kinds.delete(k);
                  else S.kinds.add(k);
                  draw();
                }}
              >
                {l}
              </button>
            ))}
          </div>
          <div className="actions">
            <CallSelect ids={ids} onPick={draw} />
            <label className="switch">
              <input
                type="checkbox"
                id="lFollow"
                defaultChecked={S.follow}
                onChange={(e) => {
                  S.follow = e.target.checked;
                  if (S.follow && box.current) box.current.scrollTop = box.current.scrollHeight;
                }}
              />{" "}
              גלילה אוטומטית
            </label>
            <button
              className="btn sm"
              id="lPause"
              onClick={() => {
                S.paused = !S.paused;
                draw();
              }}
            >
              {S.paused ? (
                <>
                  <Icon name="play" /> המשך
                </>
              ) : (
                <>
                  <Icon name="pause" /> השהה
                </>
              )}
            </button>
            <button
              className="btn sm ghost"
              id="lClear"
              onClick={() => {
                S.lines = [];
                draw();
              }}
            >
              <Icon name="trash" /> נקה
            </button>
          </div>
        </div>
        <div className="logbox" id="lBox" ref={box}>
          {shown.length ? (
            shown.map((l) => (
              <div key={`${l.old ? "o" : "n"}${l.seq}-${l.ts}`} className={`logline k-${l.kind} ${l.kind === "line" ? sub(l.text) : ""}${l.old ? " faint" : ""}`}>
                <span className="t">{fmtTimeSec(l.ts)}</span>
                <span className="k">{l.kind}</span>
                <span className="x">{l.text.trim()}</span>
              </div>
            ))
          ) : (
            <p className="small faint" style={{ padding: "12px 16px" }}>
              עוד אין שורות בלוג
            </p>
          )}
        </div>
      </div>
    </>
  );
}

/** The calls in the log (one component for the whole screen's life: an open list isn't rebuilt under the finger). */
function CallSelect({ ids, onPick }: { ids: string[]; onPick: () => void }) {
  return (
    <select
      id="lCall"
      style={{ width: "auto" }}
      value={S.call}
      onChange={(e) => {
        S.call = e.target.value;
        onPick();
      }}
    >
      <option value="">כל השיחות</option>
      {ids.map((id) => {
        const first = S.lines.find((l) => l.call_id === id);
        return (
          <option key={id} value={id}>
            {fmtTimeSec(first?.ts)} · {id.slice(-6)}
          </option>
        );
      })}
    </select>
  );
}
