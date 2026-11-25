import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * setInterval that also runs now, and stops itself when `alive()` turns false (ui.js `every`). A tab in the background
 * skips its ticks and runs one as soon as it is in front again: seven people with the dashboard open somewhere don't
 * read the database all day (Supabase's free plan). Returns a stop function.
 */
export function every(ms: number, fn: () => unknown, alive: () => boolean = () => true): () => void {
  let t: ReturnType<typeof setInterval> | null = null;
  let missed = false;
  const tick = async () => {
    if (!alive()) return stop();
    if (document.hidden) {
      missed = true;
      return;
    }
    missed = false;
    try {
      await fn();
    } catch {
      // shown by fn; try again next time
    }
  };
  const onVisible = () => {
    if (!document.hidden && missed) void tick();
  };
  const stop = () => {
    if (t) clearInterval(t);
    t = null;
    document.removeEventListener("visibilitychange", onVisible);
  };
  t = setInterval(tick, ms);
  document.addEventListener("visibilitychange", onVisible);
  void tick();
  return stop;
}

/** `every` for a component: runs while mounted (and `enabled`); `fn` is always the latest one. */
export function useEvery(ms: number, fn: () => unknown, enabled = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    return every(ms, () => ref.current());
  }, [ms, enabled]);
}

/** The latest value in a ref (for handlers and timers that outlive a render). */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/**
 * A scrolling box that stays at the bottom when new content comes, if the reader was there (ui.js setFollowing).
 * `content` is what changes; the position is read before the new content is drawn.
 */
export function useFollowing(ref: RefObject<HTMLElement | null>, content: unknown, skip = false) {
  const atEnd = useRef(true);
  const box = ref.current;
  if (box) atEnd.current = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  useLayoutEffect(() => {
    const b = ref.current;
    if (!skip && b && atEnd.current) b.scrollTop = b.scrollHeight;
  }, [content, skip, ref]);
}
