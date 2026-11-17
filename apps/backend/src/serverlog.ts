/**
 * The dashboard's live log of THIS server (GET /api/admin/logs): the phone line's lines (line.recent) and the
 * server's own events (the dialer, tool calls, Supabase errors, SMS results) in one stream, with one sequence
 * number across all of them. In memory only, like line.recent: it starts empty on every restart / deploy.
 */
import type { PhoneHolder } from "./routes/phone";

export type LogKind = "line" | "dialer" | "tool" | "error" | "sms";

export interface LogLine {
  seq: number;
  ts: string;
  kind: LogKind;
  call_id: string | null;
  text: string;
}

export const SERVER_LOG_SIZE = 2000;

export class ServerLog {
  private readonly lines: LogLine[] = [];
  private seq = 0;
  /** the last line.recent seq copied in (per line instance) */
  private lineSeq = 0;
  private line: unknown = null;

  constructor(
    private readonly phone: PhoneHolder,
    private readonly now: () => Date = () => new Date(),
    private readonly size = SERVER_LOG_SIZE,
  ) {}

  push(kind: LogKind, text: string, callId: string | null = null): void {
    this.syncLine(); // the line's earlier lines first, so the stream stays in order
    this.add({ ts: this.now().toISOString(), kind, call_id: callId, text });
  }

  /** Every line after `since` (a seq from an earlier answer; 0 = all that is kept). */
  since(since: number): { seq: number; lines: LogLine[] } {
    this.syncLine();
    return { seq: this.seq, lines: this.lines.filter((l) => l.seq > since) };
  }

  /** Copies the phone line's new lines in (it keeps its own ring of 400, with its own numbers). */
  private syncLine(): void {
    const line = this.phone.line;
    if (!line) return;
    if (line !== this.line) {
      this.line = line;
      this.lineSeq = 0;
    }
    for (const l of line.recent) {
      if (l.seq <= this.lineSeq) continue;
      this.lineSeq = l.seq;
      this.add({ ts: l.ts, kind: "line", call_id: l.call_id, text: l.text });
    }
  }

  private add(l: Omit<LogLine, "seq">): void {
    this.lines.push({ seq: ++this.seq, ...l });
    if (this.lines.length > this.size) this.lines.splice(0, this.lines.length - this.size);
  }
}
