/**
 * The automatic dialer: calls the contacts in the queue, one at a time (the phone line holds one call).
 *
 * On/off lives in the database (dialer_control), so a restart or a deploy keeps it: once started from the
 * dashboard it stays on until someone stops it. Stopping means no new calls; a call in progress ends normally.
 *
 * Every tick (settings.yaml dialing.tick_s), in order: on in the database -> within business hours -> the line is
 * registered and free -> the next due contact (bot_next_due: callbacks, retries, new) -> no valid phone: marked
 * wrong_number, next -> not in DIALER_ONLY_NUMBERS (when set): skipped for this run, next -> dial, wait for the
 * call to end, pause (pause_between_calls_s). A system failure (Supabase down, the line or the bot failing to
 * start a call) waits a minute; three in a row turn the dialer off in the database, with the reason.
 */
import { fromLocal, isWithinBusinessHours, type Settings, toLocalParts } from "@mishlav/shared";
import { type ContactEvents, type DialerControl, type DialerStore, type QueuedContact, toE164 } from "./contacts";
import { dialContact } from "./dial";
import type { PhoneHolder } from "./routes/phone";

export type DialerState = "running" | "stopped" | "outside_hours" | "queue_empty" | "in_call" | "error";

export interface DialerStatus {
  state: DialerState;
  /** the switch in the database (null until it was read once) */
  enabled: boolean | null;
  changed_at: string | null;
  reason: string | null;
  /** the dialer's call in progress (a manual call on the line shows as in_call with current_call null) */
  current_call: { call_id: string; gold_record_id: string; name: string | null; started_at: string } | null;
  /** the next contact in the queue (due now, or the first one whose time is ahead) */
  next_due: { gold_record_id: string; next_call_at: string | null } | null;
  /** dialer calls since midnight (business time zone) */
  calls_today: number;
  last_error: { message: string; at: string } | null;
  /** system failures in a row (3 = turned off) */
  failures: number;
  /** DIALER_ONLY_NUMBERS is set: only those numbers are dialed */
  only_numbers: boolean;
  /** when the last tick ran */
  checked_at: string | null;
}

export interface DialerDeps {
  store: DialerStore;
  /** the contacts' call updates (the same queue the tools use) */
  events: ContactEvents;
  phone: PhoneHolder;
  settings: Settings;
  now?: () => Date;
  /** DIALER_ONLY_NUMBERS, normalised (parseOnlyNumbers). null = every number. */
  onlyNumbers?: Set<string> | null;
  /** "error": a failure (the dashboard's log shows it as one) */
  log?: (text: string, kind?: "error") => void;
  /** logs/transcripts: each call's transcript is stored in Supabase at its end */
  transcriptsDir?: string;
}

export const FAILURE_WAIT_MS = 60_000;
export const MAX_FAILURES = 3;

/** DIALER_ONLY_NUMBERS="053-1234567, +972541112222" -> {"+972531234567", "+972541112222"}; unset/empty -> null. */
export function parseOnlyNumbers(raw: string | undefined, warn: (text: string) => void = () => {}): Set<string> | null {
  if (!raw?.trim()) return null;
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    if (!part.trim()) continue;
    const n = toE164(part);
    if (n) out.add(n);
    else warn(`DIALER_ONLY_NUMBERS: not a valid number, ignored: ${part.trim()}`);
  }
  return out; // set but all invalid: nobody is dialed
}

export class Dialer {
  private readonly now: () => Date;
  private readonly log: (text: string, kind?: "error") => void;
  private control: DialerControl | null = null;
  private state: DialerState = "stopped";
  private current: DialerStatus["current_call"] = null;
  private next: QueuedContact | null = null;
  private callsToday = 0;
  private countedDay: string | null = null;
  private lastError: DialerStatus["last_error"] = null;
  private failures = 0;
  private checkedAt: string | null = null;
  /** contacts passed over in this run (not in DIALER_ONLY_NUMBERS, or could not be marked): they don't block the queue */
  private readonly skipped = new Set<string>();
  private alive = false;
  private wakeUp: (() => void) | null = null;

  constructor(private readonly deps: DialerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((text) => console.log(`[dialer] ${text}`));
  }

  /** Turns the dialer on in the database and looks for work right away. */
  async start(reason?: string | null): Promise<DialerStatus> {
    this.control = await this.deps.store.setDialer(true, reason?.trim() || "הופעל מהדשבורד");
    this.failures = 0;
    this.lastError = null;
    this.skipped.clear();
    this.log(`started (${this.control.reason})`);
    this.wake();
    return this.status();
  }

  /** Turns the dialer off in the database: no new calls. A call in progress is not hung up. */
  async stop(reason?: string | null): Promise<DialerStatus> {
    this.control = await this.deps.store.setDialer(false, reason?.trim() || "נעצר מהדשבורד");
    if (this.state !== "in_call") this.state = "stopped";
    this.log(`stopped (${this.control.reason})${this.current ? `; call ${this.current.call_id} goes on to its end` : ""}`);
    return this.status();
  }

  status(): DialerStatus {
    return {
      state: this.state,
      enabled: this.control?.enabled ?? null,
      changed_at: this.control?.changed_at ?? null,
      reason: this.control?.reason ?? null,
      current_call: this.current,
      next_due: this.next && { gold_record_id: this.next.gold_record_id, next_call_at: this.next.next_call_at },
      calls_today: this.callsToday,
      last_error: this.lastError,
      failures: this.failures,
      only_numbers: !!this.deps.onlyNumbers,
      checked_at: this.checkedAt,
    };
  }

