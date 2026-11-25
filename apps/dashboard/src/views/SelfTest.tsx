/**
 * שיחת בדיקה אליי (Mishlav's users; port of views/self-test.js): the bot calls the phone this user logged in with -
 * never another number - as a customer who asked about the study day they pick, by their own first name. They follow
 * the call live here (every 1.5 s until it ends); it doesn't touch any contact or Gold (routes/phone.ts /api/me/*).
 */
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { Conversation, conversationSize } from "../components/Conversation";
import { EmptyState, ErrorState, LoadingState } from "../components/ui";
import { ApiError, get, post } from "../lib/api";
import { useEvery, useFollowing } from "../lib/hooks";
import { refreshLive, useLive } from "../lib/live";
import type { CallDetail } from "../lib/types";

interface Info {
  phone: string;
  days: { id: string; label: string }[];
  voices?: { id: string; he: string }[];
  voice?: string | null;
}

export default function SelfTest() {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get<Info>("/api/me/test-call")
      .then(setInfo)
      .catch((e: Error) => setError(e.message));
  }, []);
  if (!info) {
    return (
      <div className="grid cols-2">
        <div className="card" id="stCard">
          {error ? <ErrorState msg={error} /> : <LoadingState rows={4} />}
        </div>
        <TranscriptCard>
          <p className="muted small">התמלול יופיע כאן בזמן השיחה</p>
        </TranscriptCard>
      </div>
    );
  }
  return <Ready info={info} />;
}

function TranscriptCard({ children, boxRef }: { children: ReactNode; boxRef?: RefObject<HTMLDivElement> }) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>📝 מה נאמר</h2>
      </div>
      <div className="card-body">
        <div className="convo scroll" id="stConvo" ref={boxRef}>
          {children}
        </div>
      </div>
    </div>
  );
}

function Ready({ info }: { info: Info }) {
  const live = useLive();
  const [callId, setCallId] = useState<string | null>(null);
  const following = useRef(false);
  const [r, setR] = useState<CallDetail | null>(null);
  const [convoError, setConvoError] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; bad?: boolean }>({ text: "" });
  const [dialing, setDialing] = useState(false);
  const day = useRef<HTMLSelectElement>(null);
  const voiceSel = useRef<HTMLSelectElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEvery(1500, async () => {
    if (!following.current || !callId) return;
    try {
      const x = await get<CallDetail>(`/api/admin/calls/${encodeURIComponent(callId)}`);
      if (!x.live) following.current = false; // ended: this read is the last
      setR(x);
      setConvoError(null);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) setConvoError((e as Error).message);
    }
  });
  useFollowing(box, r);

  const { phone, days, voices = [], voice } = info;
  const ph = live.phone;
  const busy = !!ph?.status?.busy;
  const mine = busy && ph?.status?.call?.id === callId;
  const dial = async () => {
    setDialing(true);
    setNote({ text: "מחייג…" });
    try {
      const d = day.current?.value;
      const v = voiceSel.current?.value;
      const res = await post("/api/me/test-call", { ...(d ? { day_id: d } : {}), ...(v ? { voice: v } : {}) });
      setCallId(res.call_id);
      setR(null);
      setConvoError(null);
      following.current = true;
      setNote({ text: "הטלפון שלך אמור לצלצל" });
    } catch (e) {
      setNote({ text: (e as Error).message, bad: true });
    }
    setDialing(false);
    void refreshLive();
  };
  return (
    <div className="grid cols-2">
      <div className="card" id="stCard">
        <div className="card-head">
          <h2>📞 הבוט יתקשר אליך</h2>
        </div>
        <div className="card-body stack">
          <div id="stLine">
            {!ph ? null : !ph.available ? (
              <div className="banner bad">קו הטלפון לא פעיל כרגע. נסה שוב מאוחר יותר.</div>
            ) : busy ? (
              <div className="banner live">🔴 {mine ? "השיחה אליך פעילה" : "הקו תפוס בשיחה אחרת. אפשר לנסות שוב כשתסתיים."}</div>
            ) : (
              <div className="banner ok">הקו פנוי ✓</div>
            )}
          </div>
          <p style={{ margin: 0 }}>
            הבוט יתקשר למספר שלך, <b className="ltr">{phone}</b>, ויתנהג כאילו השארת פרטים על יום העיון שתבחר. אפשר לשאול אותו שאלות, לבקש קישור, לבקש נציג – כמו לקוח.
          </p>
          <label className="field full">
            יום העיון שהתעניינת בו
            <select id="stDay" ref={day} defaultValue="">
              <option value="">לא ידוע (הבוט ישאל)</option>
              {days.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          {days.length ? null : <EmptyState title="אין ימי עיון קרובים" icon="calendar" compact />}
          <label className="field full">
            קול הבוט בשיחה הזאת
            <select id="stVoice" ref={voiceSel} defaultValue={voices.some((v) => v.id === voice) ? (voice ?? undefined) : voices[0]?.id}>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.id} – {v.he}
                  {v.id === voice ? " (הקול הנוכחי)" : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button className="btn success lg" id="stDial" disabled={dialing || !ph?.available || busy} onClick={() => void dial()}>
              📞 התקשרו אליי
            </button>
            <button
              className="btn danger lg"
              id="stHangup"
              disabled={!mine}
              onClick={async () => {
                await post("/api/me/hangup").catch(() => {});
                void refreshLive();
              }}
            >
              ⏹ נתק
            </button>
            <span className="small" id="stNote">
              {note.bad ? <span style={{ color: "var(--danger)" }}>{note.text}</span> : note.text}
            </span>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            שיחת בדיקה לא נוגעת באף לקוח ולא בגולד. אם תבקש קישור לרכישה, הוא יישלח ב-SMS למספר שלך.
          </p>
        </div>
      </div>
      <TranscriptCard boxRef={box}>
        {convoError ? (
          <ErrorState msg={convoError} compact />
        ) : !callId ? (
          <p className="muted small">התמלול יופיע כאן בזמן השיחה</p>
        ) : r && conversationSize(r.transcript ?? [], r.tools ?? []) ? (
          <Conversation lines={r.transcript ?? []} tools={r.tools ?? []} customer="אתה" />
        ) : (
          <p className="muted small">{r && !r.live ? "השיחה הסתיימה בלי מה להציג" : "מחכה שתענה…"}</p>
        )}
      </TranscriptCard>
    </div>
  );
}
