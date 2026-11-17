import { type BusinessHours, ceilToMinutes, dayWindow, nextOpenSlot, toMinutes } from "./hours";
import { addDays, fromLocal, toLocalParts } from "./time";

/** settings.yaml dialing.no_answer_retry: one entry per no-answer streak value (1st, 2nd, ... no-result call). */
export type NoAnswerRetry = { after_hours: number } | { business_days: number };

type Day = { year: number; month: number; day: number };

/** The first business day after `from`, with its window. */
function nextBusinessDay(from: Day, bh: BusinessHours): { d: Day; open: number; close: number } {
  for (let i = 1; i <= 60; i++) {
    const d = addDays(from, i);
    const w = dayWindow(d, bh);
    if (!("closed" in w)) return { d, ...w };
  }
  throw new Error("No business day found in the next 60 days — check business_hours settings");
}

/**
 * When to call again after a call with no result at `failedAt`, for each streak value the call can lead to
 * (index 0 = it was the 1st no-result call in a row). bot_call_ended picks the one for the new streak.
 *   after_hours:   at least that much later; outside business hours -> the next opening.
 *   business_days: that many business days later, at the start of the other half of the day than `failedAt`
 *                  (morning = open..midday, afternoon = midday..close). A day without an afternoon (a half day
 *                  that closes by midday) -> the next business day's morning.
 */
export function noAnswerRetryTimes(
  failedAt: Date,
  bh: BusinessHours,
  dialing: { no_answer_retry: NoAnswerRetry[]; midday: string },
): Date[] {
  const tz = bh.timezone;
  const p = toLocalParts(failedAt, tz);
  const midday = toMinutes(dialing.midday);
  const failedInMorning = p.hour * 60 + p.minute < midday;
  const at = (d: Day, minute: number) => fromLocal(d.year, d.month, d.day, Math.floor(minute / 60), minute % 60, tz);

  return dialing.no_answer_retry.map((rule) => {
    if ("after_hours" in rule) return nextOpenSlot(ceilToMinutes(new Date(failedAt.getTime() + rule.after_hours * 3600000), 5), bh);
    let day = nextBusinessDay(p, bh);
    for (let i = 1; i < rule.business_days; i++) day = nextBusinessDay(day.d, bh);
    if (!failedInMorning) return at(day.d, day.open);
    if (day.close > midday) return at(day.d, Math.max(midday, day.open));
    const next = nextBusinessDay(day.d, bh);
    return at(next.d, next.open);
  });
}
