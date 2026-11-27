/**
 * The dashboard shell (port of app.js): navigation (#/screen) by role, the top bar (server, dialer, line, live call),
 * the user box, "view as Mishlav", the theme and the mobile menu. Mishlav's users (role "mishlav") see the work screens
 * and a test call to themselves; the rest is ours (admin).
 *
 * <Frame> is the page without data: the login shows over it (at the start, and after a 401, when every screen has
 * already been unmounted and every store cleared - no customer's data stays behind the dialog).
 */
import { type ReactNode, useEffect, useState } from "react";
import { get, isAdmin, logout, post, session, setViewAs } from "../lib/api";
import { fmtDateTime, fmtDuration, localPhone } from "../lib/format";
import { DIALER_STATE_HE } from "../lib/labels";
import { liveCall, refreshLive, startLive, stopLive, useLive } from "../lib/live";
import { closeDrawer, confirmDialog, toast } from "../lib/ui-store";
import { readKey, writeKey, KEYS } from "../lib/storage";
import { Icon } from "../components/Icon";
import { ConfirmDialog, Drawer, Toasts } from "../components/Overlays";
import { openCall } from "../views/drawers";
import { PasswordDialog } from "./Login";
import { ALL_VIEWS, OVERVIEW, VIEWS, allowed, routeId } from "./routes";

// ------------------------------------------------------------------ theme
const darkSystem = () => matchMedia("(prefers-color-scheme: dark)").matches;
const effectiveTheme = () => document.documentElement.dataset.theme ?? (darkSystem() ? "dark" : "light");

function ThemeButton() {
  const [theme, setTheme] = useState(effectiveTheme);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setTheme(effectiveTheme());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const toggle = () => {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    writeKey(KEYS.theme, next);
    setTheme(next);
  };
  return (
    <button className="icon-btn" id="themeBtn" aria-label="מצב בהיר / כהה" title="מצב בהיר / כהה" onClick={toggle}>
      <Icon name={theme === "dark" ? "sun" : "moon"} />
    </button>
  );
}
// the stored theme was applied before the first paint (public/theme.js); keep it applied after a reload in dev too
const stored = readKey(KEYS.theme);
if ((stored === "light" || stored === "dark") && !document.documentElement.dataset.theme) document.documentElement.dataset.theme = stored;

/** The page without data: the brand, an empty sidebar and top bar, the overlays. */
export function Frame({ nav, userBox, foot, viewAsBar, title = "סקירה", status, menuOpen = false, setMenu, dialogs, children }: {
  /** dialogs of the shell (the password one): next to the page's other dialogs, outside the screen */
  dialogs?: ReactNode;
  nav?: ReactNode;
  userBox?: ReactNode;
  foot?: ReactNode;
  viewAsBar?: ReactNode;
  title?: string;
  status?: ReactNode;
  menuOpen?: boolean;
  setMenu?: (open: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <>
      <div className="app" id="app">
        <aside className={`sidebar${menuOpen ? " open" : ""}`} id="sidebar" aria-label="ניווט">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">
              מ
            </div>
            <div>
              <div className="brand-name">משלב</div>
              <div className="brand-sub">ניהול בוט ימי העיון</div>
            </div>
          </div>
          <nav className="nav" id="nav">
            {nav}
          </nav>
          {userBox ?? <div className="user-box" id="userBox" hidden />}
          <div className="sidebar-foot" id="sidebarFoot">
            {foot ?? ""}
          </div>
        </aside>
        <div className="scrim" id="scrim" hidden={!menuOpen} onClick={() => setMenu?.(false)} />
        <div className="main">
          {viewAsBar ?? <div className="view-as-bar" id="viewAsBar" hidden />}
          <header className="topbar" id="topbar">
            <button className="icon-btn only-mobile" id="menuBtn" aria-label="תפריט" onClick={() => setMenu?.(!menuOpen)}>
              <Icon name="menu" />
            </button>
            <h1 className="page-title" id="pageTitle">
              {title}
            </h1>
            <div className="topbar-status" id="topStatus">
              {status}
            </div>
            <ThemeButton />
          </header>
          <main className="content" id="view" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
      <Drawer />
      <ConfirmDialog />
      {dialogs}
      <Toasts />
    </>
  );
}

// ------------------------------------------------------------------ the top bar
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
  } catch (e) {
    toast((e as Error).message, "bad");
  }
  void refreshLive();
}

