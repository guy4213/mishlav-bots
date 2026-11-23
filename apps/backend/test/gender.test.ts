import { describe, expect, it } from "vitest";
import { buildCallVariables } from "../src/context";
import { genderFactHe, geminiGenderClassifier } from "../src/gender";
import { loadKnowledge } from "../src/knowledge";
import { join } from "node:path";
import { findRepoRoot } from "@mishlav/shared";
import { AUTH, FIXED_NOW, testServer } from "./helpers";

const answer = (gender: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ gender }) }] } }] }), { status: 200 });

describe("customer gender before the call", () => {
  it("asks the two models once per name, keeps the answer", async () => {
    let calls = 0;
    const classify = geminiGenderClassifier({ apiKey: "k", fetchImpl: async () => (calls++, answer("male")) });
    expect(await classify("רועי")).toBe("male");
    expect(await classify("רועי")).toBe("male");
    expect(calls).toBe(2); // both models at once, then the cache
  });

  it("one model failing or hanging: the other one's answer; both failing: once more", async () => {
    const models = ["slow", "fast"];
    const byUrl = (fn: (model: string) => Promise<Response>) => (async (url: string) => fn(url.includes("/slow:") ? "slow" : "fast")) as unknown as typeof fetch;
    const one = geminiGenderClassifier({ apiKey: "k", models, fetchImpl: byUrl(async (m) => (m === "slow" ? new Response("{}", { status: 503 }) : answer("female"))) });
    expect(await one("ענת")).toBe("female");
    let attempt = 0;
    const again = geminiGenderClassifier({ apiKey: "k", models, fetchImpl: byUrl(async () => (++attempt <= 2 ? new Response("{}", { status: 503 }) : answer("male"))) });
    expect(await again("גיא")).toBe("male");
    expect(attempt).toBe(4);
  });

  it("any failure is 'unknown' (neutral wording), and is asked again next time", async () => {
    let calls = 0;
    const errors: string[] = [];
    const onError = (t: string) => errors.push(t);
    const fail = geminiGenderClassifier({ apiKey: "k", onError, fetchImpl: async () => { calls++; throw new Error("down"); } });
    expect(await fail("רועי")).toBe("unknown");
    expect(await fail("רועי")).toBe("unknown");
    expect(calls).toBe(8); // 2 models x 2 tries, twice
    const odd = geminiGenderClassifier({ apiKey: "k", onError, fetchImpl: async () => answer("robot") });
    expect(await odd("רועי")).toBe("unknown");
    // a failure says why in the log (quota, timeout...); a real "unknown" answer is not a failure
    const quota = geminiGenderClassifier({ apiKey: "k", onError, fetchImpl: async () => new Response("{}", { status: 429 }) });
    expect(await quota("גיא")).toBe("unknown");
    expect(errors).toEqual(['gender of "רועי" unknown: down', 'gender of "רועי" unknown: down', 'gender of "גיא" unknown: Gemini answered HTTP 429']);
  });

  it("the fact opens customer_context", () => {
    const kb = loadKnowledge(join(findRepoRoot(__dirname), "config", "knowledge"), join(findRepoRoot(__dirname), "tests", "fixtures", "days"));
    const v = buildCallVariables(kb, { first_name: "רועי", gender: "male" }, FIXED_NOW);
    expect(v.customer_gender).toBe("male");
    expect(v.customer_context.startsWith("הלקוח רועי – גבר.")).toBe(true);
    expect(genderFactHe("אורנה", "female")).toBe("הלקוחה אורנה – אישה.");
    expect(genderFactHe("שי", "unknown")).toBe("לא ידוע אם שי גבר או אישה.");
  });

  it("GET /test/context: ?gender wins, otherwise unknown without a classifier", async () => {
    const { app } = await testServer();
    const get = async (q: string) => (await app.inject({ method: "GET", url: `/test/context?${q}`, headers: AUTH })).json();
    expect((await get("first_name=רועי&gender=male")).variables.customer_gender).toBe("male");
    expect((await get("first_name=רועי")).variables.customer_gender).toBe("unknown");
  });
});
