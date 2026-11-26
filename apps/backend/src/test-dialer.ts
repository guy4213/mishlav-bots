/**
 * The automatic-dialing test (dashboard "בדיקות חיוג אוטומטי", admins only): the very same Dialer that goes live, run
 * on the 10 made-up TEST- contacts (supabase/migrations/20261201000000_test_contacts.sql) - so a pass means the real
 * thing works: the queue, callbacks at the time asked, the notes the bot reads and writes, the WhatsApp link.
 *
 * It can't reach a real customer, by three locks:
 *   1. its queue holds only TEST- contacts (bot_next_due_tests); the real dialer, queue and Gold feed skip them;
 *   2. it dials ONLY the phone of the admin who started it (the dialer's onlyNumbers - checked at the dial itself,
 *      whatever contact the queue returned);
 *   3. its switch lives in this server's memory: off after every restart, and separate from the real dialer's.
 * Its calls are "manual" (not counted as the real dialer's); it works at any hour, so it can be tested any time.
 */
import type { Settings } from "@mishlav/shared";
import { type ContactEvents, type DialerControl, type DialerStore, type SupabaseContacts, toE164 } from "./contacts";
import { Dialer, type DialerStatus } from "./dialer";
import type { PhoneHolder } from "./routes/phone";

/** What the test needs from Supabase (SupabaseContacts has all of it). */
export type TestDialerStore = Pick<
  SupabaseContacts,
  "get" | "markNoPhone" | "usePhone" | "markDuplicate" | "nextDueTests" | "nextScheduledTests" | "testCallsSince" | "testContacts" | "resetTests"
>;

export interface TestDialerDeps {
  store: TestDialerStore;
  events: ContactEvents;
  phone: PhoneHolder;
  settings: Settings;
  now?: () => Date;
  log?: (text: string, kind?: "error") => void;
  transcriptsDir?: string;
  onChange?: () => void;
}

export interface TestDialerStatus extends DialerStatus {
  /** the only number it may dial (the admin who started it) */
  allowed_number: string | null;
}

export class TestDialer {
  /** lock 2: the only number the dial accepts - the admin who started the test (empty: nobody) */
  private readonly allowed = new Set<string>();
  private control: DialerControl = { enabled: false, changed_at: new Date(0).toISOString(), reason: "כבוי", daily_limit: null };
  private readonly dialer: Dialer;

  constructor(private readonly deps: TestDialerDeps) {
    const self = this;
    const s = deps.store;
    // the Dialer's store, narrowed to the test: its switch in memory, its queue only the TEST- contacts
    const store: DialerStore = {
      get: (id) => s.get(id),
      dialerControl: async () => ({ ...self.control }),
      setDialer: async (enabled, reason) => {
        self.control = { ...self.control, enabled, reason, changed_at: (deps.now ?? (() => new Date()))().toISOString() };
        return { ...self.control };
      },
      nextDue: (now, skip) => s.nextDueTests(now, skip),
      nextScheduled: (now) => s.nextScheduledTests(now),
      markNoPhone: (id) => s.markNoPhone(id),
      usePhone: (id, index) => s.usePhone(id, index),
      markDuplicate: (id, number) => s.markDuplicate(id, number),
      callsSince: (since) => s.testCallsSince(since),
    };
    this.dialer = new Dialer({
      store,
      events: deps.events,
      phone: deps.phone,
      settings: deps.settings,
      now: deps.now,
      // lock 2: the dial itself checks this set - only the admin's phone, whatever the queue returned
      onlyNumbers: this.allowed,
      log: (text, kind) => deps.log?.(text, kind),
      transcriptsDir: deps.transcriptsDir,
      onChange: deps.onChange,
      origin: "manual",
      ignoreHours: true,
    });
  }

  /** Puts the 10 test contacts back as they start, all on the admin's phone. Not while the test dials. */
  async reset(phone: string): Promise<number> {
    const number = toE164(phone);
    if (!number) throw new Error("מספר הטלפון של המשתמש לא תקין");
    if (this.control.enabled) throw new Error("קודם לעצור את חיוג הבדיקה");
    return this.deps.store.resetTests(number);
  }

  /** Starts the test: it dials only `phone` (the admin who pressed start). */
  async start(phone: string): Promise<TestDialerStatus> {
    const number = toE164(phone);
    if (!number) throw new Error("מספר הטלפון של המשתמש לא תקין");
    this.allowed.clear();
    this.allowed.add(number);
    await this.dialer.start("בדיקת חיוג אוטומטי");
    return this.status();
  }

  async stop(): Promise<TestDialerStatus> {
    await this.dialer.stop("נעצר מהדשבורד");
    return this.status();
  }

  status(): TestDialerStatus {
    return { ...this.dialer.status(), only_numbers: true, allowed_number: [...this.allowed][0] ?? null };
  }

  contacts() {
    return this.deps.store.testContacts();
  }

  /** Is `callId` the test's call on the line now? (its callbacks may be at any hour) */
  isCurrentCall(callId: string | null | undefined): boolean {
    return !!callId && this.dialer.status().current_call?.call_id === callId;
  }

  run() {
    this.dialer.run();
  }

  shutdown() {
    this.dialer.shutdown();
  }

  /** for tests: one pass of the loop */
  tick() {
    return this.dialer.tick();
  }
}
