// @vitest-environment jsdom
/** The dashboard's pieces without a screen: the routes, the API client, links from data, the formats. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fmtCost, fmtDuration, fmtPhone } from "../src/lib/format";
import { safeUrl, telHref } from "../src/lib/safe-url";
import { routeId } from "../src/shell/routes";
import { installServer } from "./helpers";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.resetModules();
  history.replaceState(null, "", "/dashboard-new");
});

describe("routes", () => {
  it("#/<screen> when the role may see it; an old #tab=; else the overview", () => {
    expect(routeId("#/calls", "admin")).toBe("calls");
    expect(routeId("#/logs", "admin")).toBe("logs");
    expect(routeId("#/logs", "mishlav")).toBe("overview"); // ours: a Mishlav user lands on the overview
    expect(routeId("#/self-test", "mishlav")).toBe("self-test");
    expect(routeId("#/self-test", "admin")).toBe("overview"); // theirs
    expect(routeId("#tab=phone", "admin")).toBe("testing");
    expect(routeId("#tab=test", "admin")).toBe("testing");
    expect(routeId("#tab=logs", "admin")).toBe("logs");
    expect(routeId("#tab=results", "admin")).toBe("results");
    expect(routeId("#tab=phone", "mishlav")).toBe("overview");
    expect(routeId("#/nothing", "admin")).toBe("overview");
    expect(routeId("", "mishlav")).toBe("overview");
  });
});

describe("the API client", () => {
  it("#k= is kept, then removed from the address and the history, the screen after it kept", async () => {
    history.replaceState(null, "", "/dashboard-new#k=the%20key&tab=phone");
    const api = await import("../src/lib/api");
    expect(api.loadSecret()).toBe(true);
    expect(location.hash).toBe("#tab=phone");
    expect(localStorage.getItem("mishlav_secret")).toBe("the key");
    expect(api.authHeaders()).toEqual({ "x-tools-secret": "the key" });
  });

  it("view-as goes with every request; a 401 tells the app, a 403 is an error with the server's Hebrew message", async () => {
    sessionStorage.setItem("mishlav_view_as", "mishlav");
    localStorage.setItem("mishlav_secret", "k");
    const srv = installServer((r) =>
      r.path === "/x/401" ? { status: 401, json: { ok: false } } : r.path === "/x/403" ? { status: 403, json: { ok: false, error: "forbidden", message_he: "אין לך הרשאה לפעולה הזו" } } : r.path === "/x/400" ? { status: 400, json: { ok: false, error: "invalid_params", message_he: "לא תקין: שם", fields: ["name"] } } : { json: { ok: true } },
    );
    const api = await import("../src/lib/api");
    api.loadSecret();
    const onAuth = vi.fn();
    api.onAuthRequired(onAuth);
    await api.get("/x/ok");
    expect(srv.sent[0]!.headers).toMatchObject({ "x-tools-secret": "k", "x-view-as": "mishlav" });
    await expect(api.get("/x/401")).rejects.toBeInstanceOf(api.AuthError);
    expect(onAuth).toHaveBeenCalledTimes(1);
    await expect(api.get("/x/403")).rejects.toMatchObject({ status: 403, message: "אין לך הרשאה לפעולה הזו" });
    await expect(api.post("/x/400", { name: "" })).rejects.toMatchObject({ status: 400, fields: ["name"] });
    expect(onAuth).toHaveBeenCalledTimes(1); // a 403 or 400 is not "log in again"
    expect(srv.sent.every((s) => s.headers["x-view-as"] === "mishlav")).toBe(true);
  });

  it("a wrong key is forgotten; logout forgets the key and view-as", async () => {
    localStorage.setItem("mishlav_secret", "wrong");
    sessionStorage.setItem("mishlav_view_as", "mishlav");
    installServer((r) => (r.path === "/auth/me" ? { status: 401, json: { ok: false } } : { json: { ok: true } }));
    const api = await import("../src/lib/api");
    api.loadSecret();
    expect(await api.whoAmI()).toBeNull();
    expect(localStorage.getItem("mishlav_secret")).toBeNull();
    localStorage.setItem("mishlav_secret", "again");
    api.loadSecret();
    await api.logout();
    expect(localStorage.getItem("mishlav_secret")).toBeNull();
    expect(sessionStorage.getItem("mishlav_view_as")).toBeNull();
  });
});

describe("links from data", () => {
  it("only https: (purchase links, recordings) and tel: (phones)", () => {
    expect(safeUrl("https://example.invalid/buy?x=1", ["https:"])).toBe("https://example.invalid/buy?x=1");
    for (const bad of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,<script>x</script>", "http://example.invalid", "//evil.example/x", "/dashboard", "vbscript:x", "", null, 5]) {
      expect(safeUrl(bad, ["https:"]), String(bad)).toBeNull();
    }
    expect(safeUrl("tel:+972500000001", ["https:"])).toBeNull();
    expect(telHref("050-000 0001")).toBe("tel:0500000001");
    expect(telHref("javascript:alert()")).toBeNull(); // no digits: no link
    expect(telHref("javascript:alert(1)")).toBe("tel:1"); // digits only: never anything but tel:
    expect(telHref("+972 50 javascript:1")).toBe("tel:+972501");
  });
});

describe("formats (as the old ui.js)", () => {
  it("phones, durations, costs", () => {
    expect(fmtPhone("+972534271418")).toBe("053-4271418");
    expect(fmtPhone("0534271418")).toBe("053-4271418");
    expect(fmtPhone("abc")).toBe("abc");
    expect(fmtDuration(125)).toBe("2:05");
    expect(fmtDuration(null)).toBe("—");
    expect(fmtCost(0.124, 120)).toBe("$0.124 · $0.062/דקה");
    expect(fmtCost(null, 1)).toBe("—");
  });
});
