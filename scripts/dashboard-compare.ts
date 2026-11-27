/**
 * The old dashboard (/dashboard) next to the new one (/dashboard-new), in a real browser, on the demo server's
 * invented data (npm run dashboard:demo first):  npm run dashboard:compare
 *
 * For every screen, as an admin and as a Mishlav user (and an admin viewing as Mishlav), light and dark, desktop and
 * mobile: a screenshot of each, the share of pixels that differ (and an image of where), and whether the text on the
 * screen is the same. Then the requests each one sends to the server: on each screen while the tab is in front, and
 * while it is in the background. Everything goes to logs/dashboard-compare/ (gitignored).
 *
 * Uses the Edge (or Chrome) installed on this machine through playwright-core: no browser is downloaded.
 *
 *   npm run dashboard:compare -- --base http://127.0.0.1:8799 --only shots|requests --screens overview,calls
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { DEMO_PASSWORDS, DEMO_PHONES } from "./lib/demo-users";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "http://127.0.0.1:8799" },
    only: { type: "string", default: "" },
    screens: { type: "string", default: "" },
    secret: { type: "string", default: "demo-secret-not-real-0123456789" },
    out: { type: "string", default: join("logs", "dashboard-compare") },
    seconds: { type: "string", default: "31" },
  },
});
const BASE = values.base!;
const OUT = values.out!;
const SECRET = values.secret!;

const ADMIN_SCREENS = ["overview", "contacts", "calls", "reps", "study-days", "testing", "test-dialer", "results", "users", "logs", "gold"];
const MISHLAV_SCREENS = ["overview", "contacts", "calls", "reps", "study-days", "self-test"];
const pickScreens = (all: string[]) => (values.screens ? all.filter((s) => values.screens!.split(",").includes(s)) : all);

type Who = "admin" | "mishlav" | "viewas";
type Combo = { who: Who; theme: "light" | "dark"; device: "desktop" | "mobile" };
const COMBOS: Combo[] = [];
for (const who of ["admin", "mishlav", "viewas"] as Who[])
  for (const theme of ["light", "dark"] as const)
    for (const device of ["desktop", "mobile"] as const) if (who !== "viewas" || (theme === "light" && device === "desktop")) COMBOS.push({ who, theme, device });

const VIEWPORT = { desktop: { width: 1366, height: 900 }, mobile: { width: 390, height: 844 } };
/** tsx keeps function names with a __name() helper: the functions this script runs in the page need it there too. */
const NAME_HELPER = "window.__name = (f) => f;";

async function launch(): Promise<Browser> {
  for (const channel of ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // try the next one
    }
  }
  throw new Error("no Edge or Chrome on this machine");
}

/** A logged-in context: the key (#k=) for an admin, the login form for a Mishlav user. */
async function contextFor(browser: Browser, c: Combo): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: VIEWPORT[c.device],
    deviceScaleFactor: 1,
    colorScheme: c.theme,
    reducedMotion: "reduce",
    locale: "he-IL",
    timezoneId: "Asia/Jerusalem",
  });
  await ctx.addInitScript(NAME_HELPER);
  const page = await ctx.newPage();
  if (c.who === "mishlav") {
    await page.goto(`${BASE}/dashboard`);
    await page.fill("#loginPhone", DEMO_PHONES.mishlav);
    await page.fill("#loginPassword", DEMO_PASSWORDS.mishlav);
    await page.click("#loginBtn");
    await page.waitForSelector("#userBox:not([hidden])");
  } else {
    await page.goto(`${BASE}/dashboard#k=${encodeURIComponent(SECRET)}`);
    await page.waitForSelector("#userBox:not([hidden])");
  }
  await page.close();
  return ctx;
}

async function open(ctx: BrowserContext, path: "/dashboard" | "/dashboard-new", screen: string, c: Combo) {
  const page = await ctx.newPage();
  if (c.who === "viewas") await page.addInitScript(() => sessionStorage.setItem("mishlav_view_as", "mishlav"));
  await page.goto(`${BASE}${path}#/${screen}`);
  await page.waitForSelector("#userBox:not([hidden])");
  await page.waitForTimeout(3000); // the first reads, the live poll, the push channel's hello
  return page;
}

