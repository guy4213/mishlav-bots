/**
 * בדיקות (admins only; port of views/testing.js): pick a contact (searched by the server: 5,000+) or a number, a
 * scenario, a voice; dial, hang up, follow the transcript and the bot's actions live (every 1.5 s), a "what to expect"
 * card for the chosen scenario, a test SMS, and "what Gold will receive".
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { ToolItem } from "../components/Conversation";
import { Chip, Notes } from "../components/ui";
import { get, post } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { useEvery, useFollowing } from "../lib/hooks";
import { CONTACT_STATUS_HE, GENDER_HE, PHONE_COL, REP_REASON_HE, TOOL_HE, outcomeLabel } from "../lib/labels";
import { refreshLive, subscribeLive, useLive } from "../lib/live";
import { KEYS, ls } from "../lib/storage";
import type { Contact, Scenario, ToolCall, TranscriptLine } from "../lib/types";
import { GoldCard } from "./Gold";

const savedNumber = () => String(ls.get(KEYS.phone, ""));
const saveNumber = (n: string) => ls.set(KEYS.phone, n);

function ContactCard({ c }: { c: Contact }) {
  const b = c.bot_state ?? ({} as Partial<NonNullable<Contact["bot_state"]>>);
  const st = b.bot_status ?? "new";
  const pi = b.phone_index ?? 1;
  const dialing = (c as unknown as Record<string, string | null>)[PHONE_COL[pi - 1]!];
  const row = (k: string, v: ReactNode) =>
    v === null || v === undefined || v === "" ? null : (
      <Fragment key={k}>
        <dt>{k}</dt>
        <dd>{v}</dd>
      </Fragment>
    );
  const tasks = (c.rep_tasks ?? []).filter((t) => !t.done);
  const phones = [c.phone, c.phone2, c.phone3].filter(Boolean) as string[];
  return (
    <div className="banner info" style={{ display: "block" }}>
      <b>{c.full_name ?? ""}</b> · {CONTACT_STATUS_HE[st] ?? st}
      <div className="small muted" style={{ margin: "8px 0 4px" }}>
        בגולד
      </div>
      <dl className="kv">
        {row("סטטוס", c.status)}
        {row("קורס מבוקש", c.requested_course)}
        {row("מקור", c.source)}
        {row("עיר", c.city)}
        {row("חברה", c.company)}
        {row(
          "טלפונים",
          phones.length
            ? phones.map((p, i) => (
                <Fragment key={i}>
                  {i > 0 ? <br /> : null}
                  <span className="ltr">{p}</span>
                </Fragment>
              ))
            : null,
        )}
        {row("הערות", c.notes ? <Notes text={c.notes} /> : null)}
      </dl>
      <div className="small muted" style={{ margin: "8px 0 4px" }}>
        אצל הבוט (גולד לא רואה)
      </div>
      <dl className="kv">
        {row(
          "מחייגים ל",
          dialing ? (
            <>
              {pi === 1 ? "טלפון" : `טלפון ${pi}`} · <span className="ltr">{dialing}</span>
            </>
          ) : (
            "אין מספר"
          ),
        )}
        {row("יום עיון", b.interested_day_id)}
        {row("מגדר (לבוט)", b.customer_gender ? GENDER_HE[b.customer_gender] : "ייקבע לפי השם")}
        {row("ניסיונות", b.attempts ? `${b.attempts}${b.no_answer_streak ? ` · ${b.no_answer_streak} ברצף בלי מענה` : ""}` : null)}
        {row("ענה בעבר", b.ever_answered ? "כן" : null)}
        {row("שיחה אחרונה", b.last_call_at ? fmtDateTime(b.last_call_at) : null)}
        {row("תוצאה אחרונה", b.last_outcome ? outcomeLabel(b.last_outcome) : null)}
        {row("שיחה חוזרת", b.callback_at ? fmtDateTime(b.callback_at) : null)}
        {row("החיוג הבא", b.next_call_at ? fmtDateTime(b.next_call_at) : null)}
        {row(
          "משימות לנציג",
          tasks.length
            ? tasks.map((t, i) => (
                <Fragment key={i}>
                  {i > 0 ? <br /> : null}
                  {REP_REASON_HE[t.reason ?? ""] ?? t.reason} – {t.callback_at ? fmtDateTime(t.callback_at) : "בהקדם"}
                </Fragment>
              ))
            : null,
        )}
        {row("עודכן לגולד", b.gold_changed_at ? fmtDateTime(b.gold_changed_at) : null)}
      </dl>
      {st === "do_not_call" ? (
        <div className="small" style={{ color: "var(--danger)" }}>
          ביקש לא להתקשר – אי אפשר לחייג
        </div>
      ) : null}
    </div>
  );
}

function Expect({ s, calls }: { s: Scenario; calls: ToolCall[] }) {
  const done = new Set(calls.filter((c) => c.ok).map((c) => c.tool));
  const g = s.guide ?? {};
  const chips = (list: string[], on: string, off: string, mark: string) =>
    list.map((t, i) => (
      <Fragment key={t}>
        {i > 0 ? " " : null}
        <Chip label={`${done.has(t) ? mark : ""}${TOOL_HE[t] ?? t}`} tone={done.has(t) ? on : off} />
      </Fragment>
    ));
  return (
    <>
      <div className="card-head">
        <h2>מה צפוי · {s.id}</h2>
        <span className="sub">{g.title ?? s.name}</span>
      </div>
      <div className="card-body stack" style={{ gap: 10 }}>
        {g.expect ? <div>{g.expect}</div> : null}
        <dl className="kv">
          <dt>תוצאה צפויה</dt>
          <dd>{outcomeLabel(s.expected_outcome)}</dd>
          {s.required_tools.length ? (
            <>
              <dt>חייב לקרות</dt>
              <dd className="row">{chips(s.required_tools, "success", "info", "✓ ")}</dd>
            </>
          ) : null}
          {s.forbidden_tools.length ? (
            <>
              <dt>אסור</dt>
              <dd className="row">{chips(s.forbidden_tools, "danger", "muted", "✗ ")}</dd>
            </>
          ) : null}
        </dl>
        <details className="more">
          <summary>הצג עוד</summary>
          {s.actor_script?.length ? (
            <>
              <div className="small muted" style={{ marginTop: 8 }}>
                מה להגיד
              </div>
              <ol className="script">
                {s.actor_script.map((l, i) => (
                  <li key={i}>{typeof l === "string" ? l : JSON.stringify(l)}</li>
                ))}
              </ol>
            </>
          ) : null}
          {g.tips?.length ? (
            <>
              <div className="small muted" style={{ marginTop: 8 }}>
                טיפים
              </div>
              <ul className="script">
                {g.tips.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </>
          ) : null}
          {g.watch?.length ? (
            <>
              <div className="small muted" style={{ marginTop: 8 }}>
                לשים לב
              </div>
              <ul className="script">
                {g.watch.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </>
          ) : null}
        </details>
      </div>
    </>
  );
}

export default function Testing() {
  const live = useLive();
  const [voices, setVoices] = useState<{ voices: string[]; labels?: Record<string, string> } | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [scenario, setScenario] = useState("");
  const [list, setList] = useState<{ contacts: Contact[]; head: string }>({ contacts: [], head: "— בלי (מספר ידני) —" });
  const [selected, setSelected] = useState("");
  const [chosen, setChosen] = useState<Contact | null>(null);
  const [number, setNumber] = useState(savedNumber);
  const [name, setName] = useState("");
  const [calls, setCalls] = useState<ToolCall[]>([]);
  const [lines, setLines] = useState<TranscriptLine[] | "waiting" | null>(null);
  const [note, setNote] = useState<{ text: string; bad?: boolean }>({ text: "" });
  const [dialing, setDialing] = useState(false);
  const [sms, setSms] = useState<{ text: string; tone?: "ok" | "bad" | "muted" }>({ text: "" });
  const [smsBusy, setSmsBusy] = useState(false);
  const [goldReload, setGoldReload] = useState(0);
  const smsNumber = useRef<HTMLInputElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  // the old closure variables: the manual number kept while a contact is chosen, the latest search
  const st = useRef({ contactWasChosen: false, manualNumber: "", searchSeq: 0, selected: "", chosen: null as Contact | null, callId: null as string | null });
  const searchQ = useRef<HTMLInputElement>(null);
  const typing = useRef<ReturnType<typeof setTimeout> | null>(null);

  // a chosen student fills the number (the phone the bot dials now) and the name from Supabase (locked)
  const fill = (c: Contact | null) => {
    if (c) {
      if (!st.current.contactWasChosen) st.current.manualNumber = number;
      const pi = c.bot_state?.phone_index ?? 1;
      setNumber(((c as unknown as Record<string, string | null>)[PHONE_COL[pi - 1]!] ?? c.phone ?? "").replace(/^\+972/, "0"));
      setName(c.full_name ?? "");
    } else if (st.current.contactWasChosen) {
      setNumber(st.current.manualNumber || savedNumber());
      setName("");
    }
    st.current.contactWasChosen = !!c;
  };
  const choose = async (id: string) => {
    let c: Contact | null = null;
    try {
      c = id ? (await get(`/api/admin/contacts/${encodeURIComponent(id)}`)).contact : null;
    } catch {
      c = null;
    }
    st.current.chosen = c;
    setChosen(c);
    fill(c && c.gold_record_id === st.current.selected ? c : null);
  };
  const loadContacts = async () => {
    const mine = ++st.current.searchSeq;
    try {
      const q = searchQ.current?.value.trim() ?? "";
      const r = await get(`/api/admin/contacts?page=1${q ? `&q=${encodeURIComponent(q)}` : ""}`);
      if (mine !== st.current.searchSeq) return;
      const found: Contact[] = r.contacts ?? [];
      const chosenNow = st.current.chosen;
      // the chosen one stays in the list when a new search doesn't find it
      const shown = chosenNow && !found.some((c) => c.gold_record_id === chosenNow.gold_record_id) ? [chosenNow, ...found] : found;
      const head = !r.available
        ? "— Supabase לא מחובר —"
        : r.total > found.length
          ? `— בלי (מספר ידני) · ${r.total} תוצאות, מוצגות ${found.length}: לחפש מדויק יותר —`
          : "— בלי (מספר ידני) —";
      setList({ contacts: shown, head });
      const keep = shown.some((c) => c.gold_record_id === st.current.selected) ? st.current.selected : "";
      st.current.selected = keep;
      setSelected(keep);
      if (keep) await choose(keep);
      else {
        st.current.chosen = null;
        setChosen(null);
        fill(null);
      }
    } catch {
      // the form still dials numbers
    }
  };
  const loadRef = useRef(loadContacts);
  loadRef.current = loadContacts;

  useEffect(() => {
    get("/api/admin/voice")
      .then(setVoices)
      .catch(() => {}); // no Supabase: the server's voice only
    get("/test/overview")
      .then((ov) => setScenarios(ov.scenarios))
      .catch(() => {});
    if (smsNumber.current && !smsNumber.current.value) smsNumber.current.value = savedNumber();
    void loadRef.current();
    // a call just ended: show the contacts' new statuses
    let wasBusy = false;
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = subscribeLive((s) => {
      const info = s.phone;
      if (!info) return;
      const busy = !!info.status?.busy;
      if (wasBusy && !busy)
        t = setTimeout(() => {
          void loadRef.current();
          setGoldReload((n) => n + 1);
        }, 1500);
      wasBusy = busy;
      const id = info.status?.call?.id;
      if (id && id !== st.current.callId) {
        st.current.callId = id;
      }
    });
    return () => {
      off();
      if (t) clearTimeout(t);
      if (typing.current) clearTimeout(typing.current);
    };
  }, []);

  // the call's transcript and tools (every 1.5 s, while there is one)
  useEvery(1500, async () => {
    const id = st.current.callId;
    if (!id) return;
    const [c, tr] = await Promise.all([
      get(`/test/calls?call_id=${encodeURIComponent(id)}`).catch(() => null),
      get(`/test/transcript?call_id=${encodeURIComponent(id)}`).catch(() => null),
    ]);
    if (c) setCalls(c.calls);
    if (tr?.lines.length) setLines(tr.lines);
  });
  useFollowing(transcript, lines);

  const dial = async () => {
    const contactId = selected;
    const n = number.trim();
    if (!n && !contactId) {
      setNote({ text: "הכנס מספר או בחר סטודנט" });
      return;
    }
    setDialing(true);
    setNote({ text: "מחייג..." });
    try {
      // with a student, the server takes the number and the first name from Supabase
      const body = contactId ? { contact_id: contactId } : { number: n, ...(name.trim() ? { name: name.trim() } : {}) };
      if (!contactId) saveNumber(n);
      const voice = (document.getElementById("phVoice") as HTMLSelectElement | null)?.value ?? "";
      const r = await post("/test/phone/call", { ...body, ...(scenario ? { scenario } : {}), ...(voice ? { voice } : {}) });
      st.current.callId = r.call_id;
      setCalls([]);
      setLines("waiting");
      setNote({ text: "" });
    } catch (e) {
      setNote({ text: (e as Error).message, bad: true });
    }
    setDialing(false);
    void refreshLive();
  };

  const info = live.phone;
  const line = info?.status ?? null;
  const sc = scenarios.find((s) => s.id === scenario);
  const card = chosen && chosen.gold_record_id === selected ? chosen : null;
  return (
    <>
      <div className="grid cols-2">
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>📞 הבוט מתקשר למי שתבחר</h2>
            </div>
            <div className="card-body stack">
              <div id="phStatus">
                {!info ? null : !info.available ? (
                  <div className="banner bad">קו הטלפון לא פעיל: {info.reason ?? "לא ידוע"}</div>
                ) : line?.busy && line.call ? (
                  <div className="banner live">
                    🔴 שיחה פעילה ({line.call.direction === "out" ? "יוצאת" : "נכנסת"}) · <span className="ltr">{line.call.number}</span> · תרחיש{" "}
                    {line.call.scenario ?? "—"}
                  </div>
                ) : (
                  <div className="banner ok">
                    הקו מוכן ✓{" "}
                    {line?.number ? (
                      <>
                        · <span className="ltr">{line.number}</span>
                      </>
                    ) : null}{" "}
                    ·{" "}
                    <span className="small ltr">
                      {line?.model} · {line?.voice}
                    </span>
                  </div>
                )}
              </div>
              <div className="form-grid">
                <label className="field full">
                  חיפוש סטודנט ב-Supabase{" "}
                  <input
                    type="search"
                    id="phContactQ"
                    placeholder="שם, טלפון או מספר רשומה…"
                    ref={searchQ}
                    onInput={() => {
                      if (typing.current) clearTimeout(typing.current);
                      typing.current = setTimeout(() => void loadContacts(), 300);
                    }}
                  />
                </label>
                <label className="field full">
                  סטודנט מ-Supabase{" "}
                  <select
                    id="phContact"
                    value={selected}
                    onChange={(e) => {
                      st.current.selected = e.target.value;
                      setSelected(e.target.value);
                      void choose(e.target.value);
                    }}
                  >
                    <option value="">{list.head}</option>
                    {list.contacts.map((c) => {
                      const s = c.bot_state?.bot_status ?? "new";
                      return (
                        <option key={c.gold_record_id} value={c.gold_record_id} disabled={s === "do_not_call"}>
                          {c.full_name ?? c.gold_record_id} · {c.phone ?? ""} · {CONTACT_STATUS_HE[s] ?? s}
                        </option>
                      );
                    })}
                  </select>
                </label>
                <div id="phContactCard" className="full" hidden={!card}>
                  {card ? <ContactCard c={card} /> : null}
                </div>
                <label className="field">
                  מספר טלפון{" "}
                  <input type="text" id="phNumber" className="ltr" inputMode="tel" placeholder="0501234567" value={number} readOnly={!!card} onChange={(e) => setNumber(e.target.value)} />
                </label>
                <label className="field">
                  שם הלקוח (רשות){" "}
                  <input type="text" id="phName" placeholder="מהתרחיש" value={name} readOnly={!!card} onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="field full">
                  תרחיש{" "}
                  <select id="phScenario" value={scenario} onChange={(e) => setScenario(e.target.value)}>
                    <option value="">ללא תרחיש (שם ויום ברירת מחדל)</option>
                    {scenarios.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.id} · {s.guide?.title ?? s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field full">
                  קול הבוט{" "}
                  <select id="phVoice" defaultValue="">
                    <option value="">הקול שנבחר בסקירה</option>
                    {(voices?.voices ?? []).map((v) => (
                      <option key={v} value={v}>
                        {v} – {voices?.labels?.[v] ?? ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="row">
                <button className="btn success lg" id="phDial" disabled={dialing || (info ? !info.available || !!line?.busy : false)} onClick={() => void dial()}>
                  📞 חייג
                </button>
                <button
                  className="btn danger lg"
                  id="phHangup"
                  disabled={!line?.busy}
                  onClick={async () => {
                    await post("/test/phone/hangup").catch(() => {});
                    void refreshLive();
                  }}
                >
                  ⏹ נתק
                </button>
                <span className="small" id="phNote">
                  {note.bad ? <span style={{ color: "var(--danger)" }}>{note.text}</span> : note.text}
                </span>
              </div>
              <p className="small muted" style={{ margin: 0 }}>
                שיחה לסטודנט מ-Supabase כותבת לשדות של גולד עצמם (שורת [הערת הבוט] בסוף ה"הערות" ו"סטטוס") ומעדכנת את המצב הפנימי של הבוט. היא מסומנת "🧪 בדיקה" ולא נספרת
                במדדים של הסקירה. הלוג המלא של הקו – במסך <a href="#/logs">לוגים</a>.
              </p>
            </div>
          </div>
          <div className="card" id="phExpect" hidden={!sc}>
            {sc ? <Expect s={sc} calls={calls} /> : null}
          </div>
          <div className="card">
            <div className="card-head">
              <h2>✉️ בדיקת SMS</h2>
            </div>
            <div className="card-body stack">
              <div className="row">
                <input type="text" id="smsNumber" className="ltr" inputMode="tel" placeholder="0501234567" style={{ maxWidth: 200 }} ref={smsNumber} />
                <button
                  className="btn"
                  id="smsSend"
                  disabled={smsBusy}
                  onClick={async () => {
                    const n = smsNumber.current?.value.trim() ?? "";
                    if (!n) {
                      setSms({ text: "הכנס מספר" });
                      return;
                    }
                    setSmsBusy(true);
                    setSms({ text: "שולח…" });
                    try {
                      const r = await post("/api/admin/sms/test", { number: n });
                      setSms(r.sent ? { text: `✓ נשלח דרך ${r.provider} – בדוק את הטלפון`, tone: "ok" } : { text: "לא נשלח באמת: אין מפתחות Zadarma בשרת (לוג בלבד)", tone: "muted" });
                    } catch (e) {
                      setSms({ text: `לא נשלח: ${(e as Error).message}`, tone: "bad" });
                    } finally {
                      setSmsBusy(false);
                    }
                  }}
                >
                  שלח SMS בדיקה
                </button>
              </div>
              <span className="small" id="smsNote">
                {sms.tone === "ok" ? (
                  <span style={{ color: "var(--success)" }}>{sms.text}</span>
                ) : sms.tone === "bad" ? (
                  <span style={{ color: "var(--danger)" }}>{sms.text}</span>
                ) : sms.tone === "muted" ? (
                  <span className="muted">{sms.text}</span>
                ) : (
                  sms.text
                )}
              </span>
              <p className="small muted" style={{ margin: 0 }}>
                שולח "משלב: הודעת בדיקה מהבוט" דרך הספק שמוגדר בשרת – בלי שיחה. בודק שהמפתחות של Zadarma, שם השולח והיתרה תקינים.
              </p>
            </div>
          </div>
        </div>
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>📝 מה נאמר</h2>
            </div>
            <div className="card-body">
              <div className="convo scroll" id="phTranscript" ref={transcript}>
                {lines === null ? (
                  <p className="muted small">התמלול יופיע כאן בזמן השיחה</p>
                ) : lines === "waiting" ? (
                  <p className="muted small">מחכה שיענו...</p>
                ) : (
                  lines.map((l, i) => (
                    <div key={i} className={`bubble ${l.role === "user" ? "user" : "bot"}`}>
                      <span className="who">{l.role === "user" ? "לקוח" : "הבוט"}</span>
                      {l.text}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <h2>🔧 מה הבוט עשה</h2>
            </div>
            <div className="card-body">
              <ul className="tool-list" id="phTools">
                {calls.length ? calls.map((c, i) => <ToolItem key={i} c={c} />) : <li className="muted">עוד לא ביצע פעולות</li>}
              </ul>
            </div>
          </div>
        </div>
      </div>
      <GoldCard id="phGold" style={{ marginTop: 16 }} reload={goldReload} />
    </>
  );
}
