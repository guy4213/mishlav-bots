/**
 * Call transcripts. The phone line writes each call to logs/transcripts/<call_id>.jsonl as it goes; that disk is
 * lost on every deploy (Render), so at the end of a contact's call the transcript is also stored in Supabase
 * (calls.transcript), with card numbers removed first (spec 4.3).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "./redact";

export interface TranscriptLine {
  ts: string;
  role: string;
  text: string;
}

/** The call ids the line and the voice worker use (no path tricks). */
export const CALL_ID = /^[\w+.\-]{1,150}$/;

/** One transcript file's lines (bad lines skipped). */
export function parseTranscript(text: string): TranscriptLine[] {
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        const o = JSON.parse(l) as TranscriptLine;
        return typeof o?.text === "string" ? [{ ts: String(o.ts ?? ""), role: String(o.role ?? ""), text: o.text }] : [];
      } catch {
        return [];
      }
    });
}

/** The call's transcript from disk ([] when there is none, e.g. an unanswered call or after a deploy). */
export function readTranscript(dir: string, callId: string): TranscriptLine[] {
  if (!CALL_ID.test(callId)) return [];
  const file = join(dir, `${callId}.jsonl`);
  return existsSync(file) ? parseTranscript(readFileSync(file, "utf8")) : [];
}

/** What is stored in the database: the spoken lines only, with any 13-19 digit run (a card number) removed. */
export function transcriptForDb(lines: TranscriptLine[]): TranscriptLine[] {
  return lines
    .filter((l) => l.role === "user" || l.role === "assistant")
    .map((l) => ({ ts: l.ts, role: l.role, text: redactText(l.text).text }));
}