/** The screen's text (the view, the top bar, the nav), whitespace folded, times that tick blanked. */
async function textOf(page: Page) {
  return page.evaluate(() => {
    const t = (sel: string) => ((document.querySelector(sel) as HTMLElement | null)?.innerText ?? "").replace(/\s+/g, " ").trim();
    const norm = (s: string) => s.replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, "#:#").replace(/\d+/g, "#");
    return { view: norm(t("#view")), top: norm(t("#topStatus")), nav: t("#nav"), title: document.title, page: t("#pageTitle"), user: norm(t("#userBox")) };
  });
}

/** How much two screenshots differ, and an image of where (red). */
async function pixelDiff(page: Page, a: Buffer, b: Buffer, out: string) {
  const r = await page.evaluate(
    async ([a, b]) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((res) => {
          const i = new Image();
          i.onload = () => res(i);
          i.src = src;
        });
      const [ia, ib] = await Promise.all([load(a!), load(b!)]);
      const w = Math.max(ia.width, ib.width);
      const h = Math.max(ia.height, ib.height);
      const draw = (img: HTMLImageElement) => {
        const cv = document.createElement("canvas");
        cv.width = w;
        cv.height = h;
        const x = cv.getContext("2d")!;
        x.fillStyle = "#ff00ff";
        x.fillRect(0, 0, w, h);
        x.drawImage(img, 0, 0);
        return x.getImageData(0, 0, w, h);
      };
      const da = draw(ia);
      const db = draw(ib);
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      const x = cv.getContext("2d")!;
      const outImg = x.createImageData(w, h);
      let n = 0;
      for (let i = 0; i < da.data.length; i += 4) {
        const d = Math.abs(da.data[i]! - db.data[i]!) + Math.abs(da.data[i + 1]! - db.data[i + 1]!) + Math.abs(da.data[i + 2]! - db.data[i + 2]!);
        const g = (da.data[i]! + da.data[i + 1]! + da.data[i + 2]!) / 3;
        if (d > 40) {
          n++;
          outImg.data.set([255, 0, 0, 255], i);
        } else outImg.data.set([g, g, g, 90], i);
      }
      x.putImageData(outImg, 0, 0);
      return { pct: (n / (w * h)) * 100, size: [ia.width, ia.height, ib.width, ib.height], png: cv.toDataURL("image/png") };
    },
    [`data:image/png;base64,${a.toString("base64")}`, `data:image/png;base64,${b.toString("base64")}`],
  );
  writeFileSync(out, Buffer.from(r.png.split(",")[1]!, "base64"));
  return { pct: r.pct, size: r.size };
}

async function shots(browser: Browser) {
  const rows: string[] = ["| מי | ערכה | מכשיר | מסך | פיקסלים שונים | גודל (ישן / חדש) | טקסט זהה |", "|---|---|---|---|---|---|---|"];
  const textDiffs: string[] = [];
  const blankCtx = await browser.newContext();
  await blankCtx.addInitScript(NAME_HELPER);
  const blank = await blankCtx.newPage();
  await blank.goto("about:blank");
  for (const c of COMBOS) {
    const ctx = await contextFor(browser, c);
    const dir = join(OUT, `${c.who}-${c.theme}-${c.device}`);
    mkdirSync(dir, { recursive: true });
    const screens = pickScreens(c.who === "admin" ? ADMIN_SCREENS : MISHLAV_SCREENS);
    for (const screen of screens) {
      const [oldP, newP] = await Promise.all([open(ctx, "/dashboard", screen, c), open(ctx, "/dashboard-new", screen, c)]);
      const [a, b] = await Promise.all([oldP.screenshot({ fullPage: true }), newP.screenshot({ fullPage: true })]);
      writeFileSync(join(dir, `${screen}-old.png`), a);
      writeFileSync(join(dir, `${screen}-new.png`), b);
      const [ta, tb] = await Promise.all([textOf(oldP), textOf(newP)]);
      const d = await pixelDiff(blank, a, b, join(dir, `${screen}-diff.png`));
      const same = JSON.stringify(ta) === JSON.stringify(tb);
      if (!same) {
        for (const k of Object.keys(ta) as (keyof typeof ta)[]) {
          if (ta[k] !== tb[k]) textDiffs.push(`### ${c.who}-${c.theme}-${c.device} · ${screen} · ${k}\n- old: ${ta[k].slice(0, 1500)}\n- new: ${tb[k].slice(0, 1500)}\n`);
        }
      }
      rows.push(`| ${c.who} | ${c.theme} | ${c.device} | ${screen} | ${d.pct.toFixed(2)}% | ${d.size.slice(0, 2).join("×")} / ${d.size.slice(2).join("×")} | ${same ? "כן" : "**לא**"} |`);
      console.log(`${c.who}-${c.theme}-${c.device} ${screen}: ${d.pct.toFixed(2)}% ${same ? "" : "TEXT DIFFERS"}`);
      await Promise.all([oldP.close(), newP.close()]);
    }
    await ctx.close();
  }
  writeFileSync(join(OUT, "shots.md"), `# השוואת מסכים (ישן מול חדש)\n\n${rows.join("\n")}\n\n## הבדלי טקסט\n\n${textDiffs.join("\n") || "אין"}\n`);
}

