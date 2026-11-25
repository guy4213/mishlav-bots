/**
 * משתמשים (admins only; port of views/users.js): who may log in to the dashboard - a phone + a password each, role
 * "משלב" or "צוות הפרויקט". Add, rename, change role, block / unblock, set a new password. Never deleted: blocking keeps
 * the history. A new password is shown once in the drawer and kept nowhere else.
 */
import { useRef, useState, useEffect } from "react";
import { Icon } from "../components/Icon";
import { DrawerView } from "../components/Overlays";
import { Chip, EmptyState, ErrorState, LoadingState } from "../components/ui";
import { ApiError, get, post, session } from "../lib/api";
import { fmtDateTime, localPhone } from "../lib/format";
import type { User } from "../lib/types";
import { closeDrawer, confirmDialog, openDrawer, toast } from "../lib/ui-store";

const ROLE_HE: Record<string, string> = { mishlav: "משלב", admin: "צוות הפרויקט" };
const ROLE_TEXT: Record<string, string> = {
  mishlav: "רואים: סקירה, שיחות והקלטות, אנשי קשר, משימות לנציגים, ימי עיון (גם עריכה), ושיחת בדיקה למספר שלהם בלבד.",
  admin: "הכול: גם לוגים, הפעלת וכיבוי החיוג, קול הבוט, בדיקות, גולד והמשתמשים.",
};

/** 10 characters, no look-alikes (0/O, 1/l/I): easy to read out on the phone. */
function newPassword() {
  const abc = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => abc[b % abc.length]).join("");
}

/** The users as last read (the drawers reopen a user from here after a change). */
let users: User[] = [];
let reloadUsers: () => Promise<void> = async () => {};

