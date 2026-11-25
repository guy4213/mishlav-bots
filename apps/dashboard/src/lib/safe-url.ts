/**
 * A link that came from data (a study day's purchase link, a recording's signed URL, a phone) is used only when its
 * scheme is one we expect: https: or tel:. Anything else - javascript:, data:, a relative path - gives null, and the
 * screen shows the text without a link. React escapes text, but an href or a src is not text.
 */
export type Scheme = "https:" | "tel:";

export function safeUrl(url: unknown, schemes: readonly Scheme[]): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null; // not absolute: never resolved against this page
  }
  return (schemes as readonly string[]).includes(u.protocol) ? u.href : null;
}

/** A phone as a tel: link: digits and + only (ui.js phoneLink). null: nothing to dial. */
export function telHref(phone: string | null | undefined): string | null {
  const digits = String(phone ?? "").replace(/[^\d+]/g, "");
  return digits ? safeUrl(`tel:${digits}`, ["tel:"]) : null;
}
