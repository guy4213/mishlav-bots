/**
 * שיחות (port of views/calls.js): every call (the dialer's, the tests - also to a typed number, "שיחה אליי" - and
 * incoming ones), the live one pinned on top; each row says who and which phone, and plays its recording right there.
 * The server pages and filters (the origin, only with a recording): 50 a page, newest first; read every 15 s.
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { CallOriginChip, Chip, EmptyState, ErrorState, LoadingState, OutcomeChip, Pager, callName } from "../components/ui";
import { get } from "../lib/api";
import { fmtDateTime, fmtDuration, fmtPhone, fmtRel } from "../lib/format";
import { useEvery } from "../lib/hooks";
import { REASON_HE } from "../lib/labels";
import { liveCall, subscribeLive, useLive } from "../lib/live";
import { safeUrl } from "../lib/safe-url";
import { KEYS, ls } from "../lib/storage";
import type { CallRow, Paged } from "../lib/types";
import { openCall } from "./drawers";

const ORIGINS: [string, string][] = [
  ["all", "הכול"],
  ["dialer", "אוטומטי"],
  ["manual", "🧪 בדיקה"],
];

/** The phone under the name: the number the call was on (older calls: the contact's record id). */
const phoneLine = (c: CallRow) => (c.number ? fmtPhone(c.number) : (c.gold_record_id ?? ""));

/** A recording's link is valid for an hour: asked for only when someone presses play. */
const recordingUrl = async (callId: string) => (await get(`/api/admin/calls/${encodeURIComponent(callId)}/recording`)).url as unknown;

function LiveBanner() {
  const c = liveCall(useLive());
  if (!c) return null;
  const secs = (Date.now() - new Date(c.started_at).getTime()) / 1000;
  return (
    <div className="card" style={{ marginBottom: 16, borderColor: "color-mix(in srgb,var(--live) 45%,var(--border))" }}>
      <div className="card-body row">
        <Chip label="שיחה חיה" tone="live" dot cls="pulse" />
        <b>{c.name ?? c.number}</b>
        <span className="muted small">
          {c.direction === "out" ? "יוצאת" : "נכנסת"} · {c.origin === "dialer" ? "אוטומטי" : "🧪 בדיקה"}
          {c.scenario ? ` · תרחיש ${c.scenario}` : ""} · <span className="num">{fmtDuration(secs)}</span>
        </span>
        <span className="spacer" />
        <button className="btn primary sm" data-open={c.id} onClick={() => openCall(c.id)}>
          פתח את השיחה
        </button>
      </div>
    </div>
  );
}

type Player = { call: CallRow; url: string } | { error: string } | null;

