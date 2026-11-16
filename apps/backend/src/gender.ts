/**
 * The customer's grammatical gender, decided once before the call (Guy, Nov 2026): the bot used to decide it
 * sentence by sentence from the name and switched between masculine and feminine mid-call ("רועי" heard "לָךְ").
 * A small text model reads the first name; any failure or doubt is "unknown" -> the bot speaks gender-neutral.
 */
export const GENDERS = ["male", "female", "unknown"] as const;
export type Gender = (typeof GENDERS)[number];

export type GenderClassifier = (firstName: string) => Promise<Gender>;

const MODEL = "gemini-2.5-flash-lite";
const URL = (model: string) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

/** Gemini text call with a closed answer (JSON enum). Cached per name; "unknown" on any error or timeout. */
export function geminiGenderClassifier(opts: {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): GenderClassifier {
  const cache = new Map<string, Gender>();
  const doFetch = opts.fetchImpl ?? fetch;
  return async (firstName) => {
    const name = firstName.trim();
    if (!name) return "unknown";
    const hit = cache.get(name);
    if (hit) return hit;
    let gender: Gender = "unknown";
    try {
      const res = await doFetch(URL(opts.model ?? MODEL), {
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
            responseMimeType: "application/json",
            responseSchema: { type: "OBJECT", properties: { gender: { type: "STRING", enum: [...GENDERS] } }, required: ["gender"] },
          },
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 2500),
      });
      if (res.ok) {
        const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        const text = body.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        const g = (JSON.parse(text) as { gender?: string }).gender;
        if (GENDERS.includes(g as Gender)) gender = g as Gender;
      }
    } catch {
      // network / timeout / bad JSON: speak gender-neutral
    }
    if (gender !== "unknown") cache.set(name, gender); // an error is not cached: the next call asks again
    return gender;
  };
}

/** The fact for customer_context (the prompt says what to do with it). */
export function genderFactHe(firstName: string, gender: Gender): string {
  if (gender === "male") return `הלקוח ${firstName} – גבר.`;
  if (gender === "female") return `הלקוחה ${firstName} – אישה.`;
  return `לא ידוע אם ${firstName} גבר או אישה.`;
}