async function startDialer(only: boolean) {
  const r = await confirmDialog({
    title: "להפעיל את החיוג האוטומטי?",
    text: (
      <>
        הבוט יתחיל להתקשר ללקוחות שבתור, אחד אחרי השני, בשעות הפעילות בלבד. ההפעלה נשמרת במסד ונשארת גם אחרי הפעלה מחדש, עד שעוצרים.
        {only ? (
          <>
            <br />
            <b>מוגבל למספרים ב-DIALER_ONLY_NUMBERS.</b>
          </>
        ) : null}
      </>
    ),
    input: { label: "סיבה (רשות)", placeholder: "למשל: תחילת יום" },
    okLabel: "▶ הפעל חיוג",
  });
  if (!r.ok) return;
  try {
    await post("/api/admin/dialer/start", r.value ? { reason: r.value } : {});
    toast("החיוג האוטומטי הופעל", "ok");
  } catch (e) {
    toast((e as Error).message, "bad");
  }
  void refreshLive();
}

/** One part of the top bar, in its own span (hidden while empty), as the old one drew them. */
const Part = ({ k, children }: { k: string; children: ReactNode }) => (
  <span id={`top-${k}`} className="row" hidden={!children}>
    {children}
  </span>
);

function TopStatus() {
  const live = useLive();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000); // the live call's clock
    return () => clearInterval(t);
  }, []);
  const env = live.env;
  const envPill = env ? (
    <span className="pill" title="השרת שהדף מחובר אליו. הלוגים והקו שייכים לשרת הזה; המסד משותף.">
      {env.env === "production" ? "🟢 פרודקשן" : "🟡 מקומי"}
      {env.commit ? (
        <>
          {" "}
          <span className="faint ltr hide-sm">{env.commit}</span>
        </>
      ) : null}
    </span>
  ) : null;

  const ph = live.phone;
  const lineOk = !!(ph?.available && ph.status?.registered);
  const linePill = (
    <span className="pill" title={ph?.available ? (ph.status?.error ?? "") : (ph?.reason ?? "לא ידוע")}>
      <span className={`ldot ${lineOk ? "ok" : "bad"}`} />
      <span className="hide-sm">קו טלפון</span> <b>{lineOk ? "מוכן" : "לא פעיל"}</b>
    </span>
  );

  const c = liveCall(live);
  const callPill = c ? (
    <button className="pill live clickable" id="liveCallBtn" title="פתח את השיחה" onClick={() => openCall(c.id)}>
      <span className="ldot live" />
      שיחה חיה <b>{c.name ?? c.number}</b> <span className="num">{fmtDuration((Date.now() - new Date(c.started_at).getTime()) / 1000)}</span>
    </button>
  ) : null;

  let dialer: ReactNode = null;
  if (!live.dialerAvailable) {
    dialer = (
      <span className="pill" title={live.dialerError ?? "Supabase לא מחובר"}>
        <span className="ldot" />
        חיוג אוטומטי לא זמין
      </span>
    );
  } else if (live.dialer) {
    const d = live.dialer;
    const on = d.enabled === true;
    const tone = !on ? "" : d.state === "error" ? "bad" : d.state === "running" || d.state === "in_call" ? "ok" : "warn";
    const title = [d.reason && `סיבה: ${d.reason}`, d.changed_at && `שונה: ${fmtDateTime(d.changed_at)}`, d.last_error && `תקלה אחרונה: ${d.last_error.message}`]
      .filter(Boolean)
      .join("\n");
    // the switch is ours (admin); Mishlav's users see the state only
    const btn = !isAdmin() ? null : on ? (
      <button className="btn danger" id="dialerStop" onClick={() => void stopDialer()}>
        ⏹ עצור חיוג
      </button>
    ) : (
      <button className="btn success" id="dialerStart" onClick={() => void startDialer(!!d.only_numbers)}>
        ▶ הפעל חיוג
      </button>
    );
    dialer = (
      <span className="dialer-ctl">
        <span className="pill" title={title}>
          <span className={`ldot ${tone}`} />
          <span className="hide-sm">חיוג אוטומטי</span> <b>{on ? (DIALER_STATE_HE[d.state] ?? d.state) : "כבוי"}</b>
        </span>
        {btn}
      </span>
    );
  }
  return (
    <>
      <Part k="envPill">{envPill}</Part>
      <Part k="linePill">{linePill}</Part>
      <Part k="callPill">{callPill}</Part>
      <Part k="dialer">{dialer}</Part>
    </>
  );
}

function SidebarFoot() {
  const env = useLive().env;
  return (
    <>
      {env
        ? `${env.env === "production" ? "שרת פרודקשן (Render)" : "שרת מקומי"} · Supabase ${env.supabase ? "מחובר" : "לא מחובר"} · וואטסאפ: ${env.whatsapp_provider === "texter" ? "Texter" : "לא מוגדר"}`
        : ""}
    </>
  );
}

