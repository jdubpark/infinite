import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();
const skipBrowser = existsSync(executablePath) ? false : "Chromium for Playwright is not installed";
const harness = fileURLToPath(new URL("./fixtures/web-repair-metrics-harness.tsx", import.meta.url));
const ORIGIN = "http://127.0.0.1/repair-metrics";

describe("web repair metrics Playwright E2E", { skip: skipBrowser }, () => {
  let browser: Browser;
  let script = "";
  let styles = "";

  before(async () => {
    const bundle = await build({
      entryPoints: [harness],
      bundle: true,
      write: false,
      outdir: "out",
      format: "iife",
      jsx: "automatic",
      logLevel: "silent",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
    styles = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
    browser = await chromium.launch({ executablePath });
  });

  after(() => browser?.close());

  async function open(query = "", hash = "#/cost"): Promise<{ page: Page; errors: string[] }> {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    try {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
      page.on("console", msg => {
        if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
      });
      await page.route(`${ORIGIN}*`, route =>
        route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="root"></div></body></html>',
        }),
      );
      await page.goto(`${ORIGIN}${query}${hash}`);
      await page.addStyleTag({ content: `html,body{margin:0;height:100%}${styles}` });
      await page.addScriptTag({ content: script });
      await page.waitForSelector(".cost-page");
      return { page, errors };
    } catch (error) {
      await page.close();
      throw error;
    }
  }

  test("renders mixed measured and unmeasured repair loops with denominator counts, gate status, and sample rows", async () => {
    const { page, errors } = await open("?scenario=mixed", "#/cost");
    try {
      await page.waitForSelector(".repair-table");
      const text = await page.locator(".repair-section").textContent();
      assert.match(text ?? "", /Repair loops/);
      assert.match(text ?? "", /Collecting baseline/);
      assert.match(text ?? "", /4 of 20 minimum repair loops observed/);
      assert.match(text ?? "", /2 resolved · 1 in progress · 1 unresolved/);
      assert.match(text ?? "", /12\.5 min/);
      assert.match(text ?? "", /p90 28\.0 min/);
      assert.match(text ?? "", /\$0\.42/);
      assert.match(text ?? "", /45\.2K median tokens/);
      assert.match(text ?? "", /2 unmeasured/);
      assert.match(text ?? "", /3 unmeasured members/);
      assert.match(text ?? "", /2 cold · 1 failed resume/);
      assert.match(text ?? "", /Review 2 · Check 1 · Delivery 1/);
      assert.match(text ?? "", /45\.2K tok · \$0\.42/);
      assert.match(text ?? "", /Unmeasured/);

      const requests = await page.evaluate(
        () => (window as unknown as { __repairMetricsTest: { requests: string[] } }).__repairMetricsTest.requests,
      );
      assert.ok(requests.includes("/usage/repair-loops?days=30"));
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });

  test("project detail scopes query and preserves Unmeasured medians when all loops lack pricing", async () => {
    const { page, errors } = await open("?scenario=mixed", "#/cost/projects/proj-alpha");
    try {
      await page.waitForSelector(".repair-table");
      const costKpi = await page.locator(".repair-kpi", { hasText: "Measured repair cost" }).textContent();
      assert.match(costKpi ?? "", /Unmeasured/);
      assert.doesNotMatch(costKpi ?? "", /\$0(?:\.00)?(?![.\d])/);
      assert.doesNotMatch(costKpi ?? "", /\b0\s+median tokens/i);

      const tableText = await page.locator(".repair-table tbody").textContent();
      assert.match(tableText ?? "", /Unmeasured/);
      assert.doesNotMatch(tableText ?? "", /\$0(?:\.00)?(?![.\d])/);

      const requests = await page.evaluate(
        () => (window as unknown as { __repairMetricsTest: { requests: string[] } }).__repairMetricsTest.requests,
      );
      assert.ok(requests.includes("/usage/repair-loops?project=proj-alpha&days=30"));
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });

  test("legacy host 404 degrades quietly inside Repair Loops without breaking the rest of Cost", async () => {
    const { page, errors } = await open("?scenario=legacy-404", "#/cost");
    try {
      await page.waitForSelector(".repair-unavailable");
      const heroText = await page.locator(".cost-hero").textContent();
      assert.match(heroText ?? "", /\$125\.00/);
      const repairText = await page.locator(".repair-section").textContent();
      assert.match(repairText ?? "", /Repair-loop metrics are not available on this host\./);
      assert.equal(await page.locator(".repair-table").count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });

  test("503 unavailable usage ledger shows quiet unavailable note inside Repair Loops", async () => {
    const { page, errors } = await open("?scenario=unavailable-503", "#/cost");
    try {
      await page.waitForSelector(".repair-unavailable");
      const heroText = await page.locator(".cost-hero").textContent();
      assert.match(heroText ?? "", /\$125\.00/);
      const repairText = await page.locator(".repair-section").textContent();
      assert.match(repairText ?? "", /Repair-loop metrics are unavailable because the usage ledger cannot be read\./);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });

  test("renders incomplete event coverage warning, unfinished loops note, and In progress / Unfinished badges", async () => {
    const { page, errors } = await open("?scenario=incomplete-unfinished", "#/cost");
    try {
      await page.waitForSelector(".repair-table");
      const warningText = await page.locator(".repair-warning").textContent();
      assert.match(warningText ?? "", /Incomplete events/);
      assert.match(
        warningText ?? "",
        /Event coverage is incomplete for 2 of 5 examined runs; loop counts may undercount actual repairs\./,
      );

      const repairText = await page.locator(".repair-section").textContent();
      assert.match(
        repairText ?? "",
        /2 of 3 loops are unfinished and excluded from token\/USD medians until final session usage settles\./,
      );

      const costCells = await page.locator(".repair-table tbody td[data-label='Measured cost']").allTextContents();
      assert.deepEqual(costCells, ["21.0K tok · $0.19", "In progress", "Unfinished"]);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });

  test("empty loops with incomplete event coverage explains reconstruction gap", async () => {
    const { page, errors } = await open("?scenario=empty-incomplete", "#/cost");
    try {
      await page.waitForSelector(".repair-warning");
      const repairText = await page.locator(".repair-section").textContent();
      assert.match(
        repairText ?? "",
        /Event coverage is incomplete for 3 of 4 examined runs; loop counts may undercount actual repairs\./,
      );
      assert.match(
        repairText ?? "",
        /No repair loops reconstructed from complete ledger events in this window\./,
      );
      assert.equal(await page.locator(".repair-table").count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
});
