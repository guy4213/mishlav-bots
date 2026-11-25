/** Dates, times, durations, costs and phones: always Israel time, the same formats as the old dashboard's ui.js. */
import { TZ } from "./labels";

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("he-IL", { timeZone: TZ, ...opts });
const F_DT = fmt({ weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
const F_DATE = fmt({ day: "numeric", month: "numeric", year: "numeric" });
const F_TIME = fmt({ hour: "2-digit", minute: "2-digit", hour12: false });
const F_TIMES = fmt({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const REL = new Intl.RelativeTimeFormat("he", { numeric: "auto" });
const valid = (iso: string | null | undefined): iso is string => !!iso && !Number.isNaN(new Date(iso).getTime());

export const fmtDateTime = (iso: string | null | undefined) => (valid(iso) ? F_DT.format(new Date(iso)) : "—");
export const fmtDate = (iso: string | null | undefined) => (valid(iso) ? F_DATE.format(new Date(iso)) : "—");
export const fmtTime = (iso: string | null | undefined) => (valid(iso) ? F_TIME.format(new Date(iso)) : "—");
export const fmtTimeSec = (iso: string | null | undefined) => (valid(iso) ? F_TIMES.format(new Date(iso)) : "");

export function fmtRel(iso: string | null | undefined, now = Date.now()): string {
  if (!valid(iso)) return "";
  const s = (new Date(iso).getTime() - now) / 1000;
  const a = Math.abs(s);
  if (a < 45) return "עכשיו";
  if (a < 3600) return REL.format(Math.round(s / 60), "minute");
  if (a < 86400) return REL.format(Math.round(s / 3600), "hour");
  return REL.format(Math.round(s / 86400), "day");
}

/** Gemini cost of a call: "$0.124 · $0.062/דקה" (per minute when the duration is known), or — */
export function fmtCost(usd: number | null | undefined, sec: number | null | undefined): string {
  if (usd === null || usd === undefined || Number.isNaN(Number(usd))) return "—";
  const v = Number(usd);
  const perMin = sec && sec > 0 ? ` · $${((v / sec) * 60).toFixed(3)}/דקה` : "";
  return `$${v.toFixed(3)}${perMin}`;
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || Number.isNaN(Number(sec))) return "—";
  const s = Math.max(0, Math.round(Number(sec)));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** +972534271418 / 0534271418 -> 053-4271418 (as written in Israel); anything else as it is */
export function fmtPhone(n: string | null | undefined): string {
  const d = String(n ?? "").replace(/\D/g, "");
  const local = d.startsWith("972") ? `0${d.slice(3)}` : d;
  return /^0\d{8,9}$/.test(local) ? `${local.slice(0, -7)}-${local.slice(-7)}` : String(n ?? "");
}

/** +972... -> 0... (how the old dashboard shows a user's own phone) */
export const localPhone = (p: string | null | undefined) => String(p ?? "").replace(/^\+972/, "0");

/** Who a call was with: the contact, else the name the test call gave the bot (an incoming call: who called). */
export const callName = (c: { full_name?: string | null; contact_name?: string | null; direction?: string } | null | undefined) =>
  c?.full_name ?? c?.contact_name ?? (c?.direction === "in" ? "שיחה נכנסת" : "שיחת בדיקה");

/** Today's date in Israel, YYYY-MM-DD (the study days' "past"). */
export const todayIso = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
