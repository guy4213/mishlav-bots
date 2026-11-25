/**
 * Keeps the server awake on Render's free plan: a free web service sleeps after 15 minutes without a request from
 * outside, and then the phone line, the dialer and incoming calls stop. Every 10 minutes the server asks its own
 * public address (/healthz) - the request goes out and back in through Render, so it counts as a visitor.
 * Render sets RENDER_EXTERNAL_URL; KEEPALIVE_URL overrides it; KEEPALIVE=0 turns it off. Off the cloud: nothing.
 * It can only keep an awake server awake: a server that already sleeps wakes on the next real request.
 */
export const KEEPALIVE_MS = 10 * 60 * 1000;

export interface KeepAlive {
  url: string;
  stop: () => void;
}

export function startKeepAlive(
  env: NodeJS.ProcessEnv,
  log: (text: string) => void = (t) => console.log(t),
  fetchImpl: typeof fetch = fetch,
  everyMs = KEEPALIVE_MS,
): KeepAlive | null {
  if (env.KEEPALIVE === "0") return null;
  const base = (env.KEEPALIVE_URL || env.RENDER_EXTERNAL_URL || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) return null;
  const url = `${base}/healthz`;
  let failing = false;
  const knock = async () => {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (failing) log(`keep-alive: ${url} answers again`);
      failing = false;
    } catch (err) {
      if (!failing) log(`keep-alive: ${url} did not answer (${(err as Error).message}); trying again in ${everyMs / 60000} min`);
      failing = true; // logged once until it answers again
    }
  };
  const timer = setInterval(() => void knock(), everyMs);
  timer.unref?.();
  return { url, stop: () => clearInterval(timer) };
}
