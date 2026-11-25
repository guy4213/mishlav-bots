/**
 * The two drawers every screen opens: a contact (its Gold fields, the bot's state, its calls and rep tasks, a test-dial
 * button for admins) and a call (details, the recording, the conversation; refreshed every 1.5 s while it is live).
 * Ports of contacts.js openContact and calls.js openCall.
 */
import { useEffect, useRef, useState } from "react";
import { Conversation, conversationSize } from "../components/Conversation";
import { Icon } from "../components/Icon";
import { DrawerView, useDrawerBody, useDrawerOpen } from "../components/Overlays";
import { CallOriginChip, Chip, EmptyState, ErrorState, Kv, LoadingState, Notes, OriginChip, OutcomeChip, PhoneLink, StatusChip, callName } from "../components/ui";
import { get, isAdmin, post } from "../lib/api";
import { fmtCost, fmtDateTime, fmtDuration, fmtPhone, fmtRel } from "../lib/format";
import { every, useFollowing } from "../lib/hooks";
import { GENDER_HE, GOLD_FIELDS, PHONE_COL, REASON_HE, REP_REASON_HE, outcomeLabel } from "../lib/labels";
import { safeUrl } from "../lib/safe-url";
import type { CallDetail, CallRow, Contact } from "../lib/types";
import { confirmDialog, openDrawer, toast } from "../lib/ui-store";

export function openContact(id: string) {
  openDrawer(<ContactDrawer id={id} />);
}
export function openCall(callId: string) {
  openDrawer(<CallDrawer callId={callId} />);
}

// ------------------------------------------------------------------ a contact

