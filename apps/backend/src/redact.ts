/**
 * Card-number redaction (spec 4.3): any run of 13–19 digits, optionally separated by single spaces
 * or dashes, is replaced before anything is written to disk. Phones (10 digits / 12 with 972) are kept.
 */
const CARD_RE = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;
export const REDACTED = "[REDACTED_CARD]";

export function redactText(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(CARD_RE, () => {
    count++;
    return REDACTED;
  });
  return { text: out, count };
}

/** Redact every string inside a JSON-like value. */
export function redactDeep<T>(value: T): { value: T; count: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactText(v);
      count += r.count;
      return r.text;
    }
    if (typeof v === "number" && Number.isInteger(v) && String(Math.abs(v)).length >= 13) {
      count++;
      return REDACTED;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return { value: walk(value) as T, count };
}
