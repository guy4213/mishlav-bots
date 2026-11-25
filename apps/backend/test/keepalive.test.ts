import { describe, expect, it } from "vitest";
import { startKeepAlive } from "../src/keepalive";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("keep-alive (Render's free plan sleeps after 15 min without a visitor)", () => {
  it("on Render: knocks on its own /healthz every interval; one log line while it fails", async () => {
    const urls: string[] = [];
    const logs: string[] = [];
    let ok = false;
    const fetchImpl = (async (url: string) => (urls.push(url), new Response("", { status: ok ? 200 : 503 }))) as unknown as typeof fetch;
    const k = startKeepAlive({ RENDER_EXTERNAL_URL: "https://mishlav-bots.onrender.com/" }, (t) => logs.push(t), fetchImpl, 20);
    expect(k?.url).toBe("https://mishlav-bots.onrender.com/healthz");
    await wait(70);
    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(logs).toHaveLength(1); // "did not answer", once
    ok = true;
    await wait(40);
    expect(logs.at(-1)).toContain("answers again");
    k?.stop();
  });

  it("off the cloud, or KEEPALIVE=0: nothing", () => {
    expect(startKeepAlive({})).toBeNull();
    expect(startKeepAlive({ RENDER_EXTERNAL_URL: "https://x.onrender.com", KEEPALIVE: "0" })).toBeNull();
    const k = startKeepAlive({ KEEPALIVE_URL: "https://x.example" });
    expect(k?.url).toBe("https://x.example/healthz");
    k?.stop();
  });
});
