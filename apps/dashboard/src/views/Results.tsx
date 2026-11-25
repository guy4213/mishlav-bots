/**
 * התקדמות ותוצאות (admins only; port of views/results.js): the latest automatic result of every scenario (provider C,
 * the phone line) and the test history. Read every 30 s.
 */
import { Fragment, useState } from "react";
import { Chip, EmptyState, ErrorState, LoadingState } from "../components/ui";
import { get } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { useEvery } from "../lib/hooks";
import { TRI_HE, outcomeLabel } from "../lib/labels";
import type { Scenario } from "../lib/types";

const TONE: Record<string, string> = { PASS: "success", FAIL: "danger", PENDING: "warning", NONE: "muted" };
const COLOR: Record<string, string> = { PASS: "--success", FAIL: "--danger", PENDING: "--warning", NONE: "--border-strong" };
const group = (id: string) => (id.startsWith("S") ? "core" : id.startsWith("X") ? "adversarial" : "real");
const GROUPS: [string, string][] = [
  ["core", "תרחישי ליבה"],
  ["adversarial", "ניסיונות להכשיל"],
  ["real", "משיחות אמיתיות"],
];

interface Session {
  session_id: string;
  provider: string;
  scenario: string;
  started_at: string;
  expected: string | string[] | null;
  inferred: string | string[] | null;
  understanding: string;
  reasons?: string[];
  avg_latency_ms: number | null;
  channel?: string | null;
}

export default function Results() {
  const [data, setData] = useState<{ scenarios: Scenario[]; sessions: Session[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEvery(30_000, async () => {
    try {
      const [ov, rep] = await Promise.all([get<{ scenarios: Scenario[] }>("/test/overview"), get<{ sessions: Session[] }>("/test/report")]);
      const sessions = rep.sessions.filter((s) => s.provider === "C").sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
      setData({ scenarios: ov.scenarios, sessions });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  });
  if (error)
    return (
      <div id="resBody">
        <div className="card">
          <ErrorState msg={error} />
        </div>
      </div>
    );
  if (!data)
    return (
      <div id="resBody">
        <LoadingState rows={6} />
      </div>
    );
  const { scenarios, sessions } = data;
  const latest = new Map<string, Session>();
  for (const s of sessions) if (!latest.has(s.scenario)) latest.set(s.scenario, s);
  const passed = scenarios.filter((s) => latest.get(s.id)?.understanding === "PASS").length;
  const tile = (sc: Scenario) => {
    const r = latest.get(sc.id);
    const st = r?.understanding ?? "NONE";
    return (
      <div key={sc.id} className="tile" style={{ ["--tile-c" as string]: `var(${COLOR[st] ?? "--border-strong"})` }}>
        <div className="tile-head">
          <span className="tile-id">{sc.id}</span>
          <span className="spacer" />
          <Chip label={TRI_HE[st] ?? st} tone={TONE[st] ?? "muted"} />
        </div>
        <div className="tile-name">{sc.guide?.title ?? sc.name}</div>
        <div className="tile-meta">צפוי: {outcomeLabel(sc.expected_outcome)}</div>
        {r ? (
          <div className="tile-meta">
            {fmtDateTime(r.started_at)} · זוהה: {outcomeLabel(r.inferred)}
          </div>
        ) : null}
      </div>
    );
  };
  return (
    <div id="resBody">
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h2>תרחישים</h2>
          <span className="sub">
            {passed} מתוך {scenarios.length} עברו בבדיקה האחרונה · ציון אוטומטי לפי הכלים והתוצאה
          </span>
        </div>
        <div className="card-body">
          {GROUPS.map(([g, title]) => {
            const list = scenarios.filter((s) => group(s.id) === g);
            return list.length ? (
              <Fragment key={g}>
                <div className="group-title">{title}</div>
                <div className="tiles">{list.map(tile)}</div>
              </Fragment>
            ) : null;
          })}
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>היסטוריית בדיקות</h2>
          <span className="sub">{sessions.length} בדיקות</span>
        </div>
        {sessions.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>מתי</th>
                  <th>תרחיש</th>
                  <th>צפוי</th>
                  <th>זוהה</th>
                  <th>תוצאה</th>
                  <th>זמן תגובה ממוצע</th>
                  <th>ערוץ</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.session_id}>
                    <td className="nowrap">{fmtDateTime(s.started_at)}</td>
                    <td>
                      <b className="ltr">{s.scenario}</b>
                    </td>
                    <td>{outcomeLabel(s.expected)}</td>
                    <td>{outcomeLabel(s.inferred)}</td>
                    <td>
                      <Chip label={TRI_HE[s.understanding] ?? s.understanding} tone={TONE[s.understanding] ?? "muted"} />
                      {s.reasons?.length ? <div className="cell-sub">{s.reasons.join(" · ")}</div> : null}
                    </td>
                    <td className="num nowrap">{s.avg_latency_ms ? `${s.avg_latency_ms} ms` : "—"}</td>
                    <td className="cell-sub">{s.channel ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="עוד אין בדיקות" text='בדיקה מהמסך "בדיקות" עם תרחיש תופיע כאן.' />
        )}
      </div>
    </div>
  );
}
