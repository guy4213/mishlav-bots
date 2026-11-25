/**
 * The page-wide overlays: the drawer (contact / call / study day / user), the confirm dialog and the toasts. Their
 * state is in lib/ui-store.ts, so any screen can open them.
 */
import { createContext, type ReactNode, type RefObject, useContext, useEffect, useRef } from "react";
import { closeDrawer, confirmRequest, drawer, toasts } from "../lib/ui-store";
import { Icon } from "./Icon";

const DrawerOpen = createContext(false);
const DrawerBody = createContext<RefObject<HTMLDivElement> | null>(null);
/** Whether the drawer showing this content is still open (its polling stops when it closes). */
export const useDrawerOpen = () => useContext(DrawerOpen);
/** The drawer's scrolling body (a live call keeps it at the bottom, as the old setFollowing did). */
export const useDrawerBody = () => useContext(DrawerBody);

/** What a drawer's content renders: the head (title, sub, close) and the body. */
export function DrawerView({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children: ReactNode }) {
  const body = useDrawerBody();
  return (
    <>
      <header className="drawer-head">
        <div className="drawer-titles">
          <div className="drawer-title">{title}</div>
          <div className="drawer-sub">{sub}</div>
        </div>
        <button className="icon-btn" aria-label="סגירה" onClick={closeDrawer}>
          <Icon name="x" />
        </button>
      </header>
      <div className="drawer-body" ref={body ?? undefined}>
        {children}
      </div>
    </>
  );
}

export function Drawer() {
  const d = drawer.use();
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (d.open && body.current) body.current.scrollTop = 0;
  }, [d.key, d.open]);
  return (
    <>
      <div className="drawer-scrim" hidden={!d.open} onClick={closeDrawer} />
      <aside className={`drawer${d.open ? " open" : ""}`} aria-hidden={!d.open} role="dialog" aria-modal="true">
        <DrawerOpen.Provider value={d.open}>
          <DrawerBody.Provider value={body}>
            {d.content ? (
              <DrawerContent key={d.key}>{d.content}</DrawerContent>
            ) : (
              <>
                <header className="drawer-head">
                  <div className="drawer-titles">
                    <div className="drawer-title" />
                    <div className="drawer-sub" />
                  </div>
                  <button className="icon-btn" aria-label="סגירה" onClick={closeDrawer}>
                    <Icon name="x" />
                  </button>
                </header>
                <div className="drawer-body" ref={body} />
              </>
            )}
          </DrawerBody.Provider>
        </DrawerOpen.Provider>
      </aside>
    </>
  );
}
const DrawerContent = ({ children }: { children: ReactNode }) => <>{children}</>;

/** The confirm dialog: a title, a text, an optional reason field, OK (or a "danger" OK) and cancel. */
export function ConfirmDialog() {
  const req = confirmRequest.use();
  const dlg = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = dlg.current;
    if (!req || !el) return;
    el.returnValue = "";
    if (input.current) input.current.value = "";
    if (!el.open) el.showModal?.();
    (req.input ? input.current : ok.current)?.focus();
    const onClose = () => {
      confirmRequest.set(null);
      req.resolve({ ok: el.returnValue === "ok", value: input.current?.value.trim() ?? "" });
    };
    el.addEventListener("close", onClose, { once: true });
    return () => el.removeEventListener("close", onClose);
  }, [req]);
  useEffect(() => {
    if (!req && dlg.current?.open) dlg.current.close();
  }, [req]);
  return (
    <dialog className="modal" id="modal" ref={dlg}>
      <form method="dialog" className="modal-box" id="modalForm">
        <h2 className="modal-title" id="modalTitle">
          {req?.title}
        </h2>
        <p className="modal-text" id="modalText" hidden={!req?.text}>
          {req?.text}
        </p>
        <label className="field" id="modalField" hidden={!req?.input}>
          <span id="modalLabel">{req?.input?.label ?? ""}</span>
          <input type="text" id="modalInput" maxLength={200} ref={input} placeholder={req?.input?.placeholder ?? ""} />
        </label>
        <div className="modal-actions">
          <button className="btn" value="cancel" id="modalCancel">
            ביטול
          </button>
          <button className={`btn ${req?.danger ? "danger" : "primary"}`} value="ok" id="modalOk" ref={ok}>
            {req?.okLabel ?? "אישור"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function Toasts() {
  const list = toasts.use();
  return (
    <div className="toasts" id="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
