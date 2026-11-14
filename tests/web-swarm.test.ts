import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";

// Runs the web client's Swarm view in Chromium on a stand-in host: one mission with three subteams in two projects,
// two standalone teams, quiet runs, and two solo sessions.
// PLAYWRIGHT_CHROMIUM_PATH selects a Chromium build other than the one `npx playwright install chromium` provides.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();
const skip = existsSync(executablePath) ? false : "Chromium for Playwright is not installed; run `npx playwright install chromium`";
const harness = fileURLToPath(new URL("./fixtures/web-swarm-harness.tsx", import.meta.url));
const ORIGIN = "http://127.0.0.1/swarm";

type Control = { requests: string[]; view(view: "lanes" | "wall" | "graph"): void; poll(variant: { shuffleUpdated?: boolean; flipState?: boolean; idle?: boolean }): void };
// Page-side code reaches the harness through `window.swarm`; functions passed to the page cannot close over test helpers.

describe("web swarm view", { skip }, () => {
  let browser: Browser;
  let script = "", styles = "";
  before(async () => {
    const bundle = await build({ entryPoints: [harness], bundle: true, write: false, outdir: "out", format: "iife", jsx: "automatic", logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' } });
    script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
    styles = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
    browser = await chromium.launch({ executablePath });
  });
  after(() => browser?.close());

  async function open(context: "on" | "off" = "on"): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route(`${ORIGIN}*`, route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
    await page.goto(`${ORIGIN}?context=${context}`);
    await page.addStyleTag({ content: `html,body{margin:0;height:100%}${styles}` });
    await page.addScriptTag({ content: script });
    await page.waitForSelector("[data-unit]");
    return page;
  }
  const show = async (page: Page, view: "lanes" | "wall" | "graph", selector: string) => {
    await page.evaluate(name => (window as unknown as { swarm: Control }).swarm.view(name), view);
    await page.waitForSelector(selector);
  };
  const count = (page: Page, selector: string) => page.evaluate(query => document.querySelectorAll(query).length, selector);
  const requests = (page: Page) => page.evaluate(() => (window as unknown as { swarm: Control }).swarm.requests.slice());
  const setVisibility = (page: Page, state: "hidden" | "visible") => page.evaluate(state => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);

  test("the three views draw the same agents from one model", async () => {
    const page = await open();
    try {
      // Five live units: two standalone teams and the mission's three subteams. Quiet runs collapse and carry no agent marks.
      assert.equal(await count(page, ".sw-lane-row[data-unit]"), 5);
      const marks = await count(page, "[data-agent]");
      assert.ok(marks >= 25, `expected the fixture's live agents, saw ${marks}`);
      // Every run in the fixture carries a fresh updatedAt, as on a real host: a quiet row ages by its agents' last activity.
      const ages = await page.evaluate(() => [...document.querySelectorAll(".sw-quiet .sw-quiet-row .sw-quiet-cell .sw-dim")].map(node => node.textContent));
      assert.deepEqual(ages, ["5h", "1d"]);
      assert.equal(await page.evaluate(() => document.querySelector(".sw-quiet .sw-older")?.textContent), "+1 older");

      await show(page, "wall", ".sw-tile");
      assert.equal(await count(page, ".sw-tile"), marks);

      await show(page, "graph", '[data-node^="area:"]');
      assert.equal(await count(page, '[data-node^="agent:"]'), marks);
      // Links are paths; the legend's samples are lines.
      assert.ok(await count(page, "path.sw-g-read") > 0, "observed reads are drawn");
      assert.ok(await count(page, "path.sw-g-integrated") > 0, "integrated changes are drawn");
      assert.ok(await count(page, "path.sw-g-code") > 0, "code links are drawn");
      const sent = await requests(page);
      assert.ok(sent.some(path => path === "/projects/shop-api/graph/map"));
      assert.ok(sent.some(path => /^\/teams\/[0-9a-f-]+\/context$/.test(path)));
      assert.ok(sent.every(path => !path.includes("?")), "requests carry no query the host would not expect");
    } finally { await page.close(); }
  });

  test("an idle host says so in every view and flags no code graph", async () => {
    const page = await open();
    try {
      await page.evaluate(() => (window as unknown as { swarm: Control }).swarm.poll({ idle: true }));
      // The missions feed empties on its own poll, a moment after the sessions and teams.
      await page.waitForSelector(".sw-lanes .sw-none-live");
      assert.equal(await count(page, "[data-agent]"), 0);
      assert.equal(await count(page, ".sw-quiet .sw-quiet-row"), 2, "settled runs stay listed under the line");

      await show(page, "wall", ".sw-wall .sw-none-live");
      await show(page, "graph", ".sw-graph-empty");
      assert.equal(await count(page, ".sw-graph-flag"), 0, "with no project drawn the legend flags nothing");
    } finally { await page.close(); }
  });

  test("the inspector ends a long fact in an ellipsis and keeps short facts whole", async () => {
    const page = await open();
    try {
      await show(page, "wall", ".sw-tile");
      // A narrow window leaves the inspector too little room for every fact.
      await page.setViewportSize({ width: 1120, height: 800 });
      await page.click(".sw-tile:has(.sw-mark-reported)");
      await page.waitForSelector(".sw-inspector .sw-inspector-fact");
      const facts = await page.evaluate(() => {
        const inspector = document.querySelector(".sw-inspector")!.getBoundingClientRect();
        return [...document.querySelectorAll(".sw-inspector .sw-inspector-fact")].map(node => ({
          fixed: node.classList.contains("sw-fixed"), display: getComputedStyle(node).display, overflow: getComputedStyle(node).textOverflow,
          cut: node.scrollWidth > node.clientWidth + 1, inside: node.getBoundingClientRect().right <= inspector.right + 1,
        }));
      });
      const short = facts.filter(fact => fact.fixed), long = facts.filter(fact => !fact.fixed);
      assert.ok(short.length >= 2 && long.length >= 1, "the role and model are short facts; the state is a long one");
      assert.ok(short.every(fact => !fact.cut && fact.inside), "a short fact is never cut");
      // Only a block box draws the ellipsis; a flex box cuts its text mid-word.
      assert.ok(long.every(fact => fact.display === "block" && fact.overflow === "ellipsis"), "a long fact ends in an ellipsis");
      const links = await page.evaluate(() => {
        const inspector = document.querySelector(".sw-inspector")!.getBoundingClientRect();
        return [...document.querySelectorAll(".sw-inspector-links button")].every(button => button.getBoundingClientRect().right <= inspector.right + 1);
      });
      assert.ok(links, "the links to the session and team stay inside the inspector");
    } finally { await page.close(); }
  });

  test("rows keep their order when a poll changes only updatedAt", async () => {
    const page = await open();
    try {
      const order = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".sw-lane-row[data-unit]")].map(row => row.dataset.unit));
      const before = await order();
      await page.evaluate(() => (window as unknown as { swarm: Control }).swarm.poll({ shuffleUpdated: true }));
      await page.waitForTimeout(300);
      assert.deepEqual(await order(), before);
    } finally { await page.close(); }
  });

  test("a state change recolours a graph node without moving any", async () => {
    const page = await open();
    try {
      await show(page, "graph", '[data-node^="area:"]');
      const positions = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-node]')].map(node => [node.getAttribute("data-node"), node.getAttribute("transform")])));
      const waiting = () => count(page, '[data-node^="agent:"] .sw-mark-waiting');
      const before = await positions(), waitingBefore = await waiting();
      await page.evaluate(() => (window as unknown as { swarm: Control }).swarm.poll({ flipState: true }));
      await page.waitForFunction(previous => document.querySelectorAll('[data-node^="agent:"] .sw-mark-waiting').length === previous + 1, waitingBefore);
      assert.deepEqual(await positions(), before);
    } finally { await page.close(); }
  });

  test("a host that predates the context endpoints still draws the graph, without a code map", async () => {
    const page = await open("off");
    try {
      await show(page, "graph", '[data-node^="agent:"]');
      await page.waitForTimeout(400);
      assert.ok(await count(page, '[data-node^="area:"]') > 0, "planned and integrated paths still give areas");
      assert.equal(await count(page, "path.sw-g-read"), 0);
      assert.equal(await count(page, "path.sw-g-code"), 0);
      assert.ok(await count(page, "path.sw-g-integrated") > 0);
      assert.ok((await page.textContent(".sw-graph-legend"))?.includes("code graph off"));
      assert.ok((await requests(page)).every(path => !path.includes("/context") && !path.includes("/graph/map")));
    } finally { await page.close(); }
  });

  test("one failing context request leaves the rest drawn and shows as stale until it recovers", { timeout: 40000 }, async () => {
    const page = await open();
    try {
      await show(page, "graph", '[data-node^="area:"]');
      const reads = await count(page, "path.sw-g-read");
      const legend = () => page.textContent(".sw-graph-legend");
      assert.ok(!(await legend())?.includes("context stale"));
      // The first team's context starts failing; every other request keeps answering.
      await page.evaluate(() => {
        const swarm = (window as unknown as { swarm: Control & { failing: RegExp | null } }).swarm;
        const team = swarm.requests.find(path => /^\/teams\/[0-9a-f-]+\/context$/.test(path))!;
        swarm.failing = new RegExp(`^${team}$`);
      });
      await page.waitForFunction(() => document.querySelector(".sw-graph-legend")?.textContent?.includes("context stale"), undefined, { timeout: 12000 });
      assert.equal(await count(page, "path.sw-g-read"), reads, "the last received context stays drawn");
      await page.evaluate(() => { (window as unknown as { swarm: { failing: RegExp | null } }).swarm.failing = null; });
      await page.waitForFunction(() => !document.querySelector(".sw-graph-legend")?.textContent?.includes("context stale"), undefined, { timeout: 12000 });
    } finally { await page.close(); }
  });

  test("a hidden tab sends no swarm requests", async () => {
    const page = await open();
    try {
      await show(page, "graph", '[data-node^="area:"]');
      await page.waitForFunction(() => (window as unknown as { swarm: Control }).swarm.requests.filter(path => path === "/missions").length >= 2, undefined, { timeout: 6000 });
      await setVisibility(page, "hidden");
      await page.waitForTimeout(150);
      const hidden = (await requests(page)).length;
      await page.waitForTimeout(5600);
      assert.equal((await requests(page)).length, hidden);
      await setVisibility(page, "visible");
      await page.waitForFunction(seen => (window as unknown as { swarm: Control }).swarm.requests.length > seen, hidden, { timeout: 1500 });
    } finally { await page.close(); }
  });
});
