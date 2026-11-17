// The dashboard shell: secret, navigation (#/screen), the top bar (server, dialer, line, live call), theme.
import { get, loadSecret, post, setSecret } from "./api.js";
import { live, liveCall, refreshLive, startLive, subscribe } from "./live.js";
import { $, closeDrawer, confirmDialog, DIALER_STATE_HE, esc, fmtDateTime, fmtDuration, icon, ls, toast } from "./ui.js";
import calls, { openCall } from "./views/calls.js";
import contacts from "./views/contacts.js";
import gold from "./views/gold.js";
import logs from "./views/logs.js";
import overview from "./views/overview.js";
import reps from "./views/reps.js";
import results from "./views/results.js";
import testing from "./views/testing.js";

const VIEWS = [
  { group: "עבודה", items: [overview, contacts, calls, reps] },
  { group: "בדיקות", items: [testing, results] },
  { group: "מערכת", items: [logs, gold] },
];
const ALL = VIEWS.flatMap((g) => g.items);
// old bookmarks (#tab=phone) from the previous dashboard
const LEGACY = { phone: "testing", test: "testing", logs: "logs", results: "results" };

let current = null;
let booted = false;

// ------------------------------------------------------------------ navigation
function routeId() {
  const m = /^#\/([\w-]+)/.exec(location.hash);
  if (m && ALL.some((v) => v.id === m[1])) return m[1];
  const legacy = /[#&]tab=(\w+)/.exec(location.hash)?.[1];
  return LEGACY[legacy] ?? "overview";
}

function renderNav() {
  $("nav").innerHTML = VIEWS.map(
    (g) =>
      `<div class="nav-sep">${esc(g.group)}</div>` +
      g.items.map((v) => `<a href="#/${v.id}" data-id="${v.id}">${icon(v.icon)}<span>${esc(v.title)}</span>${v.id === "reps" ? `<span class="count" id="repCount" hidden></span>` : ""}</a>`).join(""),
  ).join("");
}

function show(id) {
  const view = ALL.find((v) => v.id === id) ?? overview;
  if (current === view) return;
  try { current?.unmount?.(); } catch (e) { console.error(e); }
  closeDrawer();
  current = view;
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.id === view.id));
  $("pageTitle").textContent = view.title;
  document.title = `${view.title} · משלב`;
  const root = $("view");
  root.innerHTML = "";
  root.scrollTop = 0;
  window.scrollTo(0, 0);
  view.mount(root);
  setMenu(false);
}

function setMenu(open) {
  $("sidebar").classList.toggle("open", open);
  $("scrim").hidden = !open;
}

// ------------------------------------------------------------------ top bar
function renderTop() {
  const env = live.env;
  const envPill = env
    ? `<span class="pill" title="השרת שהדף מחובר אליו. הלוגים והקו שייכים לשרת הזה; המסד משותף.">${env.env === "production" ? "🟢 פרודקשן" : "🟡 מקומי"}${env.commit ? ` <span class="faint ltr hide-sm">${esc(env.commit)}</span>` : ""}</span>`
    : "";

  const ph = live.phone;
  const lineOk = ph?.available && ph.status?.registered;
  const linePill = `<span class="pill" title="${esc(ph?.available ? (ph.status?.error ?? "") : (ph?.reason ?? "לא ידוע"))}"><span class="ldot ${lineOk ? "ok" : "bad"}"></span><span class="hide-sm">קו טלפון</span> <b>${lineOk ? "מוכן" : "לא פעיל"}</b></span>`;

  const c = liveCall();
  const elapsed = c ? fmtDuration((Date.now() - new Date(c.started_at).getTime()) / 1000) : "";
  const callPill = c
    ? `<button class="pill live clickable" id="liveCallBtn" title="פתח את השיחה"><span class="ldot live"></span>שיחה חיה <b>${esc(c.name ?? c.number)}</b> <span class="num">${elapsed}</span></button>`
    : "";

  let dialer = "";
  if (!live.dialerAvailable) {
    dialer = `<span class="pill" title="${esc(live.dialerError ?? "Supabase לא מחובר")}"><span class="ldot"></span>חיוג אוטומטי לא זמין</span>`;
  } else if (live.dialer) {
    const d = live.dialer;
    const on = d.enabled === true;
    const tone = !on ? "" : d.state === "error" ? "bad" : d.state === "running" || d.state === "in_call" ? "ok" : "warn";
    const title = [d.reason && `סיבה: ${d.reason}`, d.changed_at && `שונה: ${fmtDateTime(d.changed_at)}`, d.last_error && `תקלה אחרונה: ${d.last_error.message}`].filter(Boolean).join("\n");
    dialer = `<span class="dialer-ctl"><span class="pill" title="${esc(title)}"><span class="ldot ${tone}"></span><span class="hide-sm">חיוג אוטומטי</span> <b>${on ? esc(DIALER_STATE_HE[d.state] ?? d.state) : "כבוי"}</b></span>${
      on ? `<button class="btn danger" id="dialerStop">⏹ עצור חיוג</button>` : `<button class="btn success" id="dialerStart">▶ הפעל חיוג</button>`
    }</span>`;
  }
  // each part only when it changed: a button replaced under the pointer would lose the click
  const parts = { envPill, linePill, callPill, dialer };
  for (const [k, html] of Object.entries(parts)) {
    let el = $(`top-${k}`);
    if (!el) $("topStatus").append((el = Object.assign(document.createElement("span"), { id: `top-${k}`, className: "row" })));
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
    el.hidden = !html;
  }
  const foot = env ? `${env.env === "production" ? "שרת פרודקשן (Render)" : "שרת מקומי"} · Supabase ${env.supabase ? "מחובר" : "לא מחובר"} · SMS: ${env.sms_provider === "zadarma" ? "Zadarma" : "לוג בלבד"}` : "";
  $("sidebarFoot").textContent = foot;
}

