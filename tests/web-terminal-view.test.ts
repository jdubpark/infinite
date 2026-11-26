import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();
const skip = existsSync(executablePath) ? false : "Chromium for Playwright is not installed; run `npx playwright install chromium`";
const harness = fileURLToPath(new URL("./fixtures/web-terminal-view-harness.tsx", import.meta.url));
const stylePath = fileURLToPath(new URL("../apps/web/src/style.css", import.meta.url));
const xtermCssPath = fileURLToPath(new URL("../node_modules/@xterm/xterm/css/xterm.css", import.meta.url));
const ORIGIN = "http://127.0.0.1/terminal-view";

describe("web TerminalView geometry and cursor resume", { skip }, () => {
  let browser: Browser;
  let script: string;
  let css: string;

  before(async () => {
    script = (await build({
      entryPoints: [harness],
      bundle: true,
      write: false,
      format: "iife",
      jsx: "automatic",
      logLevel: "silent",
      loader: { ".css": "empty" },
      define: { "process.env.NODE_ENV": '"production"' },
    })).outputFiles[0].text;
    css = `${readFileSync(xtermCssPath, "utf8")}\n${readFileSync(stylePath, "utf8")}`;
    browser = await chromium.launch({ executablePath });
  });

  after(() => browser?.close());

  async function openView(init: { pages: Record<number, unknown>; holdWriteText?: string; holdFetchCount?: number }): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 400, height: 640 } });
    await page.route(ORIGIN, route =>
      route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div></body></html>` }),
    );
    await page.goto(ORIGIN);
    await page.evaluate(value => { Object.assign(window, { terminalViewInit: value }); }, init);
    await page.addScriptTag({ content: script });
    return page;
  }

  test("server-sized grid stays scrollable horizontally and vertically on a narrow viewport without clipping", async () => {
    const wide = "W".repeat(118);
    const rows = Array.from({ length: 30 }, (_, index) => `ROW_${index + 2}`).join("\r\n");
    const page = await openView({
      pages: {
        0: {
          cursor: 3,
          more: false,
          events: [
            { seq: 2, at: "2026-11-26T00:00:00.000Z", type: "lifecycle", data: { status: "running", pid: 100, cols: 120, rows: 32 } },
            { seq: 3, at: "2026-11-26T00:00:01.000Z", type: "output", data: { text: `${wide}\r\n${rows}` } },
          ],
        },
      },
    });
    try {
      await page.waitForFunction(() => {
        const el = document.querySelector(".terminal");
        const h = (window as unknown as { terminalViewHarness?: { terminalCols: () => number; terminalRows: () => number } }).terminalViewHarness;
        return el?.getAttribute("data-server-sized") === "true" && h?.terminalCols() === 120 && h?.terminalRows() === 32;
      }, undefined, { timeout: 5000 });

      const metrics = await page.evaluate(() => {
        const el = document.querySelector(".terminal") as HTMLElement;
        const style = getComputedStyle(el);
        el.scrollLeft = el.scrollWidth;
        el.scrollTop = el.scrollHeight;
        return {
          className: el.className,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          clientWidth: el.clientWidth,
          scrollWidth: el.scrollWidth,
          clientHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
          scrollLeft: el.scrollLeft,
          scrollTop: el.scrollTop,
        };
      });
      assert.ok(metrics.className.includes("is-server-sized"));
      assert.equal(metrics.overflowX, "auto");
      assert.equal(metrics.overflowY, "auto");
      assert.ok(metrics.scrollWidth > metrics.clientWidth, `expected horizontal overflow (${metrics.scrollWidth} > ${metrics.clientWidth})`);
      assert.ok(metrics.scrollHeight > metrics.clientHeight, `expected vertical overflow (${metrics.scrollHeight} > ${metrics.clientHeight})`);
      assert.ok(metrics.scrollLeft > 0, "horizontal scroll reaches columns beyond the narrow pane");
      assert.ok(metrics.scrollTop > 0, "vertical scroll reaches rows below the fixed container height");

      await page.setViewportSize({ width: 320, height: 500 });
      await page.waitForTimeout(150);
      const afterResize = await page.evaluate(() => {
        const h = (window as unknown as { terminalViewHarness: { terminalCols: () => number; terminalRows: () => number; terminalLines: () => string[] } }).terminalViewHarness;
        return { cols: h.terminalCols(), rows: h.terminalRows(), firstLine: h.terminalLines()[0] };
      });
      assert.equal(afterResize.cols, 120);
      assert.equal(afterResize.rows, 32);
      assert.equal(afterResize.firstLine, wide);
    } finally {
      await page.close();
    }
  });

  test("visibilitychange interruption mid-page resumes after the last written event without duplicate writes", async () => {
    const page = await openView({
      holdWriteText: "FIRST_EVENT_ROW",
      pages: {
        0: {
          cursor: 4,
          more: false,
          events: [
            { seq: 2, at: "2026-11-26T00:00:00.000Z", type: "lifecycle", data: { status: "running", pid: 100, cols: 100, rows: 24 } },
            { seq: 3, at: "2026-11-26T00:00:01.000Z", type: "output", data: { text: "FIRST_EVENT_ROW\r\n" } },
            { seq: 4, at: "2026-11-26T00:00:02.000Z", type: "output", data: { text: "SECOND_EVENT_ROW\r\n" } },
          ],
        },
        3: {
          cursor: 4,
          more: false,
          events: [
            { seq: 4, at: "2026-11-26T00:00:02.000Z", type: "output", data: { text: "SECOND_EVENT_ROW\r\n" } },
          ],
        },
      },
    });
    try {
      await page.waitForFunction(() => Boolean((window as unknown as { terminalViewHarness?: { writeHeld: boolean } }).terminalViewHarness?.writeHeld), undefined, { timeout: 5000 });

      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
        const h = (window as unknown as { terminalViewHarness: { releaseWrite: (() => void) | null } }).terminalViewHarness;
        h.releaseWrite?.();
      });

      await page.waitForFunction(() => {
        const h = (window as unknown as { terminalViewHarness?: { terminalLines: () => string[] } }).terminalViewHarness;
        return Boolean(h?.terminalLines().includes("SECOND_EVENT_ROW"));
      }, undefined, { timeout: 5000 });

      const result = await page.evaluate(() => {
        const h = (window as unknown as { terminalViewHarness: { requests: string[]; writes: string[]; terminalLines: () => string[] } }).terminalViewHarness;
        return { requests: h.requests, writes: h.writes, lines: h.terminalLines() };
      });
      assert.ok(result.requests.includes("/sessions/s1/events?after=3"), `expected resume from after=3, got ${JSON.stringify(result.requests)}`);
      assert.equal(result.requests.filter(req => req === "/sessions/s1/events?after=0").length, 1, "initial page must never be re-fetched after writing its prefix");
      assert.equal(result.writes.filter(chunk => chunk.includes("FIRST_EVENT_ROW")).length, 1, "first event is written once");
      assert.equal(result.writes.filter(chunk => chunk.includes("SECOND_EVENT_ROW")).length, 1, "second event is written once");
      assert.deepEqual(result.lines, ["FIRST_EVENT_ROW", "SECOND_EVENT_ROW"]);
    } finally {
      await page.close();
    }
  });

  test("a stale poll resolving while a newer poll is mid-write does not clear the write guard", async () => {
    const page = await openView({
      holdFetchCount: 1,
      holdWriteText: "POLL2_FIRST_ROW",
      pages: {
        0: {
          cursor: 4,
          more: false,
          events: [
            { seq: 2, at: "2026-11-26T00:00:00.000Z", type: "lifecycle", data: { status: "running", pid: 100, cols: 100, rows: 24 } },
            { seq: 3, at: "2026-11-26T00:00:01.000Z", type: "output", data: { text: "POLL2_FIRST_ROW\r\n" } },
            { seq: 4, at: "2026-11-26T00:00:02.000Z", type: "output", data: { text: "POLL2_SECOND_ROW\r\n" } },
          ],
        },
        3: {
          cursor: 4,
          more: false,
          events: [
            { seq: 4, at: "2026-11-26T00:00:02.000Z", type: "output", data: { text: "POLL2_SECOND_ROW\r\n" } },
          ],
        },
      },
    });
    try {
      await page.waitForFunction(() => ((window as unknown as { terminalViewHarness?: { pendingFetches: unknown[] } }).terminalViewHarness?.pendingFetches.length ?? 0) === 1, undefined, { timeout: 5000 });

      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
      });

      await page.waitForFunction(() => Boolean((window as unknown as { terminalViewHarness?: { writeHeld: boolean } }).terminalViewHarness?.writeHeld), undefined, { timeout: 5000 });

      await page.evaluate(() => {
        const h = (window as unknown as { terminalViewHarness: { pendingFetches: Array<() => void> } }).terminalViewHarness;
        h.pendingFetches.shift()?.();
      });
      await page.waitForTimeout(60);

      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.waitForTimeout(60);

      const requestsBeforeRelease = await page.evaluate(() => {
        const h = (window as unknown as { terminalViewHarness: { requests: string[] } }).terminalViewHarness;
        return [...h.requests];
      });
      assert.deepEqual(
        requestsBeforeRelease,
        ["/sessions/s1/events?after=0", "/sessions/s1/events?after=0"],
        "stale poll1 settling must not unlock activeConsumer and allow poll3 to start while poll2 is mid-write",
      );

      await page.evaluate(() => {
        const h = (window as unknown as { terminalViewHarness: { releaseWrite: (() => void) | null } }).terminalViewHarness;
        h.releaseWrite?.();
      });

      await page.waitForFunction(() => {
        const h = (window as unknown as { terminalViewHarness?: { terminalLines: () => string[] } }).terminalViewHarness;
        return Boolean(h?.terminalLines().includes("POLL2_SECOND_ROW"));
      }, undefined, { timeout: 5000 });

      const finalState = await page.evaluate(() => {
        const h = (window as unknown as { terminalViewHarness: { requests: string[]; writes: string[]; terminalLines: () => string[] } }).terminalViewHarness;
        return { requests: h.requests, writes: h.writes, lines: h.terminalLines() };
      });
      assert.ok(finalState.requests.includes("/sessions/s1/events?after=3"));
      assert.equal(finalState.writes.filter(chunk => chunk.includes("POLL2_FIRST_ROW")).length, 1);
      assert.equal(finalState.writes.filter(chunk => chunk.includes("POLL2_SECOND_ROW")).length, 1);
      assert.deepEqual(finalState.lines, ["POLL2_FIRST_ROW", "POLL2_SECOND_ROW"]);
    } finally {
      await page.close();
    }
  });
});
