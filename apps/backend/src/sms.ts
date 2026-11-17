/**
 * The purchase-link SMS (send_purchase_link). One interface, so the production provider (Mishlav's, with a
 * registered sender name) can replace Zadarma without touching the tool:
 *   ZadarmaSms  - Zadarma's API, for tests now (ZADARMA_API_KEY + ZADARMA_API_SECRET, optional ZADARMA_SMS_SENDER)
 *   LogOnlySms  - no keys: writes what would be sent to the log, sends nothing
 * Numbers are always masked in logs.
 */
import { createHash, createHmac } from "node:crypto";
import { maskNumber } from "../../phone/src/numbers.js";

export type SmsResult = { ok: true; provider: string; sent: boolean } | { ok: false; provider: string; error: string };

export interface SmsSender {
  readonly provider: string;
  /** true: real messages go out (a recipient is required) */
  readonly live: boolean;
  /** `to` in international format (+972...); null only for a log-only test without a number */
  send(to: string | null, text: string): Promise<SmsResult>;
}

type Log = (text: string) => void;
const defaultLog: Log = (text) => console.log(`[sms] ${text}`);

export class LogOnlySms implements SmsSender {
  readonly provider = "log";
  readonly live = false;
  constructor(private readonly log: Log = defaultLog) {}
  async send(to: string | null, text: string): Promise<SmsResult> {
    this.log(`log only, not sent (no SMS provider configured) -> ${to ? maskNumber(to) : "no number"}: ${text}`);
    return { ok: true, provider: this.provider, sent: false };
  }
}

/** PHP urlencode (what http_build_query uses with PHP_QUERY_RFC1738): space -> +, everything but [A-Za-z0-9_.-] %XX. */
function phpUrlencode(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/**
 * Zadarma's request signature, as in their official client (github.com/zadarma/user-api-v1, lib/Client.php):
 * params sorted by key -> http_build_query -> base64(hmac_sha1(method + query + md5(query), secret)).
 * Note: PHP's hash_hmac returns the HEX digest by default, and the client base64-encodes that hex string (not
 * the raw bytes) - so do we.
 */
export function zadarmaSignature(method: string, params: Record<string, string>, secret: string): { query: string; signature: string } {
  const query = Object.keys(params)
    .sort()
    .map((k) => `${phpUrlencode(k)}=${phpUrlencode(params[k]!)}`)
    .join("&");
  const md5 = createHash("md5").update(query).digest("hex");
  const hexHmac = createHmac("sha1", secret).update(method + query + md5).digest("hex");
  return { query, signature: Buffer.from(hexHmac).toString("base64") };
}

export interface ZadarmaOptions {
  key: string;
  secret: string;
  /** a sender name / number registered with Zadarma (optional) */
  sender?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  log?: Log;
}

export const ZADARMA_SMS_METHOD = "/v1/sms/send/";

export class ZadarmaSms implements SmsSender {
  readonly provider = "zadarma";
  readonly live = true;
  private readonly log: Log;
  constructor(private readonly o: ZadarmaOptions) {
    this.log = o.log ?? defaultLog;
  }

  async send(to: string | null, text: string): Promise<SmsResult> {
    if (!to) return { ok: false, provider: this.provider, error: "no_phone" };
    const number = to.replace(/\D/g, ""); // Zadarma takes the international number without the +
    // format=json is part of every request in Zadarma's client, and so of the signature
    const params: Record<string, string> = { format: "json", message: text, number, ...(this.o.sender && { sender: this.o.sender }) };
    const { query, signature } = zadarmaSignature(ZADARMA_SMS_METHOD, params, this.o.secret);
    const masked = maskNumber(to);
    try {
      const res = await (this.o.fetchImpl ?? fetch)(`${this.o.baseUrl ?? "https://api.zadarma.com"}${ZADARMA_SMS_METHOD}`, {
        method: "POST",
        headers: { authorization: `${this.o.key}:${signature}`, "content-type": "application/x-www-form-urlencoded" },
        body: query,
        // under the bot's own 8 s tool timeout (apps/phone/src/mishlav.js), so it hears sms_failed, not silence
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 5000),
      });
      const body = (await res.json().catch(() => null)) as {
        status?: string;
        message?: string;
        denied_numbers?: { number?: string; message?: string }[];
      } | null;
      const denied = body?.denied_numbers?.find((d) => String(d.number ?? "").replace(/\D/g, "") === number);
      if (!res.ok || body?.status !== "success" || denied) {
        const why = denied?.message ?? body?.message ?? `HTTP ${res.status}`;
        this.log(`zadarma refused -> ${masked}: ${why}`);
        return { ok: false, provider: this.provider, error: why };
      }
      this.log(`sent via zadarma -> ${masked}`);
      return { ok: true, provider: this.provider, sent: true };
    } catch (err) {
      this.log(`zadarma failed -> ${masked}: ${(err as Error).message}`);
      return { ok: false, provider: this.provider, error: (err as Error).message };
    }
  }
}

/** ZADARMA_API_KEY + ZADARMA_API_SECRET -> Zadarma; otherwise log only (nothing is sent). */
export function smsSenderFromEnv(env: NodeJS.ProcessEnv, log?: Log): SmsSender {
  const key = env.ZADARMA_API_KEY?.trim();
  const secret = env.ZADARMA_API_SECRET?.trim();
  if (key && secret) return new ZadarmaSms({ key, secret, sender: env.ZADARMA_SMS_SENDER?.trim() || undefined, log });
  return new LogOnlySms(log);
}
