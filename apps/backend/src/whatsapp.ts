/**
 * The purchase link on WhatsApp (send_purchase_link), through Texter (Mishlav's WhatsApp provider):
 * an approved template (settings.yaml whatsapp.template) with three body values and a dynamic URL button.
 *   POST https://{TEXTER_PROJECT}.texterchat.com/server/api/v2/whatsapp/templates/send
 *   Authorization: Bearer {TEXTER_API_TOKEN}   (scope: "Send template messages")
 *   { templateName, to, language, body: [name, day, details], buttons: [{ type: "url", payload }], from? }
 * Texter answers 200 with success:false when it skipped the send (e.g. the recipient unsubscribed).
 * The link goes ONLY by WhatsApp - never by SMS (Mishlav, 26.11). Without TEXTER_PROJECT + TEXTER_API_TOKEN the
 * sender is log-only: a real customer is told a rep will send the link; a text run without a number goes through.
 * Numbers are always masked in logs.
 */
import { maskNumber } from "../../phone/src/numbers.js";
import { datesHe, type StudyDay } from "./knowledge";

export type WhatsAppResult = { ok: true; provider: string; sent: boolean } | { ok: false; provider: string; error: string };

/** What the template needs: {{1}} the customer's first name, {{2}} the study day, {{3}} its details; the button's link. */
export interface LinkTemplateValues {
  body: [string, string, string];
  /** the end of the purchase link (after whatsapp.url_prefix), injected into the button's {{1}} */
  buttonPayload: string;
}

export interface WhatsAppSender {
  readonly provider: string;
  readonly live: boolean;
  sendLink(to: string, values: LinkTemplateValues): Promise<WhatsAppResult>;
}

type Log = (text: string) => void;
const defaultLog: Log = (text) => console.log(`[whatsapp] ${text}`);

export interface TexterOptions {
  /** the project subdomain: https://{project}.texterchat.com */
  project: string;
  token: string;
  template: string;
  language: string;
  /** the sender's WhatsApp number, when the project has more than one */
  from?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: Log;
}

/** No Texter keys: writes what would be sent, sends nothing (text runs, tests, a server without Texter). */
export class LogOnlyWhatsApp implements WhatsAppSender {
  readonly provider = "log";
  readonly live = false;
  constructor(private readonly log: Log = defaultLog) {}
  async sendLink(to: string, values: LinkTemplateValues): Promise<WhatsAppResult> {
    this.log(`NOT sent - Texter not configured (TEXTER_PROJECT + TEXTER_API_TOKEN) -> ${maskNumber(to)}: ${values.body.join(" | ")} | ${values.buttonPayload}`);
    return { ok: true, provider: this.provider, sent: false };
  }
}

export class TexterWhatsApp implements WhatsAppSender {
  readonly provider = "texter";
  readonly live = true;
  private readonly log: Log;
  constructor(private readonly o: TexterOptions) {
    this.log = o.log ?? defaultLog;
  }

  get url() {
    return `https://${this.o.project}.texterchat.com/server/api/v2/whatsapp/templates/send`;
  }

  async sendLink(to: string, values: LinkTemplateValues): Promise<WhatsAppResult> {
    const masked = maskNumber(to);
    const request = {
      templateName: this.o.template,
      to,
      language: this.o.language,
      ...(this.o.from && { from: this.o.from }),
      body: values.body,
      buttons: [{ type: "url", payload: values.buttonPayload }],
    };
    const started = Date.now();
    try {
      const res = await (this.o.fetchImpl ?? fetch)(this.url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.o.token}`, "content-type": "application/json" },
        body: JSON.stringify(request),
        // under the bot's own 8 s tool timeout (apps/phone/src/mishlav.js), so it hears the failure, not silence
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 6000),
      });
      const body = (await res.json().catch(() => null)) as { success?: boolean; error?: string; messageId?: string } | null;
      if (!res.ok || body?.success !== true) {
        const why = body?.error ?? `HTTP ${res.status}`;
        this.log(`texter refused -> ${masked} after ${Date.now() - started}ms: ${why}`);
        return { ok: false, provider: this.provider, error: why };
      }
      this.log(`sent via texter (${this.o.template}) -> ${masked} in ${Date.now() - started}ms${body.messageId ? ` · message ${body.messageId}` : ""}`);
      return { ok: true, provider: this.provider, sent: true };
    } catch (err) {
      this.log(`texter failed -> ${masked}: ${(err as Error).message}`);
      return { ok: false, provider: this.provider, error: (err as Error).message };
    }
  }
}

/** TEXTER_PROJECT + TEXTER_API_TOKEN (+ TEXTER_FROM) -> Texter; otherwise log only (nothing is sent). */
export function whatsappSenderFromEnv(
  env: NodeJS.ProcessEnv,
  template: { template: string; language: string },
  log?: Log,
): WhatsAppSender {
  const project = env.TEXTER_PROJECT?.trim().replace(/^https?:\/\//, "").replace(/\.texterchat\.com.*$/, "");
  const token = env.TEXTER_API_TOKEN?.trim();
  if (!project || !token) return new LogOnlyWhatsApp(log);
  return new TexterWhatsApp({ project, token, ...template, from: env.TEXTER_FROM?.trim() || undefined, log });
}

/** A template value can't hold line breaks, tabs or 5+ spaces in a row (Texter / WhatsApp). */
const clean = (s: string) => s.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();

/**
 * The template's values for one study day: {{1}} first name ("שלום" when unknown: "היי שלום, תודה על השיחה!"),
 * {{2}} the day's topic, {{3}} "21–22.2.2027 · בזום · 10:00–13:15 בכל מפגש · 370 ₪ כולל מע\"מ"; the button gets the
 * end of the day's purchase link. null when the link doesn't start with the button's fixed prefix.
 */
export function linkTemplateValues(day: StudyDay, firstName: string | null | undefined, urlPrefix: string): LinkTemplateValues | null {
  if (!day.purchase_url?.startsWith(urlPrefix)) return null;
  const buttonPayload = day.purchase_url.slice(urlPrefix.length);
  if (!buttonPayload) return null;
  const where = day.format === "zoom" ? "בזום" : day.location;
  const hours = `${day.start}–${day.end}${day.end_date ? " בכל מפגש" : ""}`;
  const price = `${day.price_ils} ₪ ${day.vat_included ? "כולל" : "לפני"} מע"מ`;
  return {
    body: [clean(firstName || "שלום"), clean(day.title), clean([datesHe(day), where, hours, price].join(" · "))],
    buttonPayload,
  };
}