/** Every request a page sends to this server, by path (the query's values folded), for `ms`. */
async function countRequests(page: Page, ms: number) {
  const counts = new Map<string, number>();
  const on = (r: { url(): string }) => {
    const u = new URL(r.url());
    if (u.origin !== BASE) return;
    if (u.pathname.startsWith("/dashboard")) return; // the page's own files
    const key = `${u.pathname}${u.search ? `?${[...u.searchParams.keys()].join("&")}` : ""}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  page.on("request", on);
  await page.waitForTimeout(ms);
  page.off("request", on);
  return counts;
}

const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate((h) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);

async function requests(browser: Browser) {
  const secs = Number(values.seconds);
  const out: string[] = [`# בקשות לשרת: ישן מול חדש (${secs} שניות בכל מסך, אחרי 3 שניות טעינה)\n`];
  const summary: string[] = ["| מי | מסך | מצב | ישן | חדש | הבדל |", "|---|---|---|---|---|---|"];
  for (const who of ["admin", "mishlav"] as Who[]) {
    const c: Combo = { who, theme: "light", device: "desktop" };
    const ctx = await contextFor(browser, c);
    for (const screen of pickScreens(who === "admin" ? ADMIN_SCREENS : MISHLAV_SCREENS)) {
      const [oldP, newP] = await Promise.all([open(ctx, "/dashboard", screen, c), open(ctx, "/dashboard-new", screen, c)]);
      // in front
      const [a, b] = await Promise.all([countRequests(oldP, secs * 1000), countRequests(newP, secs * 1000)]);
      // in the background, then in front again (one catch-up expected)
      await Promise.all([setHidden(oldP, true), setHidden(newP, true)]);
      const [ha, hb] = await Promise.all([countRequests(oldP, 25_000), countRequests(newP, 25_000)]);
      await Promise.all([setHidden(oldP, false), setHidden(newP, false)]);
      const [va, vb] = await Promise.all([countRequests(oldP, 1500), countRequests(newP, 1500)]);
      for (const [state, x, y] of [["בקדמה", a, b], ["ברקע 25 שניות", ha, hb], ["חזרה לקדמה (1.5 שניות)", va, vb]] as const) {
        const keys = [...new Set([...x.keys(), ...y.keys()])].sort();
        const total = (m: Map<string, number>) => [...m.values()].reduce((s, n) => s + n, 0);
        out.push(`## ${who} · ${screen} · ${state}\n\n| בקשה | ישן | חדש |\n|---|---|---|\n${keys.map((k) => `| \`${k}\` | ${x.get(k) ?? 0} | ${y.get(k) ?? 0} |`).join("\n")}\n| **סך הכול** | **${total(x)}** | **${total(y)}** |\n`);
        const diff = total(y) - total(x);
        summary.push(`| ${who} | ${screen} | ${state} | ${total(x)} | ${total(y)} | ${diff > 0 ? `**+${diff}**` : diff} |`);
      }
      console.log(`requests ${who} ${screen}: old ${[...a.values()].reduce((s, n) => s + n, 0)} new ${[...b.values()].reduce((s, n) => s + n, 0)}`);
      await Promise.all([oldP.close(), newP.close()]);
    }
    await ctx.close();
  }
  writeFileSync(join(OUT, "requests.md"), `${out[0]}\n## סיכום\n\n${summary.join("\n")}\n\n${out.slice(1).join("\n")}`);
}

// ------------------------------------------------------------------ the same clicks on both, a screenshot after each

type Step = { name: string; act: (p: Page) => Promise<unknown>; wait?: number };
type Flow = { name: string; who: Who; screen: string; device?: "desktop" | "mobile"; steps: Step[]; mask?: string[] };
const click = (sel: string) => (p: Page) => p.locator(sel).first().click();
const FLOWS: Flow[] = [
  { name: "contact-drawer", who: "admin", screen: "contacts", steps: [{ name: "row", act: click("#cBody tr.click") }] },
  {
    name: "contacts-all",
    who: "admin",
    screen: "contacts",
    steps: [
      { name: "tab-all", act: click('#cView button[data-v="all"]') },
      { name: "next-page", act: click('#cPager [class="btn sm"]:last-child') },
      { name: "search", act: (p) => p.fill("#cSearch", "נועה"), wait: 1500 },
      { name: "status", act: (p) => p.selectOption("#cStatus", "new"), wait: 1500 },
      { name: "tab-queue", act: click('#cView button[data-v="queue"]') },
    ],
  },
  { name: "call-drawer", who: "admin", screen: "calls", steps: [{ name: "row", act: click("#callsBody tr.click"), wait: 2500 }] },
  {
    name: "calls-filters",
    who: "admin",
    screen: "calls",
    steps: [
      { name: "rec-only", act: click("#callsRecOnly") },
      { name: "rec-off", act: click("#callsRecOnly") },
      { name: "origin-manual", act: click('#callsOrigin button[data-v="manual"]') },
      { name: "origin-all", act: click('#callsOrigin button[data-v="all"]') },
      { name: "play", act: click("#callsBody [data-play]"), wait: 2000 },
    ],
  },
  { name: "dialer-confirm", who: "admin", screen: "overview", steps: [{ name: "start", act: click("#dialerStart"), wait: 800 }, { name: "cancel", act: click("#modalCancel"), wait: 800 }] },
  { name: "queue-contact", who: "admin", screen: "overview", steps: [{ name: "queue-row", act: click("#ovQueue li.click") }] },
  {
    name: "study-day",
    who: "mishlav",
    screen: "study-days",
    steps: [
      { name: "row", act: click("#sdBody tr.click") },
      { name: "edit", act: click("#sdEdit") },
      { name: "hotel", act: click('#fFormat button[data-v="hotel"]') },
      { name: "cancel", act: click("#fCancel") },
      { name: "archive-confirm", act: click("#sdArchive"), wait: 800 },
      { name: "archive-cancel", act: click("#modalCancel"), wait: 800 },
      { name: "filter-past", act: click('#sdFilter button[data-f="past"]') },
      { name: "new", act: click("#sdNew") },
    ],
  },
  {
    name: "users",
    who: "admin",
    screen: "users",
    mask: ['input[name="password"]'],
    steps: [
      { name: "row", act: click("#usBody tr.click") },
      { name: "new", act: click("#usNew") },
      { name: "role-admin", act: click('#usRole button[data-v="admin"]') },
    ],
  },
  { name: "reps-done-toggle", who: "admin", screen: "reps", steps: [{ name: "show-done", act: click("#rDone") }] },
  { name: "logs-kinds", who: "admin", screen: "logs", steps: [{ name: "off-line", act: click('#lKinds button[data-k="line"]') }, { name: "pause", act: click("#lPause") }] },
  { name: "gold-since", who: "admin", screen: "gold", steps: [{ name: "week", act: (p) => p.selectOption(".gSince", "168"), wait: 1500 }] },
  { name: "mobile-menu", who: "mishlav", screen: "calls", device: "mobile", steps: [{ name: "open", act: click("#menuBtn") }, { name: "close", act: click("#scrim") }] },
  { name: "theme", who: "admin", screen: "reps", steps: [{ name: "toggle", act: click("#themeBtn") }, { name: "back", act: click("#themeBtn") }] },
  { name: "password-dialog", who: "mishlav", screen: "overview", steps: [{ name: "open", act: click("#pwBtn"), wait: 800 }, { name: "wrong", act: (p) => p.fill("#pwCurrent", "wrong").then(() => p.click('#pwForm button[type="submit"]')), wait: 1500 }] },
  { name: "self-test-voice", who: "mishlav", screen: "self-test", steps: [{ name: "pick-day", act: (p) => p.selectOption("#stDay", { index: 1 }) }] },
];

async function flows(browser: Browser) {
  const rows: string[] = ["| תרחיש | צעד | פיקסלים שונים | טקסט זהה |", "|---|---|---|---|"];
  const textDiffs: string[] = [];
  const blankCtx = await browser.newContext();
  await blankCtx.addInitScript(NAME_HELPER);
  const blank = await blankCtx.newPage();
  const only = values.screens ? values.screens.split(",") : null;
  for (const f of FLOWS.filter((x) => !only || only.includes(x.name))) {
    const c: Combo = { who: f.who, theme: "light", device: f.device ?? "desktop" };
    const ctx = await contextFor(browser, c);
    const dir = join(OUT, "flows", f.name);
    mkdirSync(dir, { recursive: true });
    const [oldP, newP] = await Promise.all([open(ctx, "/dashboard", f.screen, c), open(ctx, "/dashboard-new", f.screen, c)]);
    for (const s of f.steps) {
      let err = "";
      for (const p of [oldP, newP]) {
        try {
          await s.act(p);
        } catch (e) {
          err += `${p === oldP ? "old" : "new"}: ${(e as Error).message.split("\n")[0]} `;
        }
      }
      await Promise.all([oldP.waitForTimeout(s.wait ?? 1200), newP.waitForTimeout(s.wait ?? 1200)]);
      const mask = (p: Page) => (f.mask ?? []).map((m) => p.locator(m));
      const [a, b] = await Promise.all([oldP.screenshot({ mask: mask(oldP) }), newP.screenshot({ mask: mask(newP) })]);
      writeFileSync(join(dir, `${s.name}-old.png`), a);
      writeFileSync(join(dir, `${s.name}-new.png`), b);
      const d = await pixelDiff(blank, a, b, join(dir, `${s.name}-diff.png`));
      const [ta, tb] = await Promise.all([flowText(oldP), flowText(newP)]);
      const same = ta === tb;
      if (!same) textDiffs.push(`### ${f.name} · ${s.name}\n- old: ${ta.slice(0, 1200)}\n- new: ${tb.slice(0, 1200)}\n`);
      rows.push(`| ${f.name} | ${s.name} | ${d.pct.toFixed(2)}% | ${same ? "כן" : "**לא**"}${err ? ` (${err})` : ""} |`);
      console.log(`flow ${f.name} ${s.name}: ${d.pct.toFixed(2)}% ${same ? "" : "TEXT DIFFERS"} ${err}`);
    }
    await Promise.all([oldP.close(), newP.close()]);
    await ctx.close();
  }
  writeFileSync(join(OUT, "flows.md"), `# פעולות: אותם קליקים על הישן ועל החדש\n\n${rows.join("\n")}\n\n## הבדלי טקסט\n\n${textDiffs.join("\n") || "אין"}\n`);
}

/** What is on the screen now: the view, the open drawer, the open dialog, the toasts (numbers folded). */
const flowText = (p: Page) =>
  p.evaluate(() => {
    const t = (el: Element | null) => ((el as HTMLElement | null)?.innerText ?? "").replace(/\s+/g, " ").trim();
    const drawer = document.querySelector(".drawer.open");
    const dialog = [...document.querySelectorAll("dialog")].find((d) => d.open) ?? null;
    return [t(document.querySelector("#view")), drawer ? t(drawer) : "", dialog ? t(dialog) : "", t(document.querySelector("#toasts")), location.hash, document.title]
      .join(" | ")
      .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, "#:#")
      .replace(/\d+/g, "#");
  });

/** A live call on the (pretend) line: the top bar, the overview's live card, the call's drawer, on both. */
async function liveFlow(browser: Browser) {
  const c: Combo = { who: "admin", theme: "light", device: "desktop" };
  const ctx = await contextFor(browser, c);
  const dir = join(OUT, "flows", "live-call");
  mkdirSync(dir, { recursive: true });
  const [oldP, newP] = await Promise.all([open(ctx, "/dashboard", "overview", c), open(ctx, "/dashboard-new", "overview", c)]);
  const r = await fetch(`${BASE}/test/phone/call`, { method: "POST", headers: { "x-tools-secret": SECRET, "content-type": "application/json" }, body: JSON.stringify({ number: "0500000101", name: "בודק" }) });
  console.log(`live call: ${r.status}`);
  const blankCtx = await browser.newContext();
  await blankCtx.addInitScript(NAME_HELPER);
  const blank = await blankCtx.newPage();
  const rows: string[] = [];
  const snap = async (name: string) => {
    const [a, b] = await Promise.all([oldP.screenshot(), newP.screenshot()]);
    writeFileSync(join(dir, `${name}-old.png`), a);
    writeFileSync(join(dir, `${name}-new.png`), b);
    const d = await pixelDiff(blank, a, b, join(dir, `${name}-diff.png`));
    const [ta, tb] = await Promise.all([flowText(oldP), flowText(newP)]);
    rows.push(`| live-call | ${name} | ${d.pct.toFixed(2)}% | ${ta === tb ? "כן" : `**לא**<br>old: ${ta.slice(0, 400)}<br>new: ${tb.slice(0, 400)}`} |`);
    console.log(`flow live-call ${name}: ${d.pct.toFixed(2)}% ${ta === tb ? "" : "TEXT DIFFERS"}`);
  };
  await oldP.waitForTimeout(9000);
  await snap("overview-during");
  await Promise.all([oldP.click("#liveCallBtn"), newP.click("#liveCallBtn")]);
  await oldP.waitForTimeout(3000);
  await snap("drawer-during");
  await oldP.waitForTimeout(12_000);
  await snap("drawer-after");
  await Promise.all([oldP.keyboard.press("Escape"), newP.keyboard.press("Escape")]);
  await Promise.all([oldP.goto(`${BASE}/dashboard#/calls`), newP.goto(`${BASE}/dashboard-new#/calls`)]);
  await oldP.waitForTimeout(3500);
  await snap("calls-after");
  writeFileSync(join(OUT, "flows-live.md"), `| תרחיש | צעד | פיקסלים שונים | טקסט זהה |\n|---|---|---|---|\n${rows.join("\n")}\n`);
  await ctx.close();
}

/** Addresses: the key leaves the address bar, old bookmarks (#tab=) still open their screen, a role's fallback. */
async function addresses(browser: Browser) {
  const out: string[] = ["| כתובת | מי | ישן: מסך / כתובת אחרי | חדש: מסך / כתובת אחרי | זהה |", "|---|---|---|---|---|"];
  const cases: [string, Who][] = [
    [`#k=${SECRET}`, "admin"],
    [`#k=${SECRET}&tab=phone`, "admin"],
    [`#/calls&k=${SECRET}`, "admin"],
    ["#tab=logs", "admin"],
    ["#tab=results", "admin"],
    ["#tab=test", "admin"],
    ["#/no-such-screen", "admin"],
    ["#/logs", "mishlav"],
    ["#tab=phone", "mishlav"],
    ["#/self-test", "admin"],
    ["#/self-test", "mishlav"],
  ];
  for (const [hash, who] of cases) {
    const c: Combo = { who, theme: "light", device: "desktop" };
    const ctx = await contextFor(browser, c);
    const res: string[] = [];
    for (const path of ["/dashboard", "/dashboard-new"]) {
      const p = await ctx.newPage();
      await p.goto(`${BASE}${path}${hash}`);
      await p.waitForSelector("#userBox:not([hidden])");
      await p.waitForTimeout(800);
      res.push(await p.evaluate(() => `${document.querySelector("#pageTitle")?.textContent} / ${location.hash || "(ריק)"}`));
      await p.close();
    }
    out.push(`| \`${hash.replace(SECRET, "<key>")}\` | ${who} | ${res[0]!.replace(SECRET, "<key>")} | ${res[1]!.replace(SECRET, "<key>")} | ${res[0] === res[1] ? "כן" : "**לא**"} |`);
    await ctx.close();
  }
  writeFileSync(join(OUT, "addresses.md"), `# כתובות וקישורים ישנים\n\n${out.join("\n")}\n`);
  console.log(out.join("\n"));
}

const browser = await launch();
try {
  if (values.only === "flows") await flows(browser);
  if (values.only === "live") await liveFlow(browser);
  if (values.only === "addresses") await addresses(browser);
  if (!values.only || values.only === "shots") {
    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });
    await shots(browser);
  }
  if (!values.only || values.only === "requests") {
    mkdirSync(OUT, { recursive: true });
    await requests(browser);
  }
} finally {
  await browser.close();
}
console.log(`\nwritten to ${OUT}`);
