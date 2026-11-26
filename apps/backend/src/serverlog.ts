/**
 * The dashboard's live log of THIS server (GET /api/admin/logs): the phone line's lines (line.recent), the server's
 * own events (the dialer, tool calls, Supabase errors, WhatsApp results) and its own output (console, warnings and errors:
 * kind "server") in one stream, with one sequence number across all of them.
 *
 * Kept in memory for the live view, and - with a store (Supabase server_logs) - written there in batches every few
 * seconds, so a deploy or a restart doesn't wipe it: the dashboard reads earlier boots from the store. Lines older
 * than RETENTION_DAYS are deleted. A store failure never touches the live log (it is reported on stderr only).
 */
import { randomBytes } from "node:crypto";
import { format } from "node:util";
import type { PhoneHolder } from "./routes/phone";

export type LogKind = "line" | "dialer" | "tool" | "error" | "whatsapp" | "server";

export interface LogLine {
  seq: number;
  ts: string;
  kind: LogKind;
  call_id: string | null;
  text: string;
}

/** A line as stored: with the boot (server start) it came from. */
export interface StoredLogLine extends LogLine {
  boot: string;
}

/** Where the log is kept (SupabaseContacts implements it). */
export interface LogStore {
  appendLogs(lines: StoredLogLine[]): Promise<void>;
  /** newest first is fine: the caller orders them. Lines of `excludeBoot` are left out (they are in memory). */
  logHistory(opts: { excludeBoot: string; callId?: string; limit: number }): Promise<StoredLogLine[]>;
  pruneLogs(before: Date): Promise<void>;
}

export const SERVER_LOG_SIZE = 2000;
export const RETENTION_DAYS = 14;
const FLUSH_MS = 2000;
const BATCH = 500;
const PENDING_MAX = 5000; // the store is down for long: the oldest unsaved lines are dropped
const PRUNE_MS = 6 * 3600 * 1000;

export class ServerLog {
  /** this server start: the dashboard asks the store for every other boot */
  readonly boot = `${new Date().toISOString().slice(0, 19)}-${randomBytes(3).toString("hex")}`;
  private readonly lines: LogLine[] = [];
  private seq = 0;
  /** the last line.recent seq copied in (per line instance) */
  private lineSeq = 0;
  private line: unknown = null;
  private pending: StoredLogLine[] = [];
  private flushing = false;
  private timers: NodeJS.Timeout[] = [];
  private storeFailing = false;

  constructor(
    private readonly phone: PhoneHolder,
    private readonly now: () => Date = () => new Date(),
    private readonly size = SERVER_LOG_SIZE,
    private readonly store?: LogStore,
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

  /** Lines of earlier boots from the store, oldest first ([] without a store). */
  async history(opts: { callId?: string; limit?: number } = {}): Promise<StoredLogLine[]> {
    if (!this.store) return [];
    const rows = await this.store.logHistory({ excludeBoot: this.boot, callId: opts.callId, limit: opts.limit ?? 1000 });
    return rows.sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
  }

  /** Starts writing to the store (every FLUSH_MS) and deleting old lines. No store: nothing to do. */
  start(): void {
    if (!this.store || this.timers.length) return;
    const flush = setInterval(() => void this.flush(), FLUSH_MS);
    const prune = setInterval(() => void this.prune(), PRUNE_MS);
    flush.unref();
    prune.unref();
    this.timers.push(flush, prune);
    void this.prune();
  }

  /** Stops the timers and writes what is left (on close). */
  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.flush();
  }

  /** Writes the unsaved lines (the phone line's new ones too), in batches. */
  async flush(): Promise<void> {
    if (!this.store || this.flushing) return;
    this.syncLine();
    this.flushing = true;
    try {
      while (this.pending.length) {
        const batch = this.pending.slice(0, BATCH);
        await this.store.appendLogs(batch);
        this.pending.splice(0, batch.length);
        if (this.storeFailing) {
          this.storeFailing = false;
          process.stderr.write("[serverlog] the log store works again\n");
        }
      }
    } catch (err) {
      // never into the log itself (it would feed on its own failure); the lines wait for the next flush
      if (!this.storeFailing) process.stderr.write(`[serverlog] could not save the log: ${(err as Error).message}\n`);
      this.storeFailing = true;
    } finally {
      this.flushing = false;
    }
  }

  private async prune(): Promise<void> {
    try {
      await this.store?.pruneLogs(new Date(this.now().getTime() - RETENTION_DAYS * 86400000));
    } catch (err) {
      process.stderr.write(`[serverlog] could not delete old log lines: ${(err as Error).message}\n`);
    }
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
    const line = { seq: ++this.seq, ...l };
    this.lines.push(line);
    if (this.lines.length > this.size) this.lines.splice(0, this.lines.length - this.size);
    if (this.store) {
      this.pending.push({ ...line, boot: this.boot });
      if (this.pending.length > PENDING_MAX) this.pending.splice(0, this.pending.length - PENDING_MAX);
    }
  }
}

/**
 * The server's own output (console.log / warn / error) goes into the log too, as kind "server" ("error" for
 * console.error). Lines of the phone line ("[phone] ...") are skipped: the log already has them. Returns undo.
 */
export function tapConsole(log: ServerLog, con: Pick<Console, "log" | "info" | "warn" | "error"> = console): () => void {
  const orig = { log: con.log, info: con.info, warn: con.warn, error: con.error };
  const tap = (kind: LogKind, fn: (...a: unknown[]) => void) =>
    function (this: unknown, ...args: unknown[]) {
      fn.apply(this, args);
      const text = format(...args).replace(/^\s+|\s+$/g, "");
      if (!text || text.startsWith("[phone] ")) return;
      for (const t of text.split("\n").filter((x) => x.trim())) log.push(kind, t);
    };
  con.log = tap("server", orig.log);
  con.info = tap("server", orig.info);
  con.warn = tap("server", orig.warn);
  con.error = tap("error", orig.error);
  return () => Object.assign(con, orig);
}

/** The text of a pino log call (obj?, msg?, ...) for the log: the message and an error's message. */
export function pinoText(args: unknown[]): string {
  const [first, ...rest] = args;
  if (typeof first === "string") return format(first, ...rest);
  const obj = (first ?? {}) as { err?: { message?: string }; msg?: string };
  const msg = rest.length ? format(...rest) : (obj.msg ?? "");
  const err = obj.err?.message ?? (first instanceof Error ? first.message : "");
  return [msg, err].filter(Boolean).join(": ");
}