const ROLE_HE: Record<string, string> = { admin: "צוות הפרויקט", mishlav: "משלב" };

function UserBox({ onPassword }: { onPassword: () => void }) {
  const u = session.user;
  return (
    <div className="user-box" id="userBox">
      <div className="user-name">{u?.name ?? "סיסמת השרת"}</div>
      <div className="user-sub">
        {ROLE_HE[session.role ?? ""] ?? session.role}
        {u ? (
          <>
            {" · "}
            <span className="ltr">{localPhone(u.phone)}</span>
          </>
        ) : null}
      </div>
      {session.server ? (
        <div className="user-sub" id="serverVersion" title={session.server.commit ? `commit ${session.server.commit}` : ""}>
          גרסה {session.server.version} · עלתה {fmtDateTime(session.server.started_at)}
        </div>
      ) : null}
      <div className="row user-actions">
        {u ? (
          <button className="btn sm" id="pwBtn" onClick={onPassword}>
            החלפת סיסמה
          </button>
        ) : null}
        <button
          className="btn sm"
          id="logoutBtn"
          onClick={async () => {
            stopLive();
            await logout();
            location.reload();
          }}
        >
          יציאה
        </button>
      </div>
      {isAdmin() ? (
        <button
          className="btn sm view-as-btn"
          id="viewAsBtn"
          title="לראות בדיוק מה שאנשי משלב רואים"
          onClick={() => {
            setViewAs(true);
            location.reload();
          }}
        >
          <Icon name="eye" /> צפייה כמו משלב
        </button>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ navigation
function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

function RepCount() {
  const [total, setTotal] = useState<number | null>(null);
  useEffect(() => {
    const refresh = async () => {
      if (document.hidden) return; // a tab in the background asks nothing
      try {
        const r = await get("/api/admin/rep-tasks?open=1"); // the total of all open ones (the rows are one page)
        setTotal(r.total);
      } catch {
        // no Supabase: no badge
      }
    };
    void refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="count" id="repCount" hidden={!total}>
      {total ?? ""}
    </span>
  );
}

/** The dashboard once someone is logged in. */
export function Shell() {
  const hash = useHash();
  const id = routeId(hash, session.role);
  const view = ALL_VIEWS.find((v) => v.id === id) ?? OVERVIEW;
  const [menuOpen, setMenu] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);

  useEffect(() => {
    startLive();
    return () => stopLive();
  }, []);

  // a new screen: the drawer closes, the page starts at the top, the menu closes, the tab says which screen
  useEffect(() => {
    closeDrawer();
    document.title = `${view.title} · משלב`;
    const root = document.getElementById("view");
    if (root) root.scrollTop = 0;
    window.scrollTo(0, 0);
    setMenu(false);
  }, [view.id, view.title]);

  // Esc closes the drawer
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawer();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const groups = VIEWS.map((g) => ({ ...g, items: g.items.filter((v) => allowed(v.id, session.role)) })).filter((g) => g.items.length);
  const nav = groups.map((g) => (
    <NavGroup key={g.group} title={g.group}>
      {g.items.map((v) => (
        <a key={v.id} href={`#/${v.id}`} data-id={v.id} className={v.id === view.id ? "on" : undefined}>
          <Icon name={v.icon} />
          <span>{v.title}</span>
          {v.id === "reps" ? <RepCount /> : null}
        </a>
      ))}
    </NavGroup>
  ));
  const Current = view.Component;
  return (
    <Frame
      nav={nav}
      userBox={<UserBox onPassword={() => setPwOpen(true)} />}
      foot={<SidebarFoot />}
      viewAsBar={
        <div className="view-as-bar" id="viewAsBar" hidden={!session.viewingAs}>
          <span>אתה רואה את הדשבורד בדיוק כמו משתמש של משלב</span>
          <button
            className="btn sm"
            id="viewAsExit"
            onClick={() => {
              setViewAs(false);
              location.reload();
            }}
          >
            חזרה לאדמין
          </button>
        </div>
      }
      title={view.title}
      status={<TopStatus />}
      menuOpen={menuOpen}
      setMenu={setMenu}
      dialogs={pwOpen ? <PasswordDialog onClose={() => setPwOpen(false)} /> : null}
    >
      <Current key={view.id} />
    </Frame>
  );
}

const NavGroup = ({ title, children }: { title: string; children: ReactNode }) => (
  <>
    <div className="nav-sep">{title}</div>
    {children}
  </>
);
