/**
 * The customer's grammatical gender, decided once before the call (Guy, Nov 2026): the bot used to decide it
 * sentence by sentence from the name and switched between masculine and feminine mid-call ("רועי" heard "לָךְ").
 * A small text model reads the first name; any failure or doubt is "unknown" -> the bot speaks gender-neutral.
 */
export const GENDERS = ["male", "female", "unknown"] as const;
export type Gender = (typeof GENDERS)[number];

export type GenderClassifier = (firstName: string) => Promise<Gender>;

// gemini-2.5-flash-lite: 404 "no longer available to new users" (Nov 2026). The 3.1 lite models with minimal thinking
// answer in ~1 s, but under Google's load some requests hang or get 503: two models are asked at once and the first
// answer wins; if both fail, once more. (3.5 lite, Google's suggestion, took 13-28 s at times.)
const MODELS = ["gemini-3.1-flash-lite", "gemini-flash-lite-latest"];
const URL = (model: string) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

/** Gemini text call with a closed answer (JSON enum). Cached per name; "unknown" on any error or timeout. */
export function geminiGenderClassifier(opts: {
  apiKey: string;
  models?: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** why a name came back "unknown" because of a failure (default: console.warn, i.e. the dashboard's log) */
  onError?: (text: string) => void;
}): GenderClassifier {
  const onError = opts.onError ?? ((text: string) => console.warn(text));
  const cache = new Map<string, Gender>();
  const doFetch = opts.fetchImpl ?? fetch;
  const models = opts.models ?? MODELS;
  return async (firstName) => {
    const name = firstName.trim();
    if (!name) return "unknown";
    const hit = cache.get(name);
    if (hit) return hit;
    const askAll = () => Promise.any(models.map((m) => ask(m, name)));
    let gender: Gender = "unknown";
    try {
      gender = await askAll().catch(askAll);
    } catch (err) {
      // every model failed twice (network / timeout / HTTP error / bad JSON): speak gender-neutral
      const first = err instanceof AggregateError ? (err.errors[0] as Error) : (err as Error);
      onError(`gender of "${name}" unknown: ${first?.message ?? err}`);
    }
    if (gender !== "unknown") cache.set(name, gender); // an error is not cached: the next call asks again
    return gender;
  };

  async function ask(model: string, name: string): Promise<Gender> {
    const res = await doFetch(URL(model), {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text:
                  `First name of an Israeli customer: "${name}". Is this a man's or a woman's name? ` +
                  `Answer "unknown" if it is commonly used for both (e.g. שי, טל, נוי) or you are not sure.`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          thinkingConfig: { thinkingLevel: "minimal" },
          responseMimeType: "application/json",
          responseSchema: { type: "OBJECT", properties: { gender: { type: "STRING", enum: [...GENDERS] } }, required: ["gender"] },
        },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 4000), // before dialing: the customer doesn't wait on it
    });
    if (!res.ok) throw new Error(`Gemini answered HTTP ${res.status}`);
    const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
    const parts = body.candidates?.[0]?.content?.parts ?? [];
    const text = parts.find((p) => p.text && !p.thought)?.text ?? "";
    const g = (JSON.parse(text) as { gender?: string }).gender;
    return GENDERS.includes(g as Gender) ? (g as Gender) : "unknown";
  }
}

/** The fact for customer_context (the prompt says what to do with it). */
export function genderFactHe(firstName: string, gender: Gender): string {
  if (gender === "male") return `הלקוח ${firstName} – גבר.`;
  if (gender === "female") return `הלקוחה ${firstName} – אישה.`;
  return `לא ידוע אם ${firstName} גבר או אישה.`;
}
