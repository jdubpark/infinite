import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();
const skip = existsSync(executablePath) ? false : "Chromium for Playwright is not installed; run `npx playwright install chromium`";
const harness = fileURLToPath(new URL("./fixtures/web-polling-harness.tsx", import.meta.url));
const controlHarness = fileURLToPath(new URL("./fixtures/web-control-harness.tsx", import.meta.url));
const ORIGIN = "http://127.0.0.1/polling";
type ControlProbe = {
  ready: boolean; held: { id: string } | null; holdRenew: boolean; rejectRenew?: () => void;
  refuseClaims: boolean; leaseMs: number; claims: number; renewals: number; calls: { action?: string; leaseId?: string }[];
  hostHeld: { id: string; expiresAt: number } | null; releaseRequests: number; claim: () => void; teardown: () => void;
};

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
  async function holdRenewal(page: Page) {
    await page.waitForFunction(() => (window as unknown as { control: ControlProbe }).control.ready);
    await page.evaluate(() => (window as unknown as { control: ControlProbe }).control.claim());
    await page.getByRole("button", { name: "Stop controlling" }).waitFor({ timeout: 2000 });
    await page.evaluate(() => {
      const control = (window as unknown as { control: ControlProbe }).control;
      control.holdRenew = true;
      window.dispatchEvent(new Event("online"));
    });
    await page.waitForFunction(() => Boolean((window as unknown as { control: ControlProbe }).control.rejectRenew));
    await page.context().setOffline(true);
  }

  test("a hidden tab stops polling, and returning to it polls at once", async () => {
    const page = await open();
    try {
      await page.waitForFunction(() => (window as unknown as { polling: { requests: number } }).polling.requests >= 2, undefined, { timeout: 4000 });
      await setVisibility(page, "hidden");
      await page.waitForTimeout(100);
      const hidden = await requests(page);
      await page.waitForTimeout(3500);
      assert.equal(await requests(page), hidden);

      await setVisibility(page, "visible");
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
      await warning.waitFor({ timeout: 3000 });
    } finally {
      await page.close();
    }
  });

  test("a hidden tab releases control and does not reclaim it when visible again", async () => {
    const page = await load(controlScript);
    try {
      await page.waitForFunction(() => (window as unknown as { control: ControlProbe }).control.ready);
      await page.evaluate(() => (window as unknown as { control: ControlProbe }).control.claim());
      await page.getByRole("button", { name: "Stop controlling" }).waitFor({ timeout: 2000 });
      await setVisibility(page, "hidden");
      await page.waitForFunction(() => {
        const control = (window as unknown as { control: ControlProbe }).control;
        return control.releaseRequests === 1 && control.hostHeld === null;
      }, undefined, { timeout: 2000 });
      await page.getByRole("button", { name: "Take control" }).waitFor({ timeout: 2000 });
      await setVisibility(page, "visible");
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => (window as unknown as { control: ControlProbe }).control.renewals), 0);
      assert.equal(await page.evaluate(() => (window as unknown as { control: ControlProbe }).control.claims), 1);
    } finally {
      await page.close();
    }
  });

  test("a failed renewal during an offline gap reclaims control without a lease id", async () => {
    const page = await load(controlScript);
    try {
      await holdRenewal(page);
      await page.evaluate(() => (window as unknown as { control: ControlProbe }).control.rejectRenew?.());
      await page.context().setOffline(false);
      await page.waitForFunction(() => (window as unknown as { control: ControlProbe }).control.claims === 2, undefined, { timeout: 2000 });
      await page.getByRole("button", { name: "Stop controlling" }).waitFor({ timeout: 2000 });

      const claims = await page.evaluate(() => (window as unknown as { control: ControlProbe }).control.calls.filter(call => call.action === "claim"));
      assert.equal(claims.length, 2, "the page makes a second claim after reconnecting");
      assert.equal(claims[1].leaseId, undefined, "the reclaim uses the host's same-actor reconnect path");
    } finally {
      await page.close();
    }
  });

  test("going offline keeps control and sends no release", async () => {
    const page = await load(controlScript);
    try {
      await page.waitForFunction(() => (window as unknown as { control: ControlProbe }).control.ready);
      await page.evaluate(() => (window as unknown as { control: ControlProbe }).control.claim());
      await page.getByRole("button", { name: "Stop controlling" }).waitFor({ timeout: 2000 });
      await page.context().setOffline(true);
      assert.equal(await page.evaluate(() => navigator.onLine), false, "the browser delivered its offline state");
      await page.waitForTimeout(50);
      assert.equal(await page.getByRole("button", { name: "Stop controlling" }).count(), 1, "control stays held while offline");
      assert.equal(await page.evaluate(() => (window as unknown as { control: ControlProbe }).control.releaseRequests), 0,
        "the offline event does not release the host lease");

      await page.context().setOffline(false);
      await page.waitForFunction(() => (window as unknown as { control: ControlProbe }).control.renewals > 0, undefined, { timeout: 2000 });
      assert.equal(await page.getByRole("button", { name: "Stop controlling" }).count(), 1);
      assert.equal(await page.evaluate(() => (window as unknown as { control: ControlProbe }).control.releaseRequests), 0);
    } finally {
      await page.close();
    }
  });

  test("a refused reconnect returns to Monitoring and offers the current control action", async () => {
    const page = await load(controlScript);
    try {
      await holdRenewal(page);
      await page.evaluate(() => {
        const control = (window as unknown as { control: ControlProbe }).control;
        control.refuseClaims = true;
        control.rejectRenew?.();
      });
      await page.context().setOffline(false);
      await page.getByRole("button", { name: /^Take (control|over)$/ }).waitFor({ timeout: 2000 });
      await page.getByText("Monitoring", { exact: true }).waitFor({ timeout: 2000 });

      const claims = await page.evaluate(() => (window as unknown as { control: ControlProbe }).control.calls.filter(call => call.action === "claim"));
      assert.equal(claims.length, 2, "the page attempts one reconnect claim");
      assert.equal(claims[1].leaseId, undefined, "the refused reclaim also uses no lease id");
    } finally {
      await page.close();
    }
  });

  test("control given up offline is released when the page becomes reachable", async () => {
    const page = await load(controlScript);
    try {
      await page.waitForFunction(() => (window as unknown as { control: ControlProbe }).control.ready);
      await page.evaluate(() => (window as unknown as { control: ControlProbe }).control.claim());
      await page.getByRole("button", { name: "Stop controlling" }).waitFor({ timeout: 2000 });
      await page.context().setOffline(true);
      await page.evaluate(() => (window as unknown as { control: ControlProbe }).control.teardown());
      await page.waitForFunction(() => (window as unknown as { control: ControlProbe }).control.releaseRequests === 1);
      await page.context().setOffline(false);
      await page.waitForFunction(() => {
        const control = (window as unknown as { control: ControlProbe }).control;
        return control.releaseRequests === 2 && control.hostHeld === null;
      }, undefined, { timeout: 2000 });
    } finally {
      await page.close();
    }
  });

  test("a release given up offline stops retrying once its lease has expired", async () => {
    const page = await load(controlScript);
    try {
      await page.waitForFunction(() => (window as unknown as { control: ControlProbe }).control.ready);
      await page.evaluate(() => {
        const control = (window as unknown as { control: ControlProbe }).control;
        control.leaseMs = 1500;
        control.claim();
      });
      await page.getByRole("button", { name: "Stop controlling" }).waitFor({ timeout: 2000 });
      await page.context().setOffline(true);
      await page.evaluate(() => (window as unknown as { control: ControlProbe }).control.teardown());
      await page.waitForFunction(() => (window as unknown as { control: ControlProbe }).control.releaseRequests === 1);
      await page.waitForFunction(() => {
        const held = (window as unknown as { control: ControlProbe }).control.hostHeld;
        return held !== null && Date.now() > held.expiresAt;
      }, undefined, { timeout: 4000 });
      await page.context().setOffline(false);
      await page.waitForTimeout(1500);
      assert.equal(await page.evaluate(() => (window as unknown as { control: ControlProbe }).control.releaseRequests), 1);
    } finally {
      await page.close();
    }
  });
});