async function stopDialer() {
  const r = await confirmDialog({
    title: "לעצור את החיוג האוטומטי?",
    text: "לא יתחילו שיחות חדשות. שיחה שכבר רצה תסתיים כרגיל. המצב נשמר במסד, כך שגם הפעלה מחדש של השרת לא תדליק אותו.",
    input: { label: "סיבה (רשות)", placeholder: "למשל: סוף יום, בדיקה" },
    okLabel: "⏹ עצור חיוג",
    danger: true,
  });
  if (!r.ok) return;
  try {
    await post("/api/admin/dialer/stop", r.value ? { reason: r.value } : {});
    toast("החיוג האוטומטי נעצר", "ok");
  } catch (e) { toast(e.message, "bad"); }
  refreshLive();
}

async function startDialer() {
  const only = live.dialer?.only_numbers;
  const r = await confirmDialog({
    title: "להפעיל את החיוג האוטומטי?",
    text: `הבוט יתחיל להתקשר ללקוחות שבתור, אחד אחרי השני, בשעות הפעילות בלבד. ההפעלה נשמרת במסד ונשארת גם אחרי הפעלה מחדש, עד שעוצרים.${only ? "<br><b>מוגבל למספרים ב-DIALER_ONLY_NUMBERS.</b>" : ""}`,
    input: { label: "סיבה (רשות)", placeholder: "למשל: תחילת יום" },
    okLabel: "▶ הפעל חיוג",
  });
  if (!r.ok) return;
  try {
    await post("/api/admin/dialer/start", r.value ? { reason: r.value } : {});
    toast("החיוג האוטומטי הופעל", "ok");
  } catch (e) { toast(e.message, "bad"); }
  refreshLive();
}

async function refreshRepCount() {
  try {
    const r = await get("/api/admin/rep-tasks?open=1");
    const el = $("repCount");
    if (el) { el.textContent = r.tasks.length; el.hidden = !r.tasks.length; }
  } catch { /* no Supabase: no badge */ }
}

// ------------------------------------------------------------------ theme
function effectiveTheme() {
  const t = document.documentElement.dataset.theme;
  if (t) return t;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function renderThemeBtn() {
  $("themeBtn").innerHTML = icon(effectiveTheme() === "dark" ? "sun" : "moon");
}
function toggleTheme() {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  ls.set("mishlav_theme", next);
  renderThemeBtn();
}

// ------------------------------------------------------------------ secret + boot
function askSecret() {
  const dlg = $("secretModal");
  if (dlg.open) return;
  $("secretInput").value = "";
  dlg.showModal();
}

function boot() {
  if (booted) return;
  booted = true;
  startLive();
  subscribe(renderTop);
  setInterval(renderTop, 1000); // the live call's clock
  refreshRepCount();
  setInterval(refreshRepCount, 30_000);
  show(routeId());
}

function init() {
  $("menuBtn").innerHTML = icon("menu");
  $("drawerClose").innerHTML = icon("x");
  renderNav();
  renderThemeBtn();
  $("themeBtn").onclick = toggleTheme;
  $("menuBtn").onclick = () => setMenu(!$("sidebar").classList.contains("open"));
  $("scrim").onclick = () => setMenu(false);
  $("drawerClose").onclick = closeDrawer;
  $("drawerScrim").onclick = closeDrawer;
  $("topStatus").addEventListener("click", (e) => {
    if (e.target.closest("#dialerStop")) stopDialer();
    else if (e.target.closest("#dialerStart")) startDialer();
    else if (e.target.closest("#liveCallBtn")) { const c = liveCall(); if (c) openCall(c.id); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderThemeBtn);
  window.addEventListener("hashchange", () => booted && show(routeId()));
  window.addEventListener("auth-required", askSecret);
  $("secretForm").addEventListener("submit", () => {
    setSecret($("secretInput").value.trim());
    if (booted) location.reload();
    else boot();
  });
  if (loadSecret()) boot();
  else askSecret();
}

init();
