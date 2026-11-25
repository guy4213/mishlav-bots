/**
 * גולד (admins only; port of views/gold.js): what Gold will receive on its daily pull (GET /api/gold/changes), and
 * whether its key is set. The card is used inside the testing screen too. Read on open, on refresh and when the
 * period changes (no polling); the whole feed is read (it is what Gold pulls), the table shows it 50 rows a page.
 */
import { type CSSProperties, Fragment, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { Pager } from "../components/ui";
import { get } from "../lib/api";
import { useLive } from "../lib/live";

const SIZE = 50;

/** The "what Gold will receive" card. `reload`: a number that, when it changes, reads the feed again. */
export function GoldCard({ reload = 0, id, style }: { reload?: number; id?: string; style?: CSSProperties }) {
  const [note, setNote] = useState<{ text: string; bad?: boolean }>({ text: "" });
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [page, setPage] = useState(1);
  const [json, setJson] = useState("");
  const since = useRef<HTMLSelectElement>(null);
  const load = async () => {
    const hours = Number(since.current?.value);
    const iso = hours ? new Date(Date.now() - hours * 3600e3).toISOString() : "";
    setNote({ text: "טוען..." });
    try {
      const r = await get(`/test/gold/changes${iso ? `?since=${encodeURIComponent(iso)}` : ""}`);
      setNote({ text: r.count ? `${r.count} אנשי קשר · המשיכה הבאה: since=${r.until}` : "אין שינויים לשלוח" });
      setRows(r.contacts);
      setPage(1);
      setJson(JSON.stringify(r, null, 2));
    } catch (e) {
      setNote({ text: (e as Error).message, bad: true });
      setRows([]);
      setJson("");
    }
  };
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    void loadRef.current();
  }, [reload]);
  const cols = rows.length ? Object.keys(rows[0]!) : [];
  const shown = rows.slice((page - 1) * SIZE, page * SIZE);
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const lines = String(v).split("\n");
    return lines.map((l, i) => (
      <Fragment key={i}>
        {i > 0 ? <br /> : null}
        {l}
      </Fragment>
    ));
  };
  return (
    <div className="card" id={id} style={style}>
      <div className="card-head">
        <h2>📤 מה גולד יקבל</h2>
        <div className="actions">
          <select className="gSince" style={{ width: "auto" }} ref={since} defaultValue="" onChange={() => void load()}>
            <option value="">מההתחלה (כל מה שהבוט שינה)</option>
            <option value="24">היום האחרון</option>
            <option value="168">השבוע האחרון</option>
          </select>
          <button className="icon-btn gLoad" title="רענון" onClick={() => void load()}>
            <Icon name="refresh" />
          </button>
        </div>
      </div>
      <div className="card-body">
        <p className="small muted" style={{ margin: "0 0 10px" }}>
          בדיוק מה שגולד מושך פעם ביום (<code>GET /api/gold/changes</code>): אנשי הקשר שהבוט שינה, רק עמודות האקסל ובשמות שלהן – בלי שום מידע פנימי של
          הבוט.
        </p>
        <div className="small muted gNote">{note.bad ? <span style={{ color: "var(--danger)" }}>{note.text}</span> : note.text}</div>
        <div style={{ overflow: "auto", marginTop: 8 }}>
          <table className="plain gTable">
            {cols.length ? (
              <tbody>
                <tr>
                  {cols.map((k) => (
                    <th key={k}>{k}</th>
                  ))}
                </tr>
                {shown.map((c, i) => (
                  <tr key={i}>
                    {cols.map((k) => (
                      <td key={k}>{cell(c[k])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ) : null}
          </table>
        </div>
        <Pager page={page} pages={Math.ceil(rows.length / SIZE)} onGo={setPage} />
        <details className="more" style={{ marginTop: 10 }}>
          <summary>JSON כפי שגולד מקבל</summary>
          <pre className="json gJson">{json}</pre>
        </details>
      </div>
    </div>
  );
}

export default function Gold() {
  // the banner is drawn once, from the env as it was when the screen opened (as the old one)
  const env = useLive().env;
  const [first] = useState(env);
  return (
    <div className="stack">
      {!first ? null : first.gold_api_key_set ? (
        <div className="banner ok">
          ✓{" "}
          <div>
            <b>GOLD_API_KEY מוגדר</b> בשרת הזה: גולד יכולים למשוך את השינויים מ-<code>/api/gold/changes</code> עם הכותרת <code>X-Api-Key</code>.
          </div>
        </div>
      ) : (
        <div className="banner warn">
          ⚠{" "}
          <div>
            <b>GOLD_API_KEY לא מוגדר</b> בשרת הזה: הכתובת של גולד דוחה כל בקשה עד שיוגדר מפתח.
          </div>
        </div>
      )}
      <GoldCard id="goldCard" />
    </div>
  );
}
