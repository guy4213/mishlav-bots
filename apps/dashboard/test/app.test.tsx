// @vitest-environment jsdom
/**
 * The whole dashboard in jsdom against a pretend server: what each role sees and asks for, "view as Mishlav", a 401
 * (nothing of the last user stays), the pager, the push channel, a javascript: link from the data, what is stored.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_ME, browserShims, CONTACT, installServer, MISHLAV_ME, standardServer } from "./helpers";

/** access.ts's own decision (the server's), loaded by path so this browser test doesn't type-check the backend. */
async function serverMayCall(): Promise<(role: "admin" | "mishlav", method: string, path: string) => boolean> {
  const mod = "../../backend/src/access";
  return ((await import(/* @vite-ignore */ mod)) as { mayCall: (r: "admin" | "mishlav", m: string, p: string) => boolean }).mayCall;
}

async function boot(hash = "#/overview") {
  history.replaceState(null, "", `/dashboard-new${hash}`);
  const { App } = await import("../src/App");
  const r = render(<App />);
  await waitFor(() => expect(document.querySelector("#userBox:not([hidden])")).not.toBeNull());
  return r;
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  browserShims();
});
afterEach(async () => {
  cleanup();
  const live = await import("../src/lib/live");
  live.stopLive();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("what a Mishlav user sees and asks for", () => {
  it("only the screens opened to them, and not one request to a route that isn't", async () => {
    const srv = installServer(standardServer(MISHLAV_ME));
    await boot();
    const links = () => [...document.querySelectorAll<HTMLAnchorElement>("#nav a")].map((a) => a.dataset.id);
    const groups = () => [...document.querySelectorAll("#nav .nav-sep")].map((g) => g.textContent);
    expect(links()).toEqual(["overview", "contacts", "calls", "reps", "study-days", "self-test"]);
    expect(groups()).toEqual(["עבודה", "בדיקות"]); // "מערכת" (users, logs, Gold) is gone with its screens
    // the dialer's switch, the daily limit and the voice are ours
    expect(document.querySelector("#dialerStart, #dialerStop")).toBeNull();
    expect(document.querySelector("#ovLimitCard, #ovVoice")).toBeNull();
    expect(screen.queryByText("צפייה כמו משלב")).toBeNull();
    // an admin screen typed in the address: the overview, and still nothing of ours is asked for
    await act(async () => {
      location.hash = "#/logs";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(document.querySelector("#pageTitle")!.textContent).toBe("סקירה");
    const mayCall = await serverMayCall();
    const notAllowed = srv.sent.filter((s) => !mayCall("mishlav", s.method, s.path)).map((s) => `${s.method} ${s.path}`);
    expect(notAllowed).toEqual([]);
    expect(srv.paths()).not.toContain("/api/admin/env");
  });

  it("an admin viewing as Mishlav: x-view-as on every request (the push channel too), and the same screens", async () => {
    sessionStorage.setItem("mishlav_view_as", "mishlav");
    localStorage.setItem("mishlav_secret", "test-key");
    const srv = installServer(standardServer({ ...ADMIN_ME, role: "mishlav", viewing_as: true, server: undefined }));
    await boot();
    expect(document.querySelector("#viewAsBar")!.hasAttribute("hidden")).toBe(false);
    expect([...document.querySelectorAll<HTMLAnchorElement>("#nav a")].map((a) => a.dataset.id)).toEqual(["overview", "contacts", "calls", "reps", "study-days", "self-test"]);
    await waitFor(() => expect(srv.paths()).toContain("/api/admin/stream"));
    expect(srv.sent.length).toBeGreaterThan(3);
    for (const s of srv.sent) expect(s.headers["x-view-as"], s.path).toBe("mishlav");
    const mayCall = await serverMayCall();
    expect(srv.sent.filter((s) => !mayCall("mishlav", s.method, s.path)).map((s) => s.path)).toEqual([]);
  });

  it("an admin sees every screen, the switch and our cards", async () => {
    localStorage.setItem("mishlav_secret", "test-key");
    installServer(standardServer(ADMIN_ME));
    await boot();
    expect([...document.querySelectorAll<HTMLAnchorElement>("#nav a")].map((a) => a.dataset.id)).toEqual([
      "overview", "contacts", "calls", "reps", "study-days", "testing", "test-dialer", "results", "users", "logs", "gold",
    ]);
    await waitFor(() => expect(document.querySelector("#dialerStart")).not.toBeNull());
    await waitFor(() => expect(document.querySelector("#ovVoice .card-body")).not.toBeNull());
    expect(screen.getByText("צפייה כמו משלב")).toBeTruthy();
  });
});

describe("a 401: nothing of the last user stays", () => {
  it("the screens are emptied, the live poll stops, the login shows over an empty frame", async () => {
    let loggedOut = false;
    const srv = installServer(standardServer(MISHLAV_ME, (r) => (loggedOut && r.path !== "/api/admin/stream" ? { status: 401, json: { ok: false, error: "unauthorized" } } : undefined)));
    await boot("#/contacts");
    await waitFor(() => expect(screen.getAllByText("לקוח מומצא").length).toBeGreaterThan(0));
    // a contact's drawer is open when the session ends
    fireEvent.click(document.querySelector("#cBody tr.click")!);
    await waitFor(() => expect(document.querySelector(".drawer.open")).not.toBeNull());
    loggedOut = true;
    const live = await import("../src/lib/live");
    await act(async () => {
      await live.refreshLive();
    });
    await waitFor(() => expect(document.querySelector("#loginModal")).not.toBeNull());
    expect(document.body.textContent).not.toContain("לקוח מומצא");
    expect(document.body.textContent).not.toContain("050-0000001");
    expect(document.body.textContent).not.toContain("עובדת בדיקה");
    expect(document.querySelector("#view")!.childElementCount).toBe(0);
    expect(document.querySelector(".drawer.open")).toBeNull();
    expect(document.querySelector("#userBox")!.hasAttribute("hidden")).toBe(true);
    expect(live.liveState()).toMatchObject({ dialer: null, phone: null, env: null });
    // the live poll and the push channel are stopped: nothing more is asked
    const before = srv.sent.length;
    await act(() => new Promise((r) => setTimeout(r, 3000)));
    expect(srv.sent.length).toBe(before);
    expect((await import("../src/lib/api")).session.role).toBeNull();
  });

  it("logging out forgets the key and view-as, and nothing about customers is ever stored", async () => {
    localStorage.setItem("mishlav_secret", "test-key");
    localStorage.setItem("mishlav_theme", "dark");
    installServer(standardServer(ADMIN_ME, (r) => (r.path === "/auth/logout" ? { json: { ok: true } } : undefined)));

    await boot("#/contacts");
    await waitFor(() => expect(screen.getAllByText("לקוח מומצא").length).toBeGreaterThan(0));
    fireEvent.click(document.querySelector('#cView button[data-v="all"]')!);
    await waitFor(() => expect(sessionStorage.getItem("mishlav_contacts_view")).toBe("all"));
    const allowed = new Set(["mishlav_secret", "mishlav_theme", "mishlav_view_as", "mishlav_contacts_view", "mishlav_calls_origin", "mishlav_calls_rec_only", "mishlav_phone"]);
    const stored = [...Object.keys(localStorage), ...Object.keys(sessionStorage)];
    expect(stored.filter((k) => !allowed.has(k))).toEqual([]);
    const values = [...Object.values(localStorage), ...Object.values(sessionStorage)].join(" ");
    expect(values).not.toContain("לקוח מומצא");
    expect(values).not.toContain("050-0000001");
    fireEvent.click(screen.getByText("יציאה"));
    await waitFor(() => expect(localStorage.getItem("mishlav_secret")).toBeNull()); // then the page reloads (jsdom: not implemented)
    expect(localStorage.getItem("mishlav_secret")).toBeNull();
    expect(sessionStorage.getItem("mishlav_view_as")).toBeNull();
    expect(localStorage.getItem("mishlav_theme")).toBe("dark"); // a preference stays
  });
});

describe("lists, the push channel, data that could carry a script", () => {
  it("the contacts pager asks the server for the next page (50 a page, the server pages)", async () => {
    sessionStorage.setItem("mishlav_contacts_view", "all");
    localStorage.setItem("mishlav_secret", "test-key");
    const srv = installServer(standardServer(ADMIN_ME));
    await boot("#/contacts");
    await waitFor(() => expect(screen.getByText("עמוד 1 מתוך 3")).toBeTruthy());
    fireEvent.click(screen.getByText("הבא"));
    await waitFor(() => expect(screen.getByText("עמוד 2 מתוך 3")).toBeTruthy());
    const pages = srv.sent.filter((s) => s.path === "/api/admin/contacts").map((s) => new URLSearchParams(s.url.split("?")[1]).get("page"));
    // page 1 on open (and again on the push channel's hello, as the old screen), then page 2 once
    expect(pages.at(-1)).toBe("2");
    expect(pages.filter((p) => p === "2")).toHaveLength(1);
    expect(pages.every((p) => p === "1" || p === "2")).toBe(true);
  });

  it("a 'contacts' push re-reads the contacts screen, at most once every 3 s", async () => {
    localStorage.setItem("mishlav_secret", "test-key");
    const srv = installServer(standardServer(ADMIN_ME));
    let pushes: () => void = () => {};
    await boot("#/contacts");
    await waitFor(() => expect(srv.paths()).toContain("/api/admin/stream"));
    pushes = srv.pushContacts;
    const reads = () => srv.sent.filter((s) => s.path === "/api/admin/contacts").length;
    await act(() => new Promise((r) => setTimeout(r, 3200))); // the hello's re-read has passed
    const start = reads();
    await act(async () => {
      pushes();
      pushes();
      pushes();
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(reads()).toBe(start + 1); // three pushes, one re-read now
    await act(async () => {
      pushes();
      await new Promise((r) => setTimeout(r, 1000));
    });
    expect(reads()).toBe(start + 1); // within 3 s of the last: waits
    await act(() => new Promise((r) => setTimeout(r, 2500)));
    expect(reads()).toBe(start + 2);
  }, 20_000);

  it("a javascript: purchase link from the data is never a link; an https one is, with noopener noreferrer", async () => {
    localStorage.setItem("mishlav_secret", "test-key");
    const row = (id: string, url: string) => ({
      id,
      raw: { id, title: `יום ${id}`, topic: "t", date: "2099-01-01", end_date: null, start_time: "09:00", end_time: "16:00", format: "hotel", series: null, location: "x", price_ils: 100, vat_included: true, open_for_registration: true, course_number: "1", purchase_url: url, lecturers: [], academic_hours: null, description: "", archived_at: null },
      dates_he: "1.1.2099",
      format_he: "מלון",
      archived: false,
      error: null,
      note_he: null,
      offered_to_bot: true,
    });
    installServer(standardServer(ADMIN_ME, (r) => (r.path === "/api/admin/study-days" ? { json: { ok: true, days: [row("bad", "javascript:alert(document.cookie)"), row("good", "https://example.invalid/buy")], catalog_he: "" } } : undefined)));
    await boot("#/study-days");
    await waitFor(() => expect(screen.getByText("יום bad")).toBeTruthy());
    fireEvent.click(screen.getByText("יום bad"));
    await waitFor(() => expect(screen.getByText("javascript:alert(document.cookie)")).toBeTruthy());
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
    expect(screen.getByText("javascript:alert(document.cookie)").tagName).toBe("SPAN");
    fireEvent.click(screen.getByText("יום good"));
    await waitFor(() => expect(screen.getByText("https://example.invalid/buy")).toBeTruthy());
    const a = screen.getByText("https://example.invalid/buy") as HTMLAnchorElement;
    expect(a.tagName).toBe("A");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(document.querySelectorAll('a[href^="javascript"]').length).toBe(0);
  });

  it("HTML in the data is text, never markup", async () => {
    localStorage.setItem("mishlav_secret", "test-key");
    const evil = '<img src=x onerror="window.__pwned=1"><b>x</b>';
    installServer(
      standardServer(ADMIN_ME, (r) =>
        r.path === "/api/admin/contacts" ? { json: { ok: true, available: true, view: "activity", contacts: [{ ...CONTACT, full_name: evil, status: evil }], total: 1 } } : undefined,
      ),
    );
    await boot("#/contacts");
    await waitFor(() => expect(screen.getAllByText(evil).length).toBeGreaterThan(0));
    expect(document.querySelector("#cBody img")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
