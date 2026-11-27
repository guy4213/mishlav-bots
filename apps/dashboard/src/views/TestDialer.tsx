/**
 * בדיקות חיוג אוטומטי (admins only; port of views/test-dialer.js): the real dialer on 10 made-up TEST- contacts, all on
 * the admin's own phone - to see before launch that the queue, callbacks, the notes the bot reads and writes, and the
 * WhatsApp link really work. Server: apps/backend/src/test-dialer.ts (it dials only the phone of the admin who started
 * it). Read every 4 s.
 */
import { useState } from "react";
import { ActionLink, Chip, EmptyState, ErrorState, LoadingState, Notes, StatusChip } from "../components/ui";
import { get, post } from "../lib/api";
import { fmtDateTime, fmtRel } from "../lib/format";
import { useEvery } from "../lib/hooks";
import { DIALER_STATE_HE, REP_REASON_HE } from "../lib/labels";
import type { Contact, DialerStatus } from "../lib/types";
import { confirmDialog, toast } from "../lib/ui-store";
import { openCall } from "./drawers";

type Status = DialerStatus & { allowed_number: string | null };

const Steps = () => (
  <ol className="small" style={{ margin: 0, paddingInlineStart: 18, lineHeight: 1.7 }}>
    <li>
      <b>אפס</b> – 10 לקוחות הדמה חוזרים להתחלה, כולם על המספר שלך, כל אחד עם הערות אחרות.
    </li>
    <li>
      <b>הפעל</b> – החייגן האמיתי מתקשר אליך, לקוח אחרי לקוח, בדיוק כמו בהשקה (גם מחוץ לשעות הפעילות).
    </li>
    <li>בכל שיחה תגיד משהו אחר: "תחזרו אליי ב-12:00", "תשלחו קישור", "תעבירו לנציג", "לא מעוניין"…</li>
    <li>כאן רואים מה נכתב בהערות של כל לקוח, מתי השיחה הבאה ומה קרה – והשיחה החוזרת מגיעה בשעה שביקשת.</li>
  </ol>
);

