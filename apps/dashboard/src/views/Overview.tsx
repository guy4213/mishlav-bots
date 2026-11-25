/**
 * סקירה: today's numbers (dialer calls only), the contacts' funnel, the queue, rep tasks, the dialer and the live call
 * (port of views/overview.js). The summary every 20 s; the live call's transcript every 1.5 s while there is one.
 * The daily limit and the bot's voice are ours (admins only): not shown to Mishlav's users nor in "view as Mishlav",
 * and their requests are never sent for them.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Conversation, conversationSize } from "../components/Conversation";
import { ActionLink, Chip, EmptyState, ErrorState, LoadingState, StatusChip } from "../components/ui";
import { get, isAdmin, post } from "../lib/api";
import { fmtDateTime, fmtDuration, fmtRel } from "../lib/format";
import { useEvery, useFollowing } from "../lib/hooks";
import { CONTACT_STATUS_HE, DIALER_STATE_HE, statusTone } from "../lib/labels";
import { type LiveState, liveCall, useLive } from "../lib/live";
import type { CallDetail, Summary } from "../lib/types";
import { toast } from "../lib/ui-store";
import { openCall, openContact } from "./drawers";

/** The pilot's daily limit: at most N automatic calls a day. Read once: typing isn't lost to the live refresh. */
function LimitCard() {
  const [d, setD] = useState<{ daily_limit: number | null } | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    get("/api/admin/dialer")
      .then((r) => setD(r.dialer))
      .catch((e: Error) => setError(e.message));
  }, []);
  const head = (
    <div className="card-head">
      <h2>מגבלת שיחות יומית (פיילוט)</h2>
    </div>
  );
  if (error) return <div className="card" id="ovLimitCard">{head}<ErrorState msg={error} compact /></div>;
  if (d === undefined) return <div className="card" id="ovLimitCard" />;
  const save = async () => {
    const raw = input.current?.value.trim() ?? "";
    const daily_limit = raw ? Number(raw) : null;
    setBusy(true);
    try {
      await post("/api/admin/dialer/limit", { daily_limit });
      toast(daily_limit ? `נשמר: עד ${daily_limit} שיחות ביום` : "נשמר: בלי מגבלה", "ok");
    } catch (err) {
      toast((err as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" id="ovLimitCard">
      {head}
      <div className="card-body stack">
        <label className="field full">
          כמה שיחות אוטומטיות ביום, לכל היותר
          <input type="number" id="ovLimit" min="1" max="1000" placeholder="בלי מגבלה" defaultValue={d?.daily_limit ?? ""} ref={input} />
        </label>
        <div className="row">
          <button className="btn primary sm" id="ovLimitSave" disabled={busy} onClick={() => void save()}>
            שמירה
          </button>
          <span className="small muted">כשמגיעים למספר, החיוג נעצר עד מחר. ריק = בלי מגבלה. שיחות בדיקה לא נספרות.</span>
        </div>
      </div>
    </div>
  );
}

/** קול הבוט: the team picks the voice for every call; it is kept in Supabase and used from the next call. */
function VoiceCard() {
  const [r, setR] = useState<{ voice: string | null; voices: string[]; labels?: Record<string, string>; server_voice: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sel = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    get("/api/admin/voice")
      .then(setR)
      .catch((e: Error) => setError(e.message));
  }, []);
  const head = (
    <div className="card-head">
      <h2>קול הבוט</h2>
    </div>
  );
  if (error) return <div className="card" id="ovVoice">{head}<ErrorState msg={error} compact /></div>;
  if (!r) return <div className="card" id="ovVoice" />;
  const save = async () => {
    const voice = sel.current?.value || null;
    setBusy(true);
    try {
      await post("/api/admin/voice", { voice });
      toast(`הקול נשמר: ${voice ?? "ברירת המחדל של השרת"}`, "ok");
    } catch (err) {
      toast((err as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" id="ovVoice">
      {head}
      <div className="card-body stack">
        <label className="field full">
          הקול בכל השיחות{" "}
          <select id="ovVoiceSel" defaultValue={r.voice ?? ""} ref={sel}>
            <option value="">ברירת המחדל של השרת ({r.server_voice})</option>
            {r.voices.map((v) => (
              <option key={v} value={v}>
                {v} – {r.labels?.[v] ?? ""}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <button className="btn primary sm" id="ovVoiceSave" disabled={busy} onClick={() => void save()}>
            שמירה
          </button>
          <span className="small muted">חל מהשיחה הבאה. לשמוע קול לפני שבוחרים: שיחת בדיקה במסך "בדיקות".</span>
        </div>
      </div>
    </div>
  );
}

function Kpis({ s }: { s: Summary }) {
  const t = s.today;
  const o = t.outcomes ?? {};
  const pct = t.total ? Math.round((t.answered / t.total) * 100) : 0;
  const tile = (label: string, value: number, color: string, sub: ReactNode = "") => (
    <div className="kpi" style={{ ["--kpi-c" as string]: `var(${color})` }}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub || " "}</div>
    </div>
  );
  return (
    <div className="kpis">
      {tile("שיחות היום", t.total, "--info", t.manual_total ? `ועוד ${t.manual_total} שיחות בדיקה (לא נספרות)` : "שיחות החיוג האוטומטי")}
      {tile("ענו", t.answered, "--teal", t.total ? `${pct}% מהשיחות` : "")}
      {tile("נשלחו קישורים", o.LINK_SENT ?? 0, "--success")}
      {tile("לידים חמים", o.HOT_LEAD ?? 0, "--warning", o.COMPANY ? `ועוד ${o.COMPANY} דרך החברה` : "")}
      {tile("שיחות חוזרות", o.CALLBACK ?? 0, "--violet")}
      {tile("הסרות", o.DO_NOT_CALL ?? 0, "--danger")}
    </div>
  );
}

const PARTS: [keyof Summary["funnel"], string, string][] = [
  ["new", "חדשים", "--info"],
  ["in_queue", "בתור / בתהליך", "--violet"],
  ["handled", "בטיפול (קישור, נציג)", "--success"],
  ["closed", "הסתיימו", "--muted"],
];

function Funnel({ s }: { s: Summary }) {
  const f = s.funnel;
  const total = PARTS.reduce((a, [k]) => a + Number(f[k] ?? 0), 0) || 1;
  const statuses = Object.entries(s.by_status ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className="card">
      <div className="card-head">
        <h2>משפך הלקוחות</h2>
        <span className="sub">{s.contacts_total} לקוחות</span>
      </div>
      <div className="card-body">
        <div className="funnel-bar">
          {PARTS.map(([k, , c]) => (f[k] ? <span key={k} style={{ flex: f[k], background: `var(${c})` }} title={String(f[k])} /> : null))}
        </div>
        <div className="funnel-legend">
          {PARTS.map(([k, l, c]) => (
            <div key={k}>
              <div className="lbl">
                <span className="sw" style={{ background: `var(${c})` }} />
                {l}
              </div>
              <div className="val">{f[k] ?? 0}</div>
              <div className="small faint">{Math.round(((f[k] ?? 0) / total) * 100)}%</div>
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 16 }}>
          {statuses.map(([k, n]) => (
            <span key={k} className={`chip t-${statusTone(k)}`}>
              {CONTACT_STATUS_HE[k] ?? k} · {n}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Queue({ s }: { s: Summary }) {
  const now = Date.now();
  const items = s.next_due ?? [];
  return (
    <div className="card">
      <div className="card-head">
        <h2>התור</h2>
        <span className="sub">{s.due_now} מחכים לחיוג עכשיו</span>
      </div>
      {items.length ? (
        <ul className="list">
          {items.map((q) => {
            const due = !q.next_call_at || new Date(q.next_call_at).getTime() <= now;
            return (
              <li key={q.gold_record_id} className="click" data-contact={q.gold_record_id} onClick={() => openContact(q.gold_record_id)}>
                <div className="grow">
                  <div className="cell-main">{q.full_name ?? q.gold_record_id}</div>
                  <div className="cell-sub">{due ? "עכשיו בתור" : `${fmtDateTime(q.next_call_at)} · ${fmtRel(q.next_call_at)}`}</div>
                </div>
                <StatusChip s={q.bot_status} />
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState title="התור ריק" text="אין לקוחות שמחכים לחיוג." icon="inbox" compact />
      )}
    </div>
  );
}

function DialerCard({ live }: { live: LiveState }) {
  const head = (extra?: ReactNode) => (
    <div className="card-head">
      <h2>חיוג אוטומטי</h2>
      {extra}
    </div>
  );
  if (!live.dialerAvailable)
    return (
      <div className="card">
        {head()}
        <EmptyState title="לא זמין" text="Supabase לא מחובר בשרת הזה." icon="alert" compact />
      </div>
    );
  const d = live.dialer;
  if (!d)
    return (
      <div className="card">
        {head()}
        <LoadingState rows={3} />
      </div>
    );
  const on = d.enabled === true;
  return (
    <div className="card">
      {head(
        <span className="actions">
          {on ? (
            <Chip label={DIALER_STATE_HE[d.state] ?? d.state} tone={d.state === "error" ? "danger" : "success"} dot />
          ) : (
            <Chip label="כבוי" tone="muted" dot />
          )}
        </span>,
      )}
      <div className="card-body">
        <dl className="kv">
          <dt>שיחות היום</dt>
          <dd className="num">
            {d.calls_today}
            {d.daily_limit ? ` / ${d.daily_limit} (מגבלה יומית)` : null}
          </dd>
          {d.reason ? (
            <>
              <dt>סיבה</dt>
              <dd>{d.reason}</dd>
            </>
          ) : null}
          {d.changed_at ? (
            <>
              <dt>שונה</dt>
              <dd>{fmtDateTime(d.changed_at)}</dd>
            </>
          ) : null}
          {d.next_due ? (
            <>
              <dt>הבא בתור</dt>
              <dd>
                <ActionLink className="ltr" onClick={() => openContact(d.next_due!.gold_record_id)}>
                  {d.next_due.gold_record_id}
                </ActionLink>
                {d.next_due.next_call_at ? ` · ${fmtRel(d.next_due.next_call_at)}` : null}
              </dd>
            </>
          ) : null}
          {d.only_numbers ? (
            <>
              <dt>הגבלה</dt>
              <dd>
                רק מספרים ב-<code>DIALER_ONLY_NUMBERS</code>
              </dd>
            </>
          ) : null}
          {d.last_error ? (
            <>
              <dt>תקלה אחרונה</dt>
              <dd style={{ color: "var(--danger)" }}>
                {d.last_error.message} <span className="faint">({fmtRel(d.last_error.at)})</span>
              </dd>
            </>
          ) : null}
          {d.failures ? (
            <>
              <dt>תקלות ברצף</dt>
              <dd>{d.failures} / 3</dd>
            </>
          ) : null}
        </dl>
      </div>
    </div>
  );
}

/** The live call: its transcript every 1.5 s while it is on (the same read as the call's drawer). */
function LiveConvo({ callId }: { callId: string }) {
  const [r, setR] = useState<CallDetail | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEvery(1500, async () => {
    try {
      setR(await get<CallDetail>(`/api/admin/calls/${encodeURIComponent(callId)}`));
    } catch {
      // not on disk yet
    }
  });
  useFollowing(box, r);
  return (
    <div className="convo scroll" id="ovConvo" ref={box}>
      {r && conversationSize(r.transcript, r.tools) ? (
        <Conversation lines={r.transcript} tools={r.tools} />
      ) : (
        <p className="small faint">מחכה שיענו…</p>
      )}
    </div>
  );
}

function LiveCard({ live }: { live: LiveState }) {
  const c = liveCall(live);
  // the idle text is written when the card turns idle (as the old one: it doesn't follow the switch meanwhile)
  const idleText = useRef<string | null>(null);
  if (!c && idleText.current === null) idleText.current = live.dialer?.enabled ? "החיוג האוטומטי פועל: שיחה הבאה תופיע כאן עם התמלול." : "החיוג האוטומטי כבוי.";
  if (c) idleText.current = null;
  if (!c) {
    return (
      <div className="card" id="ovLive">
        <div className="card-head">
          <h2>שיחה חיה</h2>
        </div>
        <EmptyState title="אין שיחה כרגע" text={idleText.current ?? ""} icon="phone" compact />
      </div>
    );
  }
  const secs = (Date.now() - new Date(c.started_at).getTime()) / 1000;
  return (
    <div className="card" id="ovLive">
      <div className="card-head">
        <h2>שיחה חיה</h2>
        <Chip label="חי" tone="live" dot cls="pulse" />
        <span className="sub" id="ovLiveSub">
          {`${c.name ?? c.number} · ${c.origin === "dialer" ? "אוטומטי" : "בדיקה"} · ${fmtDuration(secs)}`}
        </span>
        <span className="actions">
          <button className="btn sm" data-call={c.id} onClick={() => openCall(c.id)}>
            פתח
          </button>
        </span>
      </div>
      <div className="card-body">
        <LiveConvo key={c.id} callId={c.id} />
      </div>
    </div>
  );
}

export default function Overview() {
  const live = useLive();
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // admin: decided once, when the screen opens (as the old one)
  const [admin] = useState(isAdmin);
  useEvery(20_000, async () => {
    try {
      const r = await get<{ summary: Summary }>("/api/admin/summary");
      setS(r.summary);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  });
  return (
    <>
      <div id="ovKpis">
        {error ? (
          <div className="card">
            <ErrorState msg={error} compact />
          </div>
        ) : s ? (
          <Kpis s={s} />
        ) : (
          <LoadingState rows={2} />
        )}
      </div>
      <div className="grid cols-main" style={{ marginTop: 16 }}>
        <div className="stack">
          <LiveCard live={live} />
          <div id="ovFunnel">{s ? <Funnel s={s} /> : null}</div>
        </div>
        <div className="stack">
          <div id="ovDialer">
            <DialerCard live={live} />
          </div>
          {admin ? (
            <>
              <LimitCard />
              <VoiceCard />
            </>
          ) : null}
          <div id="ovQueue">{s ? <Queue s={s} /> : null}</div>
          <div className="card" id="ovTasks">
            {s ? (
              <>
                <div className="card-head">
                  <h2>משימות לנציג</h2>
                </div>
                <div className="card-body row">
                  <span className="kpi-value" style={{ margin: 0 }}>
                    {s.open_rep_tasks}
                  </span>
                  <span className="muted">משימות פתוחות</span>
                  <span className="spacer" />
                  <a className="btn sm" href="#/reps">
                    לרשימה
                  </a>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