  /** The loop (main.ts): tick, wait as long as the tick says, again - until shutdown(). */
  run(): void {
    if (this.alive) return;
    this.alive = true;
    void (async () => {
      while (this.alive) {
        let wait: number;
        try {
          wait = await this.tick();
        } catch (err) {
          wait = await this.failure(err as Error); // tick handles its own errors; this is a last resort
        }
        if (!this.alive) break;
        await this.sleep(wait);
      }
    })();
  }

  /** Ends the loop (server shutdown). The switch in the database stays as it is. */
  shutdown(): void {
    this.alive = false;
    this.wake();
  }

  /**
   * One pass. Returns how long to wait before the next one (ms). When it dials, it returns only after that call
   * ended, so there is never more than one of our calls on the line.
   */
  async tick(): Promise<number> {
    const { settings, store } = this.deps;
    const idle = settings.dialing.tick_s * 1000;
    const now = this.now();
    this.checkedAt = now.toISOString();
    try {
      this.control = await store.dialerControl();
    } catch (err) {
      return this.failure(err as Error);
    }
    await this.countToday(now);
    if (!this.control.enabled) {
      this.state = "stopped";
      this.failures = 0;
      return idle;
    }
    if (!isWithinBusinessHours(now, settings.business_hours)) {
      this.state = "outside_hours";
      await this.peekNext(now);
      return idle;
    }
    // The line registers in the background and retries by itself (main.ts): wait for it, it's not our failure
    const line = this.deps.phone.line;
    const ls = line?.status();
    if (!line || !ls?.registered) {
      this.state = "error";
      this.lastError = { message: `קו הטלפון לא רשום: ${this.deps.phone.reason ?? ls?.error ?? "לא ידוע"}`, at: now.toISOString() };
      return idle;
    }
    if (ls.busy) {
      this.state = "in_call"; // a manual call from the dashboard: wait for it
      return idle;
    }

    let due: QueuedContact | null;
    try {
      due = await store.nextDue(now, [...this.skipped]);
    } catch (err) {
      return this.failure(err as Error);
    }
    if (!due) {
      this.state = "queue_empty";
      this.failures = 0;
      await this.peekNext(now);
      return idle;
    }
    this.next = due;

    const only = this.deps.onlyNumbers;
    const r = await dialContact({ contacts: this.deps.events, settings, line, transcriptsDir: this.deps.transcriptsDir }, due.gold_record_id, {
      origin: "dialer",
      allowNumber: only ? (n) => only.has(toE164(n) ?? n) : undefined,
    });
    if (!r.ok) {
      switch (r.error) {
        case "no_phone":
          try {
            const status = await store.markNoPhone(due.gold_record_id);
            this.log(`${due.gold_record_id}: no valid phone -> ${status}`);
          } catch (err) {
            return this.failure(err as Error);
          }
          this.skipped.add(due.gold_record_id); // already out of the queue; never asked for again in this run
          return 0;
        case "not_allowed":
        case "do_not_call":
        case "unknown_contact":
          this.log(`${due.gold_record_id}: skipped (${r.message_he})`);
          this.skipped.add(due.gold_record_id);
          return 0;
        default: // supabase_error, dial_failed: the line, the bot or the database
          return this.failure(new Error(r.message_he));
      }
    }

    this.failures = 0;
    this.state = "in_call";
    this.current = { call_id: r.call_id, gold_record_id: r.contact.gold_record_id, name: r.contact.full_name, started_at: now.toISOString() };
    this.callsToday++;
    this.log(`calling ${r.contact.gold_record_id} (call ${r.call_id})`);
    await r.ended;
    this.log(`call ${r.call_id} ended`);
    this.current = null;
    this.next = null;
    this.state = this.control.enabled ? "running" : "stopped";
    this.countedDay = null; // count again from the database
    return settings.dialing.pause_between_calls_s * 1000;
  }

  /** A system failure: wait a minute; the third in a row turns the dialer off in the database. */
  private async failure(err: Error): Promise<number> {
    this.failures++;
    this.state = "error";
    this.lastError = { message: err.message, at: this.now().toISOString() };
    this.log(`failure ${this.failures}/${MAX_FAILURES}: ${err.message}`, "error");
    if (this.failures >= MAX_FAILURES) {
      const reason = `נעצר אוטומטית אחרי ${MAX_FAILURES} תקלות ברצף: ${err.message}`.slice(0, 500);
      try {
        this.control = await this.deps.store.setDialer(false, reason);
        this.state = "stopped";
        this.failures = 0;
        this.log(reason, "error");
      } catch (e) {
        this.log(`could not turn the dialer off: ${(e as Error).message}`, "error");
      }
    }
    return FAILURE_WAIT_MS;
  }

  /** The next contact for the dashboard when nothing is due now (best effort: not a failure). */
  private async peekNext(now: Date) {
    try {
      this.next = (await this.deps.store.nextDue(now, [...this.skipped])) ?? (await this.deps.store.nextScheduled(now));
    } catch {
      // shown again on the next tick
    }
  }

  /** calls_today from the database, once a day and after each call (best effort). */
  private async countToday(now: Date) {
    const tz = this.deps.settings.business_hours.timezone;
    const p = toLocalParts(now, tz);
    const day = `${p.year}-${p.month}-${p.day}`;
    if (this.countedDay === day) return;
    try {
      this.callsToday = await this.deps.store.callsSince(fromLocal(p.year, p.month, p.day, 0, 0, tz), "dialer");
      this.countedDay = day;
    } catch {
      // keep the last count
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      t.unref?.();
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wakeUp = done;
    });
  }

  private wake() {
    const w = this.wakeUp;
    this.wakeUp = null;
    w?.();
  }
}