function ContactDrawer({ id }: { id: string }) {
  const [r, setR] = useState<{ contact: Contact; calls: CallRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get(`/api/admin/contacts/${encodeURIComponent(id)}`)
      .then((x) => setR(x))
      .catch((e: Error) => setError(e.message));
  }, [id]);
  if (!r) {
    return (
      <DrawerView title="לקוח" sub={<span className="ltr">{id}</span>}>
        {error ? <ErrorState msg={error} /> : <LoadingState rows={6} />}
      </DrawerView>
    );
  }
  const c = r.contact;
  const b = c.bot_state ?? ({} as Partial<NonNullable<Contact["bot_state"]>>);
  const pi = b.phone_index ?? 1;
  const dialing = (c as unknown as Record<string, string | null>)[PHONE_COL[pi - 1]!] ?? null;
  const dnc = b.bot_status === "do_not_call";
  const tasks = c.rep_tasks ?? [];
  const dial = async () => {
    const ok = await confirmDialog({
      title: `להתקשר עכשיו ל${c.full_name ?? "לקוח"}?`,
      text: (
        <>
          הבוט יחייג ל-<span className="ltr">{dialing}</span>. זו שיחת בדיקה (מסומנת 🧪), אבל היא מעדכנת את הרשומה ואת גולד כמו שיחה אמיתית.
        </>
      ),
      okLabel: "חייג",
    });
    if (!ok.ok) return;
    try {
      const res = await post("/test/phone/call", { contact_id: id });
      toast("מחייג…", "ok");
      openCall(res.call_id);
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };
  const gold = c as unknown as Record<string, string | null>;
  return (
    <DrawerView
      title={
        <>
          {c.full_name ?? id} <StatusChip s={b.bot_status ?? "new"} />
        </>
      }
      sub={
        <>
          <span className="ltr">{id}</span>
          {c.status ? ` · בגולד: ${c.status}` : null}
        </>
      }
    >
      {/* calling a customer from here is ours: Mishlav's users test with a call to themselves (שיחת בדיקה אליי) */}
      <div className="row" style={{ marginBottom: 18 }} hidden={!isAdmin()}>
        <button className="btn primary" id="cDial" disabled={dnc || !dialing} onClick={() => void dial()}>
          <Icon name="phone" /> חייג עכשיו (בדיקה)
        </button>
        <span className="small muted">
          {dnc ? (
            "ביקש לא להתקשר – אי אפשר לחייג"
          ) : dialing ? (
            <>
              מחייג ל-{pi === 1 ? "טלפון" : `טלפון ${pi}`} <span className="ltr">{dialing}</span>
            </>
          ) : (
            "אין מספר תקין"
          )}
        </span>
      </div>
      <div className="section-title">אצל הבוט (גולד לא רואה)</div>
      <Kv
        pairs={[
          ["מצב", <StatusChip s={b.bot_status ?? "new"} />],
          ["ניסיונות", `${b.attempts ?? 0}${b.no_answer_streak ? ` · ${b.no_answer_streak} ברצף בלי מענה` : ""}`],
          ["ענה בעבר", b.ever_answered ? "כן" : "לא"],
          ["שיחה אחרונה", b.last_call_at ? fmtDateTime(b.last_call_at) : null],
          ["תוצאה אחרונה", b.last_outcome ? outcomeLabel(b.last_outcome) : null],
          ["שיחה חוזרת", b.callback_at ? fmtDateTime(b.callback_at) : null],
          [
            "החיוג הבא",
            b.next_call_at ? (
              <>
                {fmtDateTime(b.next_call_at)} <span className="faint">({fmtRel(b.next_call_at)})</span>
              </>
            ) : null,
          ],
          ["יום עיון", b.interested_day_id ? <span className="ltr">{b.interested_day_id}</span> : null],
          ["מגדר (לבוט)", b.customer_gender ? GENDER_HE[b.customer_gender] : "ייקבע לפי השם"],
          ["עודכן לגולד", b.gold_changed_at ? fmtDateTime(b.gold_changed_at) : null],
        ]}
      />
      <div className="section-title">משימות לנציג</div>
      {tasks.length ? (
        <ul className="list card">
          {tasks.map((t, i) => (
            <li key={i}>
              <div className="grow">
                <b>{REP_REASON_HE[t.reason ?? ""] ?? t.reason}</b> <span className="small muted">· לחזור {t.callback_at ? fmtDateTime(t.callback_at) : "בהקדם"}</span>
                {t.note ? <div className="small muted">{t.note}</div> : null}
              </div>
              {t.done ? <Chip label="טופל" tone="success" /> : <Chip label="פתוחה" tone="warning" />}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small faint">אין משימות</p>
      )}
      <div className="section-title">שיחות ({r.calls.length})</div>
      {r.calls.length ? (
        <ul className="list card">
          {r.calls.map((k) => (
            <li key={k.call_id} className="click" data-call={k.call_id} onClick={() => openCall(k.call_id)}>
              <div className="grow">
                <div>
                  {fmtDateTime(k.started_at)} <span className="small faint num">· {fmtDuration(k.duration_sec)}</span>
                </div>
              </div>
              <OutcomeChip o={k.outcome} /> <OriginChip o={k.origin} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="small faint">עוד לא התקשרו</p>
      )}
      <div className="section-title">בגולד</div>
      <Kv
        pairs={GOLD_FIELDS.map(([k, label]) => [
          label,
          k === "notes" ? <Notes text={c.notes} /> : k.startsWith("phone") ? (gold[k] ? <PhoneLink p={gold[k]} /> : null) : gold[k] ? gold[k] : null,
        ])}
      />
    </DrawerView>
  );
}

// ------------------------------------------------------------------ a call

/** The recording is uploaded right after the call ends: until it is there, the drawer keeps asking (90 s). */
const saving = (r: CallDetail) => {
  const c = r.call;
  if (r.live || !c || c.recording_path) return false;
  return Date.now() - new Date(c.started_at).getTime() - (c.duration_sec ?? 0) * 1000 < 90_000;
};

function CallDrawer({ callId }: { callId: string }) {
  const open = useDrawerOpen();
  const body = useDrawerBody();
  const [r, setR] = useState<CallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** the recording, once someone pressed play (a link valid for an hour); while it is there the drawer stays as it is */
  const [rec, setRec] = useState<{ url: string | null; error: string | null } | null>(null);
  const [recBusy, setRecBusy] = useState(false);
  const recRef = useRef(rec);
  recRef.current = rec;
  const openRef = useRef(open);
  openRef.current = open;
  const renders = useRef(0);
  if (r) renders.current++;

  useEffect(() => {
    let stop: (() => void) | null = null;
    let first = true;
    const load = async () => {
      try {
        const x = await get<CallDetail>(`/api/admin/calls/${encodeURIComponent(callId)}`);
        // a playing recording stays (the read that found it was the last one)
        if (!recRef.current) setR(x);
        first = false;
        if (!x.live && !saving(x)) stop?.(); // a finished call with its recording (or none to wait for): no more polling
      } catch (e) {
        if (first) setError((e as Error).message);
      }
    };
    stop = every(1500, load, () => openRef.current);
    return () => stop?.();
  }, [callId]);
  // the conversation grows at the bottom: stay there if the reader was (not on the first drawing)
  useFollowing(body ?? { current: null }, r, renders.current <= 1);

  if (!r) {
    return (
      <DrawerView title="שיחה" sub={<span className="ltr">{callId}</span>}>
        {error ? <ErrorState msg={error} /> : <LoadingState rows={6} />}
      </DrawerView>
    );
  }
  const c = r.call;
  const src = { db: "התמלול נשמר במסד", file: "התמלול מהדיסק של השרת הזה (יישמר במסד בסוף השיחה)", none: "" }[r.transcript_source];
  const playRecording = async () => {
    setRecBusy(true);
    try {
      const x = await get(`/api/admin/calls/${encodeURIComponent(callId)}/recording`);
      setRec({ url: safeUrl(x.url, ["https:"]), error: safeUrl(x.url, ["https:"]) ? null : "קישור ההקלטה לא תקין" });
    } catch (err) {
      setRec({ url: null, error: (err as Error).message });
    } finally {
      setRecBusy(false);
    }
  };
  const recording = rec ? (
    rec.url ? (
      <audio controls autoPlay preload="auto" src={rec.url} style={{ width: "100%", maxWidth: 360 }} />
    ) : (
      <span style={{ color: "var(--danger)" }}>{rec.error}</span>
    )
  ) : c?.recording_path ? (
    <button className="btn sm" data-rec="" disabled={recBusy} onClick={() => void playRecording()}>
      <Icon name="play" />
      <span>השמע הקלטה</span>
    </button>
  ) : r.live ? (
    "תישמר בסוף השיחה"
  ) : saving(r) ? (
    "נשמרת…"
  ) : (
    "אין"
  );
  const who = c?.gold_record_id ? (
    <a
      href="#"
      data-contact={c.gold_record_id}
      onClick={(e) => {
        e.preventDefault();
        openContact(c.gold_record_id!);
      }}
    >
      {c.full_name ?? c.gold_record_id}
    </a>
  ) : (
    <>
      {c ? callName(c) : ""} <span className="faint small">(לא לקוח מהמסד)</span>
    </>
  );
  return (
    <DrawerView
      title={
        <>
          {c ? callName(c) : "שיחת בדיקה"}{" "}
          {r.live ? <Chip label="שיחה חיה" tone="live" dot cls="pulse" /> : c ? <OutcomeChip o={c.outcome} /> : null}
        </>
      }
      sub={
        <>
          {c ? `${fmtDateTime(c.started_at)} · ` : null}
          <span className="ltr faint">{callId}</span>
        </>
      }
    >
      {c ? (
        <dl className="kv">
          <dt>לקוח</dt>
          <dd>{who}</dd>
          <dt>טלפון</dt>
          <dd>{c.number ? <span className="ltr num">{fmtPhone(c.number)}</span> : "—"}</dd>
          <dt>מקור</dt>
          <dd>
            <CallOriginChip c={c} />
            {c.scenario ? <span className="faint small"> · תרחיש {c.scenario}</span> : null}
          </dd>
          <dt>משך</dt>
          <dd className="num">{r.live ? "בשיחה…" : fmtDuration(c.duration_sec)}</dd>
          <dt>ענה</dt>
          <dd>{c.answered ? "כן" : "לא"}</dd>
          <dt>עלות AI</dt>
          <dd className="num">{fmtCost(c.ai_cost_usd, c.duration_sec)}</dd>
          <dt>הקלטה</dt>
          <dd data-rec-box="">{recording}</dd>
          <dt>תוצאה</dt>
          <dd>
            {outcomeLabel(c.outcome)}
            {c.reason ? ` · ${REASON_HE[c.reason] ?? c.reason}` : null}
          </dd>
          {c.summary ? (
            <>
              <dt>סיכום</dt>
              <dd>{c.summary}</dd>
            </>
          ) : null}
        </dl>
      ) : (
        <div className="banner info">שיחת בדיקה למספר ידני (לא של לקוח מהמסד): יש רק את מה שנשמר בשרת הזה.</div>
      )}
      <div className="section-title">
        השיחה{" "}
        {src ? (
          <span className="faint" style={{ fontWeight: 400 }}>
            · {src}
          </span>
        ) : null}
      </div>
      {conversationSize(r.transcript, r.tools) ? (
        <div className="convo">
          <Conversation lines={r.transcript} tools={r.tools} />
        </div>
      ) : (
        <EmptyState
          title={r.live ? "מחכה שיענו…" : "אין תמלול"}
          text={r.live ? "" : "אולי לא ענו, או שהשיחה הייתה לפני שהתמלולים נשמרו במסד."}
          icon="phone"
          compact
        />
      )}
      {r.errors?.length ? (
        <>
          <div className="section-title">תקלות בעדכון Supabase</div>
          {r.errors.map((x, i) => (
            <div key={i} className="banner bad small">
              {fmtDateTime(x.ts)} · {x.what}: {x.error}
            </div>
          ))}
        </>
      ) : null}
    </DrawerView>
  );
}