export default function TestDialer() {
  const [r, setR] = useState<{ status: Status; contacts: Contact[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      setR(await get("/api/admin/test-dialer"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEvery(4000, load);

  const s = r?.status;
  const on = s?.enabled === true;
  const toggle = async () => {
    setBusy(true);
    try {
      await post(`/api/admin/test-dialer/${on ? "stop" : "start"}`);
      toast(on ? "הבדיקה נעצרה" : "הבדיקה התחילה – הטלפון שלך יצלצל", "ok");
    } catch (err) {
      toast((err as Error).message, "bad");
    }
    await load();
    setBusy(false);
  };
  const reset = async () => {
    const c = await confirmDialog({
      title: "לאפס את לקוחות הדמה?",
      text: "10 הלקוחות יחזרו להתחלה (הערות, מצב, תור), כולם על המספר שלך. השיחות הקודמות נשארות בהיסטוריה.",
      okLabel: "אפס",
    });
    if (!c.ok) return;
    try {
      const x = await post("/api/admin/test-dialer/reset");
      toast(`אופסו ${x.reset} לקוחות דמה`, "ok");
    } catch (err) {
      toast((err as Error).message, "bad");
    }
    await load();
  };

  return (
    <div className="stack">
      <div className="card" id="tdStatus">
        {error ? (
          <ErrorState msg={error} />
        ) : !s ? (
          <LoadingState rows={3} />
        ) : (
          <>
            <div className="card-head">
              <h2>🧪 בדיקת חיוג אוטומטי</h2>
              <span className="actions">
                {on ? (
                  <Chip label={DIALER_STATE_HE[s.state] ?? s.state} tone={s.state === "error" ? "danger" : "success"} dot />
                ) : (
                  <Chip label="כבוי" tone="muted" dot />
                )}
              </span>
            </div>
            <div className="card-body stack">
              <div className="banner info small">
                החייגן של הבדיקה רואה רק את 10 לקוחות הדמה, ומחייג <b>רק למספר שלך</b>
                {s.allowed_number ? (
                  <>
                    {" "}
                    (<span className="ltr">{s.allowed_number}</span>)
                  </>
                ) : null}
                . לקוח אמיתי לא יכול לקבל שיחה מהבדיקה.
              </div>
              <div className="row">
                <button className={`btn ${on ? "danger" : "success"}`} id="tdToggle" disabled={busy} onClick={() => void toggle()}>
                  {on ? "⏹ עצור בדיקה" : "▶ הפעל בדיקה"}
                </button>
                <button className="btn" id="tdReset" disabled={on} onClick={() => void reset()}>
                  ↺ אפס את לקוחות הדמה
                </button>
                <span className="small muted">{s.calls_today ? `${s.calls_today} שיחות בדיקה היום` : ""}</span>
              </div>
              {s.current_call ? (
                <div className="banner ok small">
                  בשיחה עכשיו: <b>{s.current_call.name ?? s.current_call.gold_record_id}</b> ·{" "}
                  <ActionLink onClick={() => openCall(s.current_call!.call_id)}>פתח את השיחה</ActionLink>
                </div>
              ) : null}
              {s.next_due ? (
                <div className="small muted">
                  הבא בתור: {s.next_due.gold_record_id}
                  {s.next_due.next_call_at ? ` · ${fmtDateTime(s.next_due.next_call_at)} (${fmtRel(s.next_due.next_call_at)})` : ""}
                </div>
              ) : null}
              {s.last_error ? <div className="banner bad small">{s.last_error.message}</div> : null}
              <Steps />
            </div>
          </>
        )}
      </div>
      <div className="card">
        <div className="card-head">
          <h2>10 לקוחות הדמה</h2>
          <span className="sub">מתעדכן כל כמה שניות</span>
        </div>
        <div id="tdContacts">
          {!r ? (
            <LoadingState rows={6} />
          ) : !r.contacts.length ? (
            <EmptyState title="אין עדיין לקוחות דמה" text='לחץ "אפס את לקוחות הדמה" כדי ליצור אותם.' icon="inbox" compact />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>לקוח</th>
                    <th>מצב</th>
                    <th>שיחה הבאה</th>
                    <th>שיחות</th>
                    <th>משימות לנציג</th>
                    <th>הערות (מה הבוט קורא וכותב)</th>
                  </tr>
                </thead>
                <tbody>
                  {r.contacts.map((c) => {
                    const st = c.bot_state ?? ({} as Partial<NonNullable<Contact["bot_state"]>>);
                    const next = st.bot_status === "callback" ? st.callback_at : st.next_call_at;
                    const tasks = (c.rep_tasks ?? []).filter((t) => !t.done);
                    return (
                      <tr key={c.gold_record_id}>
                        <td className="nowrap">
                          <div className="cell-main">{c.full_name}</div>
                          <div className="cell-sub ltr">{c.gold_record_id}</div>
                        </td>
                        <td>
                          <StatusChip s={st.bot_status} />
                          {st.last_outcome ? <div className="cell-sub">{st.last_outcome}</div> : null}
                        </td>
                        <td className="nowrap">
                          {next ? (
                            <>
                              {fmtDateTime(next)}
                              <div className="cell-sub">{fmtRel(next)}</div>
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="num">
                          {st.attempts ?? 0}
                          {st.last_call_at ? <div className="cell-sub">{fmtRel(st.last_call_at)}</div> : null}
                        </td>
                        <td>
                          {tasks.length
                            ? tasks.map((t, i) => (
                                <div key={i} className="small">
                                  {REP_REASON_HE[t.reason ?? ""] ?? t.reason}
                                  {t.note ? ` · ${t.note}` : ""}
                                </div>
                              ))
                            : "—"}
                        </td>
                        <td style={{ minWidth: 260 }}>{c.notes ? <Notes text={c.notes} /> : <span className="muted small">אין</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
