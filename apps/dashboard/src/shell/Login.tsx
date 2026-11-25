/**
 * Logging in (a phone + a password, or the server secret TOOLS_SECRET for the project team) and changing one's own
 * password. The password is read from its field when the form is sent and never kept: not in React state, not in
 * storage, not in a log. The session itself is an HttpOnly cookie this page can't read.
 */
import { useEffect, useRef, useState } from "react";
import { ApiError, post } from "../lib/api";
import { toast } from "../lib/ui-store";

export function LoginDialog({ error, onLogin, onSecret }: {
  error: string | null;
  onLogin: (phone: string, password: string) => Promise<void>;
  onSecret: (secret: string) => Promise<void>;
}) {
  const dlg = useRef<HTMLDialogElement>(null);
  const phone = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const secret = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(error);
  const [busy, setBusy] = useState(false);
  useEffect(() => setMsg(error), [error]);
  useEffect(() => {
    const el = dlg.current;
    if (!el) return;
    if (password.current) password.current.value = "";
    if (secret.current) secret.current.value = "";
    if (!el.open) el.showModal?.();
    phone.current?.focus();
    return () => {
      if (el.open) el.close();
    };
  }, []);
  return (
    <dialog className="modal" id="loginModal" ref={dlg} onCancel={(e) => e.preventDefault() /* Esc doesn't skip the login */}>
      <form
        className="modal-box"
        id="loginForm"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          const p = phone.current?.value.trim() ?? "";
          const pw = password.current?.value ?? "";
          if (!p || !pw) {
            setMsg("הכנס מספר טלפון וסיסמה");
            return;
          }
          setBusy(true);
          try {
            await onLogin(p, pw);
          } catch (err) {
            setMsg((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="login-brand">
          <div className="brand-mark" aria-hidden="true">
            מ
          </div>
          <h2 className="modal-title">כניסה לדשבורד משלב</h2>
        </div>
        <label className="field">
          <span>מספר טלפון</span>
          <input type="tel" id="loginPhone" className="ltr" inputMode="tel" autoComplete="username" placeholder="0501234567" ref={phone} />
        </label>
        <label className="field">
          <span>סיסמה</span>
          <input type="password" id="loginPassword" autoComplete="current-password" ref={password} />
        </label>
        <p className="small login-error" id="loginError" hidden={!msg}>
          {msg}
        </p>
        <div className="modal-actions">
          <button className="btn primary" type="submit" id="loginBtn" disabled={busy}>
            כניסה
          </button>
        </div>
        <details className="small muted login-secret">
          <summary>כניסה עם סיסמת השרת</summary>
          <label className="field">
            <span>
              סיסמת השרת (<code>TOOLS_SECRET</code>)
            </span>
            <input type="password" id="secretInput" autoComplete="off" ref={secret} />
          </label>
          <button
            className="btn"
            type="button"
            id="secretBtn"
            onClick={async () => {
              const value = secret.current?.value.trim() ?? "";
              if (!value) return;
              try {
                await onSecret(value);
              } catch (err) {
                setMsg((err as Error).message);
              }
            }}
          >
            כניסה עם סיסמת השרת
          </button>
        </details>
      </form>
    </dialog>
  );
}

/** The logged-in user's own password. */
export function PasswordDialog({ onClose }: { onClose: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const current = useRef<HTMLInputElement>(null);
  const next = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const el = dlg.current;
    if (!el) return;
    if (!el.open) el.showModal?.();
    current.current?.focus();
    const closed = () => onClose();
    el.addEventListener("close", closed);
    return () => {
      el.removeEventListener("close", closed);
      if (el.open) el.close();
    };
  }, [onClose]);
  return (
    <dialog className="modal" id="pwModal" ref={dlg}>
      <form
        className="modal-box"
        id="pwForm"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await post("/auth/password", { current: current.current?.value ?? "", password: next.current?.value ?? "" });
            if (current.current) current.current.value = "";
            if (next.current) next.current.value = "";
            dlg.current?.close();
            toast("הסיסמה הוחלפה. בדפדפנים אחרים צריך להתחבר מחדש.", "ok");
          } catch (err) {
            setError(err instanceof ApiError || err instanceof Error ? err.message : String(err));
          }
        }}
      >
        <h2 className="modal-title">החלפת סיסמה</h2>
        <label className="field">
          <span>הסיסמה הנוכחית</span>
          <input type="password" id="pwCurrent" autoComplete="current-password" ref={current} />
        </label>
        <label className="field">
          <span>סיסמה חדשה (8 תווים לפחות)</span>
          <input type="password" id="pwNew" autoComplete="new-password" ref={next} />
        </label>
        <p className="small login-error" id="pwError" hidden={!error}>
          {error}
        </p>
        <div className="modal-actions">
          <button className="btn" type="button" id="pwCancel" onClick={() => dlg.current?.close()}>
            ביטול
          </button>
          <button className="btn primary" type="submit">
            שמירה
          </button>
        </div>
      </form>
    </dialog>
  );
}
