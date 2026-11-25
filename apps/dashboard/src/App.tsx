/**
 * Who is this browser: the key from `npm run lab` (#k=) or a saved one, else a session cookie, else the login.
 *
 * A 401 (the session ended, a blocked user, a changed password) clears everything before the login shows: the live
 * poll and the push channel stop, the drawer / toasts / dialogs are emptied, the screens unmount (their data with
 * them) and who was logged in is forgotten. The login then shows over an empty frame. After it, the page reloads (as
 * the old dashboard did): a new person in this browser starts from a clean page.
 */
import { useEffect, useRef, useState } from "react";
import { clearSession, loadSecret, login, onAuthRequired, setSecret, whoAmI } from "./lib/api";
import { stopLive } from "./lib/live";
import { resetUi } from "./lib/ui-store";
import { LoginDialog } from "./shell/Login";
import { Frame, Shell } from "./shell/Shell";
import { resetLogs } from "./views/Logs";

type Phase = "init" | "login" | "app";

/** Everything held in memory for the last user, gone. */
export function endSession() {
  stopLive();
  resetUi();
  resetLogs();
  clearSession();
}

export function App() {
  const [phase, setPhase] = useState<Phase>("init");
  const [loginError, setLoginError] = useState<string | null>(null);
  const booted = useRef(false);

  useEffect(() => {
    loadSecret();
    whoAmI()
      .then((me) => {
        if (me) {
          booted.current = true;
          setPhase("app");
        } else setPhase("login");
      })
      .catch((err: Error) => {
        setLoginError(err.message);
        setPhase("login");
      });
  }, []);

  useEffect(
    () =>
      onAuthRequired(() => {
        endSession();
        setLoginError(null);
        setPhase("login");
      }),
    [],
  );

  const afterLogin = async () => {
    // a new person in this browser: start from a clean page
    if (booted.current) {
      location.reload();
      return;
    }
    const me = await whoAmI();
    if (!me) {
      setLoginError("הכניסה לא הצליחה");
      return;
    }
    booted.current = true;
    setLoginError(null);
    setPhase("app");
  };

  if (phase === "app") return <Shell />;
  return (
    <Frame
      dialogs={
        phase === "login" ? (
        <LoginDialog
          error={loginError}
          onLogin={async (phone, password) => {
            await login(phone, password);
            await afterLogin();
          }}
          onSecret={async (value) => {
            setSecret(value);
            await afterLogin();
          }}
        />
        ) : null
      }
    />
  );
}
