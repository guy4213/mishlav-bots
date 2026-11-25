/**
 * The only things this page keeps in the browser: preferences and the key from `npm run lab`. Never a customer's data
 * (no names, no calls, no lists): the screens' data lives in memory and is gone with a reload or a logout.
 * Every access is wrapped: a private window or blocked storage throws, and the page works without it.
 */
export const KEYS = {
  /** TOOLS_SECRET (#k= from `npm run lab`, or typed in the login): sent as x-tools-secret */
  secret: "mishlav_secret",
  theme: "mishlav_theme",
  /** sessionStorage: an admin viewing as Mishlav's users ("mishlav"), this tab only */
  viewAs: "mishlav_view_as",
  /** sessionStorage: the contacts screen's tab */
  contactsView: "mishlav_contacts_view",
  callsOrigin: "mishlav_calls_origin",
  callsRecOnly: "mishlav_calls_rec_only",
  /** the number last typed for a test call (the testing screen) */
  phone: "mishlav_phone",
} as const;

type Area = "local" | "session";
const area = (a: Area): Storage => (a === "local" ? localStorage : sessionStorage);

export function readKey(key: string, where: Area = "local"): string | null {
  try {
    return area(where).getItem(key);
  } catch {
    return null;
  }
}

export function writeKey(key: string, value: string | null, where: Area = "local"): void {
  try {
    if (value === null) area(where).removeItem(key);
    else area(where).setItem(key, value);
  } catch {
    // blocked storage: the preference is just not kept
  }
}

/** ui.js `ls`: get with a default, set as a string. */
export const ls = {
  get: <D>(k: string, d: D): string | D => readKey(k) ?? d,
  set: (k: string, v: unknown) => writeKey(k, String(v)),
};
