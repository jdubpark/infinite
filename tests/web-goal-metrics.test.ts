import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { GoalMetricsPanel } from "../apps/web/src/goal-metrics";
import type { GoalMetricsView, MetricPoint, MetricSeries } from "../apps/web/src/api";

(globalThis as { React?: unknown }).React = React;

const point = (cycle: number, value: number): MetricPoint => ({ cycle, run: "t" + cycle, revision: 1, head: "a".repeat(40), value, at: "2026-11-27T10:00:00.000Z" });
const series = (overrides: Partial<MetricSeries> = {}): MetricSeries => ({ command: "npm run bench", label: "npm run bench", name: "cold_start_ms", configured: true, points: [point(1, 10), point(2, 8)], ...overrides });
const view = (overrides: Partial<GoalMetricsView> = {}): GoalMetricsView => ({ series: [series()], omittedSeries: 0, omittedValues: 0, dropped: 0, ...overrides });
const render = (metrics: GoalMetricsView | null, error = "", cycles = [1, 2, 3, 4]) => renderToStaticMarkup(createElement(GoalMetricsPanel, { metrics, error, cycles }));
const cx = (html: string) => [...html.matchAll(/<circle[^>]*cx="([\d.]+)"/g)].map(match => match[1]);
const paths = (html: string) => [...html.matchAll(/<path /g)].length;

test("a cycle without a report is a blank position, never a zero or a carried value", () => {
  const html = render(view({ series: [series({ points: [point(1, 10), point(2, 8), point(4, 6)] })] }));
  assert.deepEqual(cx(html), ["5.0", "55.0", "155.0"]);
  assert.equal(paths(html), 1);
  assert.equal([...html.matchAll(/[ML]\d/g)].length, 2);
  assert.ok(html.includes("3 reported values over 4 cycles"));
});

test("a series is labelled with its name and command, truncated visually with the full text in a title", () => {
  const long = "npm run bench -- " + "x".repeat(150);
  const html = render(view({ series: [series({ label: long })] }));
  assert.ok(html.includes("<strong>cold_start_ms</strong>"));
  assert.ok(html.includes(`title="${long}"`));
});

test("a series whose command is no longer configured is still shown and marked", () => {
  const html = render(view({ series: [series({ configured: false, label: undefined })] }));
  assert.ok(html.includes("cold_start_ms"));
  assert.ok(html.includes("no longer configured"));
  assert.ok(!render(view()).includes("no longer configured"));
});

test("each series shows its latest value and cycle", () => {
  const html = render(view({ series: [series({ points: [point(1, 10), point(3, 7.25)] })] }));
  assert.ok(html.includes("7.25"));
  assert.ok(html.includes("latest, cycle 3"));
});

test("non-zero counts of left-out series, values and removed entries are shown, zero counts are not", () => {
  const html = render(view({ omittedSeries: 2, omittedValues: 3, dropped: 5 }));
  assert.ok(html.includes("2 series left out"));
  assert.ok(html.includes("3 values left out"));
  assert.ok(html.includes("5 older cycle entries removed by retention"));
  assert.ok(!/left out|removed by retention/.test(render(view())));
});

test("the panel says reported, never measured or verified", () => {
  const html = render(view({ omittedSeries: 1, omittedValues: 1, dropped: 1 }));
  assert.ok(/reported/i.test(html));
  assert.ok(!/measured|verified/i.test(html));
});

test("with no series one quiet line says how a check reports a number", () => {
  const html = render(view({ series: [] }));
  assert.ok(html.includes("No check has reported a number yet"));
  assert.ok(html.includes("<code>infinite-metric NAME VALUE</code>"));
  assert.ok(!html.includes("<svg"));
});

test("a failed read shows an error line instead of a curve", () => {
  const html = render(null, "Metrics unavailable");
  assert.ok(html.includes("Reported numbers could not be loaded. Metrics unavailable"));
  assert.ok(!html.includes("Loading reported numbers"));
});

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();
const skipBrowser = existsSync(executablePath) ? false : "Chromium for Playwright is not installed";
const harness = fileURLToPath(new URL("./fixtures/web-goal-metrics-harness.tsx", import.meta.url));
const ORIGIN = "http://127.0.0.1/goal-metrics";

describe("goal view reported numbers in a browser", { skip: skipBrowser }, () => {
  let browser: Browser;
  let script = "";
  let styles = "";
  before(async () => {
    const bundle = await build({ entryPoints: [harness], bundle: true, write: false, outdir: "out", format: "iife", jsx: "automatic", logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' } });
    script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
    styles = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
    browser = await chromium.launch({ executablePath });
  });
  after(() => browser?.close());

  async function open(scenario: string, width = 1280): Promise<{ page: Page; errors: string[] }> {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route(`${ORIGIN}*`, route => route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="icon" href="data:,"></head><body><div id="root"></div></body></html>' }));
    await page.goto(`${ORIGIN}?scenario=${scenario}`);
    await page.addStyleTag({ content: `html,body{margin:0}${styles}` });
    await page.addScriptTag({ content: script });
    await page.waitForSelector(".goal-detail");
    return { page, errors };
  }

  test("the goal view loads the curve through its refresh and shows both series", async () => {
    const { page, errors } = await open("series");
    try {
      await page.waitForSelector(".goal-metric");
      assert.equal(await page.locator(".goal-metric").count(), 2);
      const requests = await page.evaluate(() => (window as unknown as { __goalMetricsTest: { requests: string[] } }).__goalMetricsTest.requests);
      assert.ok(requests.includes("/goals/goal-1/metrics"));
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  test("a failed metrics read leaves the goal view intact", async () => {
    const { page, errors } = await open("fail");
    try {
      await page.waitForSelector(".goal-metric-error");
      assert.match((await page.locator("h1").first().textContent()) ?? "", /Cut cold start time/);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
});