export default function Users() {
  const [list, setList] = useState<User[] | null>(null);
  const [error, setError] = useState<{ msg: string; noSupabase: boolean } | null>(null);
  const load = async () => {
    try {
      users = (await get<{ users: User[] }>("/api/admin/users")).users;
      setList(users);
      setError(null);
    } catch (e) {
      const msg = (e as Error).message;
      setError({ msg, noSupabase: /Supabase/.test(msg) });
    }
  };
  reloadUsers = load;
  useEffect(() => {
    void load();
    return () => {
      users = [];
      reloadUsers = async () => {};
    };
  }, []);
  return (
    <>
      <div className="toolbar">
        <span className="muted small" id="usCount">
          {list ? `${list.filter((u) => u.active).length} פעילים מתוך ${list.length}` : ""}
        </span>
        <span className="spacer" />
        <button className="btn primary" id="usNew" onClick={() => openDrawer(<UserForm user={null} />)}>
          <Icon name="plus" /> משתמש חדש
        </button>
      </div>
      <div className="card" id="usBody">
        {error ? (
          error.noSupabase ? (
            <EmptyState title="אין משתמשים בשרת הזה" text={error.msg} icon="alert" />
          ) : (
            <ErrorState msg={error.msg} />
          )
        ) : !list ? (
          <LoadingState rows={5} />
        ) : !list.length ? (
          <EmptyState title="עוד אין משתמשים" text='הוסף את עובדי משלב בכפתור "משתמש חדש".' icon="users" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>שם</th>
                  <th>טלפון</th>
                  <th>הרשאה</th>
                  <th>מצב</th>
                  <th>כניסה אחרונה</th>
                </tr>
              </thead>
              <tbody>
                {list.map((u) => (
                  <tr key={u.id} className="click" data-id={u.id} onClick={() => openDrawer(<UserForm user={u} />)}>
                    <td className="cell-main">
                      {u.name}
                      {u.id === session.user?.id ? (
                        <>
                          {" "}
                          <span className="faint small">(אתה)</span>
                        </>
                      ) : null}
                    </td>
                    <td className="ltr num">{localPhone(u.phone)}</td>
                    <td>
                      <Chip label={ROLE_HE[u.role] ?? u.role} tone={u.role === "admin" ? "violet" : "info"} />
                    </td>
                    <td>{u.active ? <Chip label="פעיל" tone="success" dot /> : <Chip label="חסום" tone="danger" dot />}</td>
                    <td className="nowrap small">{u.last_login_at ? fmtDateTime(u.last_login_at) : <span className="faint">עוד לא נכנס</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="small muted">
        כל אחד נכנס עם מספר הטלפון שלו וסיסמה. משתמש לא נמחק – חוסמים אותו. חסימה, שינוי הרשאה או סיסמה חדשה תופסים תוך דקה, והחיבורים הפתוחים שלו מתנתקים.
      </p>
    </>
  );
}

// ------------------------------------------------------------------ add / edit one user

function UserForm({ user }: { user: User | null }) {
  const editing = !!user;
  const me = editing && user.id === session.user?.id;
  const [role, setRole] = useState(user?.role ?? "mishlav");
  const [error, setError] = useState<{ msg: string; fields: string[] } | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const pw = useRef<HTMLInputElement>(null);
  const [initialPw] = useState(newPassword);
  const val = (n: string) => ((form.current?.elements.namedItem(n) as HTMLInputElement | null)?.value ?? "").trim();
  const bad = (f: string) => (error?.fields.includes(f) ? " bad" : "");

  const submit = async () => {
    try {
      if (editing) {
        await post(`/api/admin/users/${encodeURIComponent(user.id)}`, { name: val("name"), role });
        toast("נשמר", "ok");
      } else {
        const password = val("password");
        const r = await post("/api/admin/users", { name: val("name"), phone: val("phone"), role, password });
        await reloadUsers();
        openDrawer(<ShowPassword user={r.user} password={password} />);
        return;
      }
      await reloadUsers();
      closeDrawer();
    } catch (err) {
      setError({ msg: (err as Error).message, fields: err instanceof ApiError ? err.fields : [] });
    }
  };
  const reset = async () => {
    const ok = await confirmDialog({
      title: `סיסמה חדשה ל${user!.name}?`,
      text: "הסיסמה הנוכחית תפסיק לעבוד, וכל החיבורים הפתוחים שלו יתנתקו תוך דקה.",
      okLabel: "יצירת סיסמה חדשה",
    });
    if (!ok.ok) return;
    const password = newPassword();
    try {
      await post(`/api/admin/users/${encodeURIComponent(user!.id)}/password`, { password });
      await reloadUsers();
      openDrawer(<ShowPassword user={user!} password={password} />);
    } catch (err) {
      toast((err as Error).message, "bad");
    }
  };
  const toggleActive = async () => {
    if (user!.active) {
      const ok = await confirmDialog({
        title: `לחסום את ${user!.name}?`,
        text: "לא יוכל להיכנס, והחיבורים הפתוחים שלו יתנתקו תוך דקה. אפשר לבטל את החסימה מתי שרוצים.",
        okLabel: "חסימה",
        danger: true,
      });
      if (!ok.ok) return;
    }
    try {
      await post(`/api/admin/users/${encodeURIComponent(user!.id)}`, { active: !user!.active });
      toast(user!.active ? "נחסם" : "החסימה בוטלה", "ok");
      await reloadUsers();
      const fresh = users.find((u) => u.id === user!.id);
      if (fresh) openDrawer(<UserForm user={fresh} />);
    } catch (err) {
      toast((err as Error).message, "bad");
    }
  };

  return (
    <DrawerView title={editing ? user.name : "משתמש חדש"} sub={editing ? <span className="ltr">{localPhone(user.phone)}</span> : ""}>
      <form
        id="usForm"
        className="form-grid"
        noValidate
        ref={form}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className={`field full${bad("name")}`} data-f="name">
          שם
          <input type="text" name="name" defaultValue={user?.name ?? ""} maxLength={80} required />
        </label>
        <label className={`field full${bad("phone")}`} data-f="phone">
          מספר טלפון (איתו נכנסים, ואליו שיחת הבדיקה)
          <input type="tel" name="phone" className="ltr" inputMode="tel" defaultValue={localPhone(user?.phone)} readOnly={editing} placeholder="0501234567" />
        </label>
        <div className={`field full${bad("role")}`} data-f="role">
          הרשאה
          <div className="seg" id="usRole">
            <button type="button" data-v="mishlav" className={role === "mishlav" ? "on" : ""} disabled={me} onClick={() => setRole("mishlav")}>
              משלב
            </button>
            <button type="button" data-v="admin" className={role === "admin" ? "on" : ""} onClick={() => setRole("admin")}>
              צוות הפרויקט
            </button>
          </div>
          <span className="small muted" id="usRoleText">
            {ROLE_TEXT[role]}
          </span>
        </div>
        {editing ? null : (
          <label className={`field full${bad("password")}`} data-f="password">
            סיסמה ראשונה (8 תווים לפחות)
            <span className="row">
              <input type="text" name="password" className="ltr" defaultValue={initialPw} autoComplete="off" style={{ flex: 1 }} ref={pw} />
              <button
                className="btn sm"
                type="button"
                id="usGen"
                onClick={() => {
                  if (pw.current) pw.current.value = newPassword();
                }}
              >
                סיסמה אחרת
              </button>
            </span>
            <span className="small muted">תעביר אותה לעובד. הוא יכול להחליף אותה אחרי הכניסה ("החלפת סיסמה").</span>
          </label>
        )}
        <div className="full small" id="usError" style={{ color: "var(--danger)" }} hidden={!error}>
          {error?.msg}
        </div>
        <div className="row full" style={{ marginTop: 6 }}>
          <button className="btn primary" type="submit">
            {editing ? "שמירה" : "הוספה"}
          </button>
          <button className="btn ghost" type="button" id="usCancel" onClick={closeDrawer}>
            ביטול
          </button>
        </div>
      </form>
      {editing ? (
        <>
          <div className="section-title">פעולות</div>
          <div className="row">
            <button className="btn" id="usReset" onClick={() => void reset()}>
              סיסמה חדשה
            </button>
            {me ? null : (
              <button className={`btn ${user.active ? "danger" : "success"}`} id="usActive" onClick={() => void toggleActive()}>
                {user.active ? "חסימה" : "ביטול החסימה"}
              </button>
            )}
          </div>
          <div className="section-title">פרטים</div>
          <dl className="kv">
            <dt>נוסף</dt>
            <dd>{fmtDateTime(user.created_at)}</dd>
            <dt>כניסה אחרונה</dt>
            <dd>{user.last_login_at ? fmtDateTime(user.last_login_at) : "עוד לא נכנס"}</dd>
            <dt>סיסמה הוחלפה</dt>
            <dd>{fmtDateTime(user.password_changed_at)}</dd>
          </dl>
        </>
      ) : null}
    </DrawerView>
  );
}

/** The password, once: it is not kept anywhere readable (it lives in this drawer until it closes). */
function ShowPassword({ user, password }: { user: User; password: string }) {
  return (
    <DrawerView title={`הסיסמה של ${user.name}`} sub={<span className="ltr">{localPhone(user.phone)}</span>}>
      <div className="banner ok" style={{ display: "block" }}>
        <div>
          כניסה עם <b className="ltr">{localPhone(user.phone)}</b> והסיסמה:
        </div>
        <div className="ltr" style={{ fontSize: "1.4em", fontWeight: 600, letterSpacing: ".05em", margin: "10px 0" }}>
          {password}
        </div>
        <button
          className="btn sm"
          id="usCopy"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(password);
              toast("הועתק", "ok");
            } catch {
              toast("לא הצלחתי להעתיק – סמן והעתק ידנית", "bad");
            }
          }}
        >
          העתקה
        </button>
      </div>
      <p className="small muted">הסיסמה מוצגת עכשיו בלבד – היא לא נשמרת בשום מקום שאפשר לקרוא. אם תאבד: "סיסמה חדשה".</p>
    </DrawerView>
  );
}
