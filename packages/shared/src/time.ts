/**
 * Time-zone helpers built on Intl (DST-correct for Asia/Jerusalem, no extra libraries).
 */

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
}

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const WEEKDAY_SHORT: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function toLocalParts(date: Date, tz: string): LocalParts {
  const out: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(date)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAY_SHORT[out.weekday ?? ""] ?? 0,
  };
}

/** Offset of `tz` from UTC at `date`, in minutes (e.g. +120 / +180 for Israel). */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const p = toLocalParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const actual = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - actual) / 60000);
}

/** Convert a wall-clock time in `tz` to an absolute Date. */
export function fromLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
  second = 0,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const off1 = tzOffsetMinutes(new Date(guess), tz);
  let t = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(new Date(t), tz);
  if (off2 !== off1) t = guess - off2 * 60000;
  return new Date(t);
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");

export function dateKey(p: { year: number; month: number; day: number }): string {
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** e.g. 2026-11-17T10:00:00+02:00 */
export function formatLocalIso(date: Date, tz: string): string {
  const p = toLocalParts(date, tz);
  const off = tzOffsetMinutes(date, tz);
  const sign = off >= 0 ? "+" : "-";
  return `${dateKey(p)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

/** Hebrew spoken-style date, e.g. "יום שלישי, 17 בנובמבר בשעה 10:00". */
export function formatHebrew(date: Date, tz: string): string {
  const day = new Intl.DateTimeFormat("he-IL", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(date);
  const p = toLocalParts(date, tz);
  return `${day} בשעה ${pad(p.hour)}:${pad(p.minute)}`;
}

/** Add whole days to a calendar date (no time zone involved). */
export function addDays(p: { year: number; month: number; day: number }, n: number) {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() };
}

/** Days between two calendar dates (b - a). */
export function daysBetween(a: { year: number; month: number; day: number }, b: { year: number; month: number; day: number }): number {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000);
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parse an ISO 8601 date-time. With Z/offset -> absolute; without -> wall-clock time in `tz`.
 * Returns null when invalid (including impossible dates like 2026-02-31).
 */
export function parseRequestedTime(input: string, tz: string): Date | null {
  const m = ISO_RE.exec(input.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, zone] = m;
  const year = Number(y), month = Number(mo), day = Number(d), hour = Number(h), minute = Number(mi), second = Number(s ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1) return null;
  if (zone) {
    const t = Date.parse(input.trim().replace(" ", "T"));
    return Number.isNaN(t) ? null : new Date(t);
  }
  return fromLocal(year, month, day, hour, minute, tz, second);
}
