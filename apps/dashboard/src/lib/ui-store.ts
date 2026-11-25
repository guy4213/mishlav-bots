/**
 * The page-wide parts every screen can use without passing anything down: toasts, the confirm dialog and the drawer
 * (one at a time, like the old ui.js). Small stores read with useSyncExternalStore.
 */
import { type ReactNode, useSyncExternalStore } from "react";

function store<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set: (v: T) => {
      value = v;
      subs.forEach((fn) => fn());
    },
    use: () =>
      useSyncExternalStore(
        (fn) => {
          subs.add(fn);
          return () => void subs.delete(fn);
        },
        () => value,
      ),
  };
}

// ------------------------------------------------------------------ toasts
export interface Toast {
  id: number;
  text: string;
  tone: string;
}
export const toasts = store<Toast[]>([]);
let toastId = 0;
export function toast(text: string, tone = "") {
  const t = { id: ++toastId, text, tone };
  toasts.set([...toasts.get(), t]);
  setTimeout(() => toasts.set(toasts.get().filter((x) => x.id !== t.id)), 3800);
}

// ------------------------------------------------------------------ confirm (with an optional text input)
export interface ConfirmRequest {
  id: number;
  title: string;
  text?: ReactNode;
  input?: { label: string; placeholder?: string } | null;
  okLabel?: string;
  danger?: boolean;
  resolve: (r: { ok: boolean; value: string }) => void;
}
export const confirmRequest = store<ConfirmRequest | null>(null);
let confirmId = 0;
export function confirmDialog(opts: Omit<ConfirmRequest, "id" | "resolve">): Promise<{ ok: boolean; value: string }> {
  return new Promise((resolve) => confirmRequest.set({ ...opts, id: ++confirmId, resolve }));
}

// ------------------------------------------------------------------ the drawer: one at a time; its timers die with it
export interface DrawerState {
  /** a new one each time a drawer opens: its content mounts afresh */
  key: number;
  open: boolean;
  content: ReactNode;
}
export const drawer = store<DrawerState>({ key: 0, open: false, content: null });
let drawerKey = 0;
/** Opens `content` (a component that renders <DrawerView>) in the drawer, closing the one before. */
export function openDrawer(content: ReactNode) {
  drawer.set({ key: ++drawerKey, open: true, content });
}
/** Closes it: its content stays drawn while it slides out, its polling stops (useDrawerOpen). */
export function closeDrawer() {
  const d = drawer.get();
  if (d.open) drawer.set({ ...d, open: false });
}
/** Forgets the drawer's content (a 401, a logout). */
export function resetDrawer() {
  drawer.set({ key: ++drawerKey, open: false, content: null });
}

/** Everything the page-wide stores hold (a 401, a logout): no message or drawer of the last user stays. */
export function resetUi() {
  resetDrawer();
  toasts.set([]);
  const c = confirmRequest.get();
  confirmRequest.set(null);
  c?.resolve({ ok: false, value: "" });
}
