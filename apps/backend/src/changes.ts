/**
 * "The contacts changed": the dashboard's push channel (GET /api/admin/stream, Server-Sent Events). Whatever changes
 * a contact on this server says so here - a call's updates (ContactEvents), the dialer marking one (no phone,
 * duplicate, another phone), a rep task done - and every open dashboard re-reads the screen it shows. Nothing is
 * sent while nothing happens, so an idle dashboard costs no database reads. A burst (a call's start: the calls row,
 * its details, the bot's tools) goes out as one message.
 */
/** ContactEvents updates that touch only the call's own row (dial.ts trackCall): no contact changed. */
export const CALL_ONLY_UPDATES = new Set(["transcript", "ai usage", "recording"]);

export class Changes {
  private readonly subs = new Set<() => void>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly debounceMs = 300) {}

  /** Something changed: the subscribers hear it once, `debounceMs` after the first of a burst. */
  notify(): void {
    if (this.timer || !this.subs.size) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      for (const fn of this.subs) {
        try {
          fn();
        } catch {
          // a closed connection: it unsubscribes on its own
        }
      }
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Returns the unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  get listeners(): number {
    return this.subs.size;
  }
}
