/**
 * לקוחות (port of views/contacts.js): three views - the bot's activity (the call in progress first), the dialer's next
 * ones, and all contacts (searched, filtered and paged by the server, 50 a page). Read once, then only when the server
 * says a contact changed (the push channel, lib/live.ts) - no polling. A row opens the contact's drawer.
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { Chip, EmptyState, ErrorState, LoadingState, Pager, StatusChip } from "../components/ui";
import { get } from "../lib/api";
import { fmtDateTime, fmtRel } from "../lib/format";
import { CONTACT_STATUS_HE, outcomeLabel } from "../lib/labels";
import { onContactsChanged } from "../lib/live";
import { KEYS, readKey, writeKey } from "../lib/storage";
import type { Contact, Paged } from "../lib/types";
import { openContact } from "./drawers";

type ViewId = "activity" | "queue" | "all";
const VIEWS: [ViewId, string][] = [
  ["activity", "פעילות הבוט"],
  ["queue", "הבאים בתור"],
  ["all", "כל הלקוחות"],
];
const EMPTY: Record<ViewId, [string, string]> = {
  activity: ["הבוט עוד לא התקשר לאף אחד", "כשהחיוג האוטומטי יתחיל, מי שבשיחה יופיע כאן למעלה, ואחריו מי שהבוט התקשר אליו לאחרונה."],
  queue: ["אין אף אחד בתור", "אין לקוחות חדשים, בהמתנה או לשיחה חוזרת בקורסים שהחייגן מתקשר אליהם."],
  all: ["אין לקוחות שמתאימים לחיפוש", ""],
};
const nextCall = (b: Contact["bot_state"]) => b?.callback_at ?? b?.next_call_at ?? null;

function Rows({ list, view }: { list: Contact[]; view: ViewId }) {
  if (!list.length) return <EmptyState title={EMPTY[view][0]} text={EMPTY[view][1]} icon={view === "all" ? "search" : "users"} />;
  const queue = view === "queue";
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            {queue ? <th>#</th> : null}
            <th>שם</th>
            <th>סטטוס בגולד</th>
            <th>מצב הבוט</th>
            <th>ניסיונות</th>
            <th>שיחה אחרונה</th>
            <th>החיוג הבא</th>
          </tr>
        </thead>
        <tbody>
          {list.map((c, i) => {
            const b = c.bot_state ?? ({} as Partial<NonNullable<Contact["bot_state"]>>);
            const next = nextCall(c.bot_state);
            const open = (c.rep_tasks ?? []).filter((t) => !t.done).length;
            return (
              <tr key={c.gold_record_id} className="click" data-id={c.gold_record_id} onClick={() => openContact(c.gold_record_id)}>
                {queue ? <td className="num faint">{i + 1}</td> : null}
                <td>
                  <div className="cell-main">{c.full_name ?? "—"}</div>
                  <div className="cell-sub ltr">{c.phone ?? ""}</div>
                </td>
                <td>{c.status ? c.status : <span className="faint">—</span>}</td>
                <td>
                  <StatusChip s={b.bot_status ?? "new"} />
                  {open ? (
                    <>
                      {" "}
                      <Chip label={`${open} לנציג`} tone="warning" />
                    </>
                  ) : null}
                </td>
                <td className="num nowrap">
                  {b.attempts ?? 0}
                  {b.no_answer_streak ? (
                    <>
                      {" "}
                      <span className="cell-sub">· {b.no_answer_streak} ברצף</span>
                    </>
                  ) : null}
                </td>
                <td className="nowrap">
                  {b.last_call_at ? (
                    <>
                      <div>{fmtDateTime(b.last_call_at)}</div>
                      <div className="cell-sub">{b.last_outcome ? outcomeLabel(b.last_outcome) : ""}</div>
                    </>
                  ) : (
                    <span className="faint">—</span>
                  )}
                </td>
                <td className="nowrap">
                  {next ? (
                    <>
                      <div>{fmtDateTime(next)}</div>
                      <div className="cell-sub">
                        {fmtRel(next)}
                        {b.callback_at ? " · ביקש" : ""}
                      </div>
                    </>
                  ) : queue && c.due ? (
                    <span>עכשיו בתור</span>
                  ) : (
                    <span className="faint">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type Body = { kind: "loading" } | { kind: "error"; msg: string } | { kind: "none" } | { kind: "rows"; list: Contact[]; view: ViewId };

export default function Contacts() {
  const [view, setView] = useState<ViewId>(() => {
    const saved = readKey(KEYS.contactsView, "session");
    return VIEWS.some(([v]) => v === saved) ? (saved as ViewId) : "activity";
  });
  const [body, setBody] = useState<Body>({ kind: "loading" });
  const [count, setCount] = useState("");
  const [paging, setPaging] = useState<{ page: number; pages: number } | null>(null);
  // what the next read asks for (the old closure variables): read by the push channel's re-read too
  const q = useRef({ view, page: 1, search: "", status: "" });
  const seq = useRef(0); // the latest request: an older answer that arrives after it is dropped
  const typing = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = async () => {
    const mine = ++seq.current;
    const { view: v, page, search, status } = q.current;
    const params = new URLSearchParams({ view: v });
    if (v === "all") {
      const s = search.trim();
      if (s) params.set("q", s);
      if (status) params.set("status", status);
      params.set("page", String(page));
    }
    try {
      const r = await get<{ available: boolean; contacts: Contact[]; total: number } & Partial<Paged>>(`/api/admin/contacts?${params}`);
      if (mine !== seq.current) return;
      if (!r.available) {
        setBody({ kind: "none" });
        return;
      }
      setBody({ kind: "rows", list: r.contacts, view: v });
      if (v === "all") {
        q.current.page = r.page ?? 1;
        setCount(`${r.total.toLocaleString("he-IL")} לקוחות`);
        setPaging({ page: r.page ?? 1, pages: r.pages ?? 1 });
      } else {
        setCount(v === "queue" ? `${r.total} הבאים לפי סדר החיוג` : `${r.total} אחרונים · מתעדכן מעצמו`);
      }
    } catch (e) {
      if (mine === seq.current) setBody({ kind: "error", msg: (e as Error).message });
    }
  };
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    // read once, then only when the server says a contact changed (a call, the bot, the dialer) - no polling.
    // A lost push channel reconnects by itself and re-reads then (lib/live.ts).
    void loadRef.current();
    const off = onContactsChanged(() => void loadRef.current());
    return () => {
      off();
      if (typing.current) clearTimeout(typing.current);
    };
  }, []);

  const all = view === "all";
  return (
    <>
      <div className="toolbar">
        <div className="seg" id="cView">
          {VIEWS.map(([v, l]) => (
            <button
              key={v}
              data-v={v}
              className={v === view ? "on" : undefined}
              onClick={() => {
                if (v === q.current.view) return;
                q.current.view = v;
                q.current.page = 1;
                writeKey(KEYS.contactsView, v, "session");
                setView(v);
                if (v !== "all") setPaging({ page: 1, pages: 1 });
                setBody({ kind: "loading" });
                void load();
              }}
            >
              {l}
            </button>
          ))}
        </div>
        <label className="search" id="cSearchWrap" hidden={!all}>
          <Icon name="search" />
          <input
            type="search"
            id="cSearch"
            placeholder="חיפוש לפי שם, טלפון, קורס, עיר…"
            onInput={(e) => {
              q.current.search = (e.target as HTMLInputElement).value;
              if (typing.current) clearTimeout(typing.current);
              typing.current = setTimeout(() => {
                q.current.page = 1;
                void load();
              }, 300);
            }}
          />
        </label>
        <select
          id="cStatus"
          hidden={!all}
          defaultValue=""
          onChange={(e) => {
            q.current.status = e.target.value;
            q.current.page = 1;
            void load();
          }}
        >
          <option value="">כל המצבים</option>
          {Object.entries(CONTACT_STATUS_HE).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <span className="muted small" id="cCount">
          {count}
        </span>
      </div>
      <div className="card">
        <div id="cBody">
          {body.kind === "loading" ? (
            <LoadingState rows={8} />
          ) : body.kind === "error" ? (
            <ErrorState msg={body.msg} />
          ) : body.kind === "none" ? (
            <EmptyState title="Supabase לא מחובר" text="חסרים SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY בשרת הזה." />
          ) : (
            <Rows list={body.list} view={body.view} />
          )}
        </div>
        <Pager
          id="cPager"
          page={paging?.page ?? 1}
          pages={all ? (paging?.pages ?? null) : 1}
          onGo={(p) => {
            q.current.page = p;
            void load();
          }}
        />
      </div>
    </>
  );
}
