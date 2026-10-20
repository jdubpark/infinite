import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";

// Runs the web client's conversation panel and control lease in Chromium and toggles page visibility to check their requests.
// PLAYWRIGHT_CHROMIUM_PATH selects a Chromium build other than the one `npx playwright install chromium` provides.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();
const skip = existsSync(executablePath) ? false : "Chromium for Playwright is not installed; run `npx playwright install chromium`";
const harness = fileURLToPath(new URL("./fixtures/web-polling-harness.tsx", import.meta.url));
const controlHarness = fileURLToPath(new URL("./fixtures/web-control-harness.tsx", import.meta.url));
const ORIGIN = "http://127.0.0.1/polling";

describe("web conversation polling", { skip }, () => {
  let browser: Browser;
  let script: string, controlScript: string;
  const bundle = async (entry: string) => (await build({ entryPoints: [entry], bundle: true, write: false, format: "iife", jsx: "automatic", logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' } })).outputFiles[0].text;
  before(async () => {
    [script, controlScript] = await Promise.all([bundle(harness), bundle(controlHarness)]);
    browser = await chromium.launch({ executablePath });
  });
  after(() => browser?.close());

  async function load(content: string): Promise<Page> {
    const page = await browser.newPage();
    await page.route(ORIGIN, route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
    await page.goto(ORIGIN);
    await page.addScriptTag({ content });
    return page;
  }
  async function open(): Promise<Page> {
    const page = await load(script);
    await page.waitForFunction(() => (window as unknown as { polling: { requests: number } }).polling.requests >= 1);
    return page;
  }
  const requests = (page: Page) => page.evaluate(() => (window as unknown as { polling: { requests: number } }).polling.requests);
  const setVisibility = (page: Page, state: "hidden" | "visible") => page.evaluate(state => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);

  test("a hidden tab stops polling, and returning to it polls at once", async () => {
    const page = await open();
    try {
      // The idle interval is 1.5 seconds, so a visible tab adds a request about that often.
      await page.waitForFunction(() => (window as unknown as { polling: { requests: number } }).polling.requests >= 2, undefined, { timeout: 4000 });
      await setVisibility(page, "hidden");
      await page.waitForTimeout(100);
      const hidden = await requests(page);
      await page.waitForTimeout(3500);
      assert.equal(await requests(page), hidden);

      await setVisibility(page, "visible");
      // Returning polls immediately, well inside the 1.5-second interval.
      await page.waitForFunction(count => (window as unknown as { polling: { requests: number } }).polling.requests > count, hidden, { timeout: 500 });
    } finally {
      await page.close();
    }
  });

  test("a reply to a read started before the tab was hidden is dropped; returning reads again", async () => {
    type Control = { requests: number; hold: boolean; pending: ((page: { messages: { id: string; role: string; text: string }[]; cursor: number }) => void)[] };
    const page = await open();
    try {
      await page.evaluate(() => { (window as unknown as { polling: Control }).polling.hold = true; });
      await page.waitForFunction(() => (window as unknown as { polling: Control }).polling.pending.length === 1, undefined, { timeout: 4000 });
      await setVisibility(page, "hidden");
      await setVisibility(page, "visible");
      // The earlier read is still unanswered, yet returning starts a new one at once.
      await page.waitForFunction(() => (window as unknown as { polling: Control }).polling.pending.length === 2, undefined, { timeout: 500 });
      await page.evaluate(() => {
        const [before, after] = (window as unknown as { polling: Control }).polling.pending;
        before({ messages: [{ id: "m1", role: "assistant", text: "read before hiding" }], cursor: 1 });
        after({ messages: [{ id: "m2", role: "assistant", text: "read after returning" }], cursor: 1 });
      });
      await page.getByText("read after returning").waitFor({ timeout: 2000 });
      assert.equal(await page.getByText("read before hiding").count(), 0);
    } finally {
      await page.close();
    }
  });

  test("returning hides an earlier stale warning until a new read has had its grace period", async () => {
    type Control = { fail: boolean; hold: boolean; pending: unknown[] };
    const page = await open();
    const warning = page.getByText("Conversation may be stale");
    try {
      await page.evaluate(() => { (window as unknown as { polling: Control }).polling.fail = true; });
      await warning.waitFor({ timeout: 8000 });
      const waiting = await page.evaluate(() => {
        const control = (window as unknown as { polling: Control }).polling;
        control.fail = false; control.hold = true;
        return control.pending.length;
      });
      await setVisibility(page, "hidden");
      await setVisibility(page, "visible");
      await page.waitForFunction(count => (window as unknown as { polling: Control }).polling.pending.length > count, waiting, { timeout: 500 });
      await warning.waitFor({ state: "hidden", timeout: 500 });
      await page.waitForTimeout(1500);
      assert.equal(await warning.count(), 0);
      // The read started on return is still unanswered, so the warning comes back after the grace period.
      await warning.waitFor({ timeout: 3000 });
    } finally {
      await page.close();
    }
  });

  test("a held control lease renews as soon as a hidden tab returns", async () => {
    type Control = { renewals: number; held: { id: string } | null; claim: () => void };
    const page = await load(controlScript);
    try {
      await page.waitForFunction(() => { (window as unknown as { control: Control }).control.claim(); return true; });
      await page.waitForFunction(() => (window as unknown as { control: Control }).control.held?.id === "lease-1", undefined, { timeout: 2000 });
      await setVisibility(page, "hidden");
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => (window as unknown as { control: Control }).control.renewals), 0);
      await setVisibility(page, "visible");
      // The periodic renewal is every 10 seconds, so a renewal within half a second comes from the return itself.
      await page.waitForFunction(() => (window as unknown as { control: Control }).control.renewals === 1, undefined, { timeout: 500 });
    } finally {
      await page.close();
    }
  });
});