export default function Calls() {
  const [origin, setOrigin] = useState(() => ls.get(KEYS.callsOrigin, "all"));
  // as the old screen: the saved value is a string, so "false" reads as on (listed to fix after the move)
  const [recOnly, setRecOnly] = useState<boolean | string>(() => ls.get(KEYS.callsRecOnly, false));
  const [calls, setCalls] = useState<CallRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [paging, setPaging] = useState<{ page: number; pages: number } | null>(null);
  const [player, setPlayer] = useState<Player>(null);
  const [playing, setPlaying] = useState<string | null>(null); // the call whose recording plays now (not paused)
  const [busy, setBusy] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const q = useRef({ origin, recOnly, page: 1 }); // the newest calls are on page 1 (where a call that just ended appears)
  const seq = useRef(0);

  const load = async () => {
    const mine = ++seq.current;
    const { origin: o, recOnly: rec, page } = q.current;
    try {
      const r = await get<{ calls: CallRow[]; total: number } & Paged>(`/api/admin/calls?origin=${o}&page=${page}${rec ? "&recorded=1" : ""}`);
      if (mine !== seq.current) return;
      setCalls(r.calls);
      setTotal(r.total);
      setError(null);
      q.current.page = r.page;
      setPaging({ page: r.page, pages: r.pages });
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message);
    }
  };
  const reload = () => {
    setCalls(null);
    setError(null);
    void load();
  };
  useEvery(15_000, load);

  // the live call on top; when one ends, the list picks it up
  useEffect(() => {
    let wasLive: string | null = null;
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = subscribeLive((s) => {
      const c = liveCall(s);
      if (wasLive && !c) t = setTimeout(() => void load(), 1500);
      wasLive = c?.id ?? null;
    });
    return () => {
      off();
      if (t) clearTimeout(t);
      audio.current?.pause();
    };
  }, []);

  const play = async (c: CallRow) => {
    const a = audio.current;
    if (player && "call" in player && player.call.call_id === c.call_id && a) {
      if (a.paused) void a.play();
      else a.pause();
      return;
    }
    setBusy(c.call_id);
    try {
      const url = safeUrl(await recordingUrl(c.call_id), ["https:"]);
      if (!url) throw new Error("קישור ההקלטה לא תקין");
      setPlaying(null);
      setPlayer({ call: c, url });
    } catch (e) {
      setPlayer({ error: (e as Error).message });
      setPlaying(null);
    } finally {
      setBusy(null);
    }
  };
  const closePlayer = () => {
    audio.current?.pause();
    setPlayer(null);
    setPlaying(null);
  };

  const pc = player && "call" in player ? player.call : null;
  return (
    <>
      <div id="callsLive">
        <LiveBanner />
      </div>
      <div className="card">
        <div className="card-head">
          <h2>היסטוריית שיחות</h2>
          <span className="sub" id="callsCount">
            {total === null ? "" : `${total.toLocaleString("he-IL")} שיחות${recOnly ? " עם הקלטה" : ""}`}
          </span>
          <div className="actions">
            <button
              className={`btn sm${recOnly ? " on" : ""}`}
              id="callsRecOnly"
              aria-pressed={String(recOnly) as "true" | "false"}
              onClick={() => {
                const next = !recOnly;
                ls.set(KEYS.callsRecOnly, next);
                setRecOnly(next);
                q.current.recOnly = next;
                q.current.page = 1;
                reload();
              }}
            >
              <Icon name="play" />
              <span>רק עם הקלטה</span>
            </button>
            <div className="seg" id="callsOrigin">
              {ORIGINS.map(([v, l]) => (
                <button
                  key={v}
                  data-v={v}
                  className={v === origin ? "on" : ""}
                  onClick={() => {
                    ls.set(KEYS.callsOrigin, v);
                    setOrigin(v);
                    q.current.origin = v;
                    q.current.page = 1;
                    reload();
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
            <button className="icon-btn" id="callsRefresh" title="רענון" onClick={() => void load()}>
              <Icon name="refresh" />
            </button>
          </div>
        </div>
        <div id="callsPlayer">
          {pc && player && "url" in player ? (
            <div className="player-bar">
              <span className="player-ic">
                <Icon name="play" />
              </span>
              <div className="player-who">
                <div className="cell-main">
                  {callName(pc)} <span className="ltr faint">{phoneLine(pc)}</span>
                </div>
                <div className="cell-sub">
                  {fmtDateTime(pc.started_at)} · {fmtDuration(pc.duration_sec)}
                </div>
              </div>
              <audio
                ref={audio}
                controls
                autoPlay
                preload="auto"
                src={player.url}
                onPlay={() => setPlaying(pc.call_id)}
                onPause={() => setPlaying(null)}
              />
              <button className="icon-btn" data-player-close="" title="סגור" onClick={closePlayer}>
                <Icon name="x" />
              </button>
            </div>
          ) : player && "error" in player ? (
            <div className="banner bad small" style={{ margin: "10px 16px" }}>
              {player.error}
            </div>
          ) : null}
        </div>
        <div id="callsBody">
          {error ? (
            <ErrorState msg={error} />
          ) : !calls ? (
            <LoadingState rows={6} />
          ) : recOnly && !calls.length ? (
            <EmptyState title="אין הקלטות" text="שיחות שענו בהן נשמרות עם הקלטה, גם שיחות בדיקה." icon="phone" />
          ) : !calls.length ? (
            <EmptyState title="אין שיחות עדיין" text="שיחות של החיוג האוטומטי ושל הבדיקות יופיעו כאן." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>מתי</th>
                    <th>לקוח</th>
                    <th>הקלטה</th>
                    <th>משך</th>
                    <th>עלות AI</th>
                    <th>תוצאה</th>
                    <th>מקור</th>
                    <th>ענה</th>
                  </tr>
                </thead>
                <tbody>
                  {calls.map((c) => {
                    const on = playing === c.call_id;
                    return (
                      <tr key={c.call_id} className="click" data-open={c.call_id} onClick={() => openCall(c.call_id)}>
                        <td className="nowrap">
                          <div className="cell-main">{fmtDateTime(c.started_at)}</div>
                          <div className="cell-sub">{fmtRel(c.started_at)}</div>
                        </td>
                        <td>
                          <div className="cell-main">{callName(c)}</div>
                          <div className="cell-sub ltr nowrap">{phoneLine(c)}</div>
                        </td>
                        <td className="nowrap">
                          {c.recording_path ? (
                            <button
                              className={`btn sm rec-btn${on ? " on" : ""}`}
                              data-play={c.call_id}
                              title={on ? "עצור" : "השמע את ההקלטה"}
                              disabled={busy === c.call_id}
                              onClick={(e) => {
                                e.stopPropagation(); // plays here, without opening the call
                                void play(c);
                              }}
                            >
                              <Icon name={on ? "pause" : "play"} />
                              <span>{on ? "מתנגן" : "השמע"}</span>
                            </button>
                          ) : (
                            <span className="faint">—</span>
                          )}
                        </td>
                        <td className="num nowrap">{fmtDuration(c.duration_sec)}</td>
                        <td className="num nowrap">{c.ai_cost_usd === null || c.ai_cost_usd === undefined ? "—" : `$${Number(c.ai_cost_usd).toFixed(3)}`}</td>
                        <td>
                          <OutcomeChip o={c.outcome} />
                          {c.reason && c.reason.toUpperCase() !== c.outcome ? (
                            <>
                              {" "}
                              <span className="cell-sub">{REASON_HE[c.reason] ?? c.reason}</span>
                            </>
                          ) : null}
                        </td>
                        <td>
                          <CallOriginChip c={c} />
                          {c.scenario ? (
                            <>
                              {" "}
                              <span className="cell-sub">תרחיש {c.scenario}</span>
                            </>
                          ) : null}
                        </td>
                        <td>{c.answered ? <Chip label="ענה" tone="success" /> : <Chip label="לא ענה" tone="muted" />}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <Pager
          id="callsPager"
          page={paging?.page ?? 1}
          pages={paging?.pages ?? null}
          onGo={(p) => {
            q.current.page = p;
            reload();
          }}
        />
      </div>
    </>
  );
}
