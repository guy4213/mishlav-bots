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
  it("asks the model once per name, keeps the answer", async () => {
    let calls = 0;
    const classify = geminiGenderClassifier({ apiKey: "k", fetchImpl: async () => (calls++, answer("male")) });
    expect(await classify("רועי")).toBe("male");
    expect(await classify("רועי")).toBe("male");
    expect(calls).toBe(1);
  });

  it("any failure is 'unknown' (neutral wording), and is asked again next time", async () => {
    let calls = 0;
    const fail = geminiGenderClassifier({ apiKey: "k", fetchImpl: async () => { calls++; throw new Error("down"); } });
    expect(await fail("רועי")).toBe("unknown");
    expect(await fail("רועי")).toBe("unknown");
    expect(calls).toBe(2);
    const odd = geminiGenderClassifier({ apiKey: "k", fetchImpl: async () => answer("robot") });
    expect(await odd("רועי")).toBe("unknown");
  });

  it("the fact opens customer_context", () => {
    const kb = loadKnowledge(join(findRepoRoot(__dirname), "config", "knowledge"));
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
