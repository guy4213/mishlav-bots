// גולד: what Gold will receive on its daily pull (GET /api/gold/changes), and whether its key is set.
import { get } from "../api.js";
import { live } from "../live.js";
import { esc, icon, pager } from "../ui.js";

/** The "what Gold will receive" card, also used inside the testing screen. */
export function mountGoldCard(el) {
  el.innerHTML = `
    <div class="card-head"><h2>📤 מה גולד יקבל</h2>
      <div class="actions">
        <select class="gSince" style="width:auto"><option value="">מההתחלה (כל מה שהבוט שינה)</option><option value="24">היום האחרון</option><option value="168">השבוע האחרון</option></select>
        <button class="icon-btn gLoad" title="רענון">${icon("refresh")}</button>
      </div>
    </div>
    <div class="card-body">
      <p class="small muted" style="margin:0 0 10px">בדיוק מה שגולד מושך פעם ביום (<code>GET /api/gold/changes</code>): אנשי הקשר שהבוט שינה, רק עמודות האקסל ובשמות שלהן – בלי שום מידע פנימי של הבוט.</p>
      <div class="small muted gNote"></div>
      <div style="overflow:auto;margin-top:8px"><table class="plain gTable"></table></div>
      <div class="gPager"></div>
      <details class="more" style="margin-top:10px"><summary>JSON כפי שגולד מקבל</summary><pre class="json gJson"></pre></details>
    </div>`;
  const q = (c) => el.querySelector(c);
  // the whole feed is read (it is what Gold pulls); the table shows it 50 rows a page
  const SIZE = 50;
  let rows = [];
  let page = 1;
  const pages = pager(q(".gPager"), (p) => { page = p; renderTable(); });
  const cell = (v) => (v === null || v === undefined ? "" : esc(v).replace(/\n/g, "<br>"));
  const renderTable = () => {
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const shown = rows.slice((page - 1) * SIZE, page * SIZE);
    q(".gTable").innerHTML = cols.length
      ? `<tr>${cols.map((k) => `<th>${esc(k)}</th>`).join("")}</tr>` + shown.map((c) => `<tr>${cols.map((k) => `<td>${cell(c[k])}</td>`).join("")}</tr>`).join("")
      : "";
    pages.set(page, Math.ceil(rows.length / SIZE));
  };
  const load = async () => {
    const hours = Number(q(".gSince").value);
    const since = hours ? new Date(Date.now() - hours * 3600e3).toISOString() : "";
    q(".gNote").textContent = "טוען...";
    try {
      const r = await get(`/test/gold/changes${since ? `?since=${encodeURIComponent(since)}` : ""}`);
      q(".gNote").textContent = r.count ? `${r.count} אנשי קשר · המשיכה הבאה: since=${r.until}` : "אין שינויים לשלוח";
      rows = r.contacts;
      page = 1;
      renderTable();
      q(".gJson").textContent = JSON.stringify(r, null, 2);
    } catch (e) {
      q(".gNote").innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`;
      rows = [];
      renderTable();
      q(".gJson").textContent = "";
    }
  };
  q(".gLoad").onclick = load;
  q(".gSince").onchange = load;
  load();
  return load;
}

export default {
  id: "gold",
  title: "גולד",
  icon: "gold",
  mount(root) {
    const env = live.env;
    const keyBanner = !env
      ? ""
      : env.gold_api_key_set
        ? `<div class="banner ok">✓ <div><b>GOLD_API_KEY מוגדר</b> בשרת הזה: גולד יכולים למשוך את השינויים מ-<code>/api/gold/changes</code> עם הכותרת <code>X-Api-Key</code>.</div></div>`
        : `<div class="banner warn">⚠ <div><b>GOLD_API_KEY לא מוגדר</b> בשרת הזה: הכתובת של גולד דוחה כל בקשה עד שיוגדר מפתח.</div></div>`;
    root.innerHTML = `<div class="stack">${keyBanner}<div class="card" id="goldCard"></div></div>`;
    mountGoldCard(root.querySelector("#goldCard"));
  },
  unmount() {},
};
