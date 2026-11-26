/**
 * The contact's Gold notes, as the bot reads them - and the bot's own lines summed up when they pile up (Guy, 26.11).
 *
 * Gold's notes field holds the reps' notes and the bot's lines ("[הערת הבוט] 26.11.2026 18:00 – ..."), all kept:
 *   - the reps' notes are NEVER touched: the bot always gets all of them, never summed up;
 *   - Gold is only ever added to: nothing is deleted or overwritten (bot_write_gold, bot_append_summary);
 *   - when the bot's lines since its last summary pass SUMMARY_AFTER_CHARS, at the end of a call a summary line is
 *     ADDED: "[סיכום הבוט] 26.11.2026 18:00 – ✓ ... · ✓ ..." (the last summary + those lines, as a short checklist).
 * The bot then gets: the reps' notes + its latest summary + its lines after that summary. So what it reads stays
 * short after many follow-ups, and the whole history stays in Gold for the reps.
 */

export const BOT_LINE = "[הערת הבוט]";
export const SUMMARY_LINE = "[סיכום הבוט]";
/** the bot's lines since its last summary longer than this: a new summary is added at the end of the call */
export const SUMMARY_AFTER_CHARS = 600;
/** the reps' notes the bot gets: all of them, unless very long (then the latest, whole lines) */
const REP_NOTES_MAX = 2000;

export interface SplitNotes {
  /** the reps' notes (every line that isn't the bot's), in order */
  rep: string[];
  /** the bot's latest summary line, null if none */
  summary: string | null;
  /** the bot's lines after its latest summary */
  botSince: string[];
}

export function splitNotes(notes: string | null | undefined): SplitNotes {
  const lines = (notes ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: SplitNotes = { rep: [], summary: null, botSince: [] };
  for (const line of lines) {
    if (line.startsWith(SUMMARY_LINE)) {
      out.summary = line;
      out.botSince = []; // what came before is in this summary
    } else if (line.startsWith(BOT_LINE)) out.botSince.push(line);
    else out.rep.push(line);
  }
  return out;
}

/** The latest lines that fit in `max` characters (whole lines; one longer line: its end). */
function lastLines(lines: string[], max: number): string[] {
  const kept: string[] = [];
  let size = 0;
  for (const line of [...lines].reverse()) {
    if (kept.length && size + line.length > max) break;
    kept.unshift(line.length > max ? line.slice(-max) : line);
    size += line.length + 3;
  }
  return kept;
}

/** What the bot is told about the contact: the reps' notes, its latest summary, its lines after it. */
export function notesForBot(notes: string | null | undefined): string | undefined {
  const { rep, summary, botSince } = splitNotes(notes);
  // the bot's own lines are bounded by the summary; a safety bound if a summary failed many calls in a row
  const parts = [...lastLines(rep, REP_NOTES_MAX), ...(summary ? [summary] : []), ...lastLines(botSince, SUMMARY_AFTER_CHARS * 2)];
  return parts.length ? parts.join(" | ") : undefined;
}

/** The bot's lines since its last summary are long enough to sum up. */
export function needsSummary(notes: string | null | undefined): boolean {
  const { botSince } = splitNotes(notes);
  return botSince.length > 1 && botSince.reduce((n, l) => n + l.length, 0) > SUMMARY_AFTER_CHARS;
}

/** Sums up the bot's earlier summary + its lines since into a few short checklist items (Hebrew). */
export type NotesSummarizer = (input: { summary: string | null; lines: string[] }) => Promise<string[]>;

/** The summary line's text (after "[סיכום הבוט] date – "): "✓ item · ✓ item". One line: Gold's notes are lines. */
export function summaryText(items: string[]): string {
  return items
    .map((i) => i.replace(/[\r\n\t]+/g, " ").replace(/^[\s✓✔•\-*]+/, "").trim())
    .filter(Boolean)
    .map((i) => `✓ ${i}`)
    .join(" · ");
}

const MODELS = ["gemini-3.1-flash-lite", "gemini-flash-lite-latest"]; // as gender.ts: two at once, the first wins
const URL = (model: string) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const INSTRUCTIONS =
  "אלה ההערות שבוט טלפוני של מכללת מישלב כתב על לקוח אחד בשיחות איתו (ימי עיון בחשבונאות), וסיכום קודם אם יש. " +
  "לסכם אותן לצ'קליסט קצר, בעברית, כדי שבשיחה הבאה יהיה ברור מה כבר נעשה ומה הלקוח רוצה. " +
  "כל פריט – משפט קצר אחד: מה הלקוח מעדיף (נושא, זום או מלון, מועד), מה ביקש, מה נעשה (קישור נשלח לאיזה יום, שיחה חוזרת נקבעה, הועבר לנציג) ומתי (תאריך). " +
  "לשמור כל עובדה חשובה מהסיכום הקודם. לא להמציא שום דבר שלא כתוב. בין 2 ל-6 פריטים.";

export function geminiNotesSummarizer(opts: { apiKey: string; models?: string[]; timeoutMs?: number; fetchImpl?: typeof fetch }): NotesSummarizer {
  const doFetch = opts.fetchImpl ?? fetch;
  const models = opts.models ?? MODELS;
  const ask = async (model: string, text: string): Promise<string[]> => {
    const res = await doFetch(URL(model), {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: {
          temperature: 0,
          thinkingConfig: { thinkingLevel: "minimal" },
          responseMimeType: "application/json",
          responseSchema: { type: "OBJECT", properties: { items: { type: "ARRAY", items: { type: "STRING" } } }, required: ["items"] },
        },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20000), // after the call: nobody waits on it
    });
    if (!res.ok) throw new Error(`Gemini answered HTTP ${res.status}`);
    const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
    const part = (body.candidates?.[0]?.content?.parts ?? []).find((p) => p.text && !p.thought)?.text ?? "";
    const items = (JSON.parse(part) as { items?: unknown }).items;
    if (!Array.isArray(items) || !items.length) throw new Error("no items in the answer");
    return items.map(String);
  };
  return async ({ summary, lines }) => {
    const text = `${INSTRUCTIONS}\n\n${summary ? `הסיכום הקודם:\n${summary}\n\n` : ""}ההערות מאז:\n${lines.join("\n")}`;
    const askAll = () => Promise.any(models.map((m) => ask(m, text)));
    return askAll().catch(askAll);
  };
}

/**
 * At the end of a contact's call: if the bot's lines since its last summary are long, ADDS a summary line to the
 * notes (nothing is deleted). Returns the summary added, or null.
 */
export async function summarizeIfLong(
  store: { get(id: string): Promise<{ notes: string | null } | null>; appendBotSummary?(id: string, text: string): Promise<void> },
  goldRecordId: string,
  summarize: NotesSummarizer,
): Promise<string | null> {
  if (!store.appendBotSummary) return null;
  const contact = await store.get(goldRecordId);
  if (!contact || !needsSummary(contact.notes)) return null;
  const { summary, botSince } = splitNotes(contact.notes);
  const text = summaryText(await summarize({ summary, lines: botSince }));
  if (!text) return null;
  await store.appendBotSummary(goldRecordId, text);
  return text;
}
