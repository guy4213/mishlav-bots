/**
 * משימות לנציג (port of views/reps.js): who a rep should call back, by the time they asked for (overdue highlighted),
 * with a "done" button. The server pages: 50 a page (open ones by when to call; with the done ones, those come after).
 * Read every 20 s.
 */
import { useRef, useState } from "react";
import { ActionLink, Chip, EmptyState, ErrorState, LoadingState, Pager, PhoneLink } from "../components/ui";
import { get, post } from "../lib/api";
import { fmtDateTime, fmtRel } from "../lib/format";
import { useEvery } from "../lib/hooks";
import { REP_REASON_HE } from "../lib/labels";
import type { Paged, RepTask } from "../lib/types";
import { toast } from "../lib/ui-store";
import { openContact } from "./drawers";

export default function Reps() {
  const [r, setR] = useState<({ tasks: RepTask[]; total: number; open: boolean } & Paged) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const q = useRef({ showDone: false, page: 1 });
  const seq = useRef(0);
  const load = async () => {
    const mine = ++seq.current;
    try {
      const x = await get(`/api/admin/rep-tasks?open=${q.current.showDone ? 0 : 1}&page=${q.current.page}`);
      if (mine !== seq.current) return;
      q.current.page = x.page;
      setR({ ...x, open: !q.current.showDone });
      setError(null);
      setDone(new Set());
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message);
    }
  };
  useEvery(20_000, load);
  const markDone = async (id: string) => {
    setDone((s) => new Set(s).add(id));
    try {
      await post(`/api/admin/rep-tasks/${encodeURIComponent(id)}/done`);
      toast("סומן כטופל", "ok");
    } catch (err) {
      toast((err as Error).message, "bad");
    }
    void load();
  };
  const now = Date.now();
  return (
    <div className="card">
      <div className="card-head">
        <h2>משימות לנציג</h2>
        <span className="sub" id="rCount">
          {r ? (r.open ? `${r.total} פתוחות` : `${r.total} משימות`) : ""}
        </span>
        <div className="actions">
          <label className="switch">
            <input
              type="checkbox"
              id="rDone"
              onChange={(e) => {
                q.current.showDone = e.target.checked;
                q.current.page = 1;
                void load();
              }}
            />{" "}
            הצג גם משימות שטופלו
          </label>
        </div>
      </div>
      <div id="rBody">
        {error ? (
          <ErrorState msg={error} />
        ) : !r ? (
          <LoadingState rows={5} />
        ) : r.tasks.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>לחזור</th>
                  <th>שם</th>
                  <th>טלפון</th>
                  <th>סיבה</th>
                  <th>הערה</th>
                  <th>נוצרה</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {r.tasks.map((t) => {
                  const overdue = !t.done && !!t.callback_at && new Date(t.callback_at).getTime() < now;
                  return (
                    <tr key={t.id} className={overdue ? "overdue" : ""}>
                      <td className="nowrap">
                        {t.callback_at ? (
                          <>
                            <div className="cell-main">{fmtDateTime(t.callback_at)}</div>
                            <div className="cell-sub">
                              {overdue ? (
                                <>
                                  <b style={{ color: "var(--danger)" }}>באיחור</b>
                                  {" · "}
                                </>
                              ) : null}
                              {fmtRel(t.callback_at)}
                            </div>
                          </>
                        ) : (
                          <Chip label="בהקדם" tone="warning" />
                        )}
                      </td>
                      <td>
                        <ActionLink className="cell-main" onClick={() => openContact(t.gold_record_id)}>
                          {t.full_name ?? t.gold_record_id}
                        </ActionLink>
                      </td>
                      <td className="nowrap">
                        <PhoneLink p={t.phone} />
                      </td>
                      <td>{REP_REASON_HE[t.reason] ?? t.reason}</td>
                      <td className="wrap">{t.note ? t.note : <span className="faint">—</span>}</td>
                      <td className="nowrap cell-sub">{fmtDateTime(t.created_at)}</td>
                      <td>
                        {t.done ? (
                          <Chip label="טופל" tone="success" />
                        ) : (
                          <button className="btn sm success" data-done={t.id} disabled={done.has(t.id)} onClick={() => void markDone(t.id)}>
                            טופל
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="אין משימות פתוחות" text="כשהבוט מעביר לקוח לנציג, המשימה תופיע כאן." icon="tasks" />
        )}
      </div>
      <Pager
        id="rPager"
        page={r?.page ?? 1}
        pages={r?.pages ?? null}
        onGo={(p) => {
          q.current.page = p;
          void load();
        }}
      />
    </div>
  );
}
