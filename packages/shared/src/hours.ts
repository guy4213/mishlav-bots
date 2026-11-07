import { addDays, dateKey, fromLocal, toLocalParts, WEEKDAYS, type Weekday } from "./time";

export interface BusinessHours {
  timezone: string;
  days: Weekday[];
  open: string; // "HH:MM"
  close: string; // "HH:MM", exclusive
  holidays: string[]; // "YYYY-MM-DD"
  half_days: { date: string; close: string }[];
}

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export type ClosedReason = "holiday" | "non_working_day" | "outside_business_hours";

/** Business window for a calendar date, or why the day is closed. */
export function dayWindow(
  date: { year: number; month: number; day: number },
  bh: BusinessHours,
): { open: number; close: number } | { closed: "holiday" | "non_working_day" } {
  const key = dateKey(date);
  if (bh.holidays.includes(key)) return { closed: "holiday" };
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  if (!bh.days.includes(WEEKDAYS[weekday]!)) return { closed: "non_working_day" };
  const half = bh.half_days.find((h) => h.date === key);
  return { open: toMinutes(bh.open), close: toMinutes(half?.close ?? bh.close) };
}

/** null when open, otherwise why it's closed. */
export function closedReason(t: Date, bh: BusinessHours): ClosedReason | null {
  const p = toLocalParts(t, bh.timezone);
  const w = dayWindow(p, bh);
  if ("closed" in w) return w.closed;
  const minute = p.hour * 60 + p.minute + (p.second > 0 ? 1 / 60 : 0);
  return minute >= w.open && minute < w.close ? null : "outside_business_hours";
}

export function isWithinBusinessHours(t: Date, bh: BusinessHours): boolean {
  return closedReason(t, bh) === null;
}

/** `t` if open, otherwise the start of the next business window. */
export function nextOpenSlot(t: Date, bh: BusinessHours): Date {
  if (isWithinBusinessHours(t, bh)) return t;
  const p = toLocalParts(t, bh.timezone);
  const minuteNow = p.hour * 60 + p.minute;
  for (let i = 0; i < 60; i++) {
    const d = addDays(p, i);
    const w = dayWindow(d, bh);
    if ("closed" in w) continue;
    if (i === 0 && minuteNow >= w.open) continue; // already past opening today (and not open) -> tomorrow
    return fromLocal(d.year, d.month, d.day, Math.floor(w.open / 60), w.open % 60, bh.timezone);
  }
  throw new Error("No business day found in the next 60 days — check business_hours settings");
}

/** Round up to the next multiple of `minutes` (keeps alternatives easy to say). */
export function ceilToMinutes(t: Date, minutes: number): Date {
  const step = minutes * 60000;
  return new Date(Math.ceil(t.getTime() / step) * step);
}

export type CallbackResolution =
  | { status: "accepted"; scheduled: Date }
  | { status: "alternative"; scheduled: Date; reason: "in_past" | "too_soon" | ClosedReason }
  | { status: "error"; error: "too_far" };

export interface CallbackPolicy {
  min_lead_minutes: number;
  max_days_ahead: number;
}

/** Decide the callback time: requested if valid, otherwise the nearest valid alternative. */
export function resolveCallback(requested: Date, now: Date, bh: BusinessHours, policy: CallbackPolicy): CallbackResolution {
  if (requested.getTime() > now.getTime() + policy.max_days_ahead * 86400000) {
    return { status: "error", error: "too_far" };
  }
  const earliest = new Date(now.getTime() + policy.min_lead_minutes * 60000);
  if (requested.getTime() < earliest.getTime()) {
    return {
      status: "alternative",
      reason: requested.getTime() < now.getTime() ? "in_past" : "too_soon",
      scheduled: nextOpenSlot(ceilToMinutes(earliest, 15), bh),
    };
  }
  const closed = closedReason(requested, bh);
  if (closed) return { status: "alternative", reason: closed, scheduled: nextOpenSlot(requested, bh) };
  return { status: "accepted", scheduled: requested };
}
