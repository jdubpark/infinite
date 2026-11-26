import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();
const skip = existsSync(executablePath) ? false : "Chromium for Playwright is not installed; run `npx playwright install chromium`";
const harness = fileURLToPath(new URL("./fixtures/mobile-permissions-harness.tsx", import.meta.url));
const standInPath = fileURLToPath(new URL("./fixtures/mobile-permissions-native.tsx", import.meta.url));
const ORIGIN = "http://127.0.0.1";

const standIns: Plugin = {
  name: "mobile-permissions-native",
  setup(builder) {
    builder.onResolve(
      { filter: /^(react-native|expo-router|\.\.\/\.\.\/api\/client|\.\.\/\.\.\/components\/(Button|Glass|Icon)|\.\.\/teams\/parts)$/ },
      () => ({ path: standInPath }),
    );
  },
};

type Decision = {
  id: string;
  at: string;
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  taskId: string;
  assignment: string;
  sessionId: string;
  provider: string;
  evidenceHash: string;
  action: { tool: string; summary: string };
  rules: string[];
  tiers: [];
  verdict: "allow" | "reject" | "owner";
  code?: string;
  raised: boolean;
  durationMs: number;
  deliveries: [];
  marks: [];
  controls: [];
};

const decision = (id: string, summary: string, verdict: Decision["verdict"] = "allow"): Decision => ({
  id,
  at: "2026-11-26T00:00:00.000Z",
  workspaceId: "ws-1",
  workspaceName: "Mobile workspace",
  projectId: "proj-1",
  taskId: "task-1",
  assignment: "assign-1",
  sessionId: "11111111-1111-4111-8111-111111111111",
  provider: "claude",
  evidenceHash: "hash-1",
  action: { tool: "bash", summary },
  rules: [],
  tiers: [],
  verdict,
  code: verdict === "reject" ? "unsafe" : undefined,
  raised: false,
  durationMs: 120,
  deliveries: [],
  marks: [],
  controls: [],
});

type LogReply = { status?: number; body: unknown };
type LogHandler = (url: URL) => Promise<LogReply> | LogReply;

describe("mobile permission log pagination errors", { skip }, () => {
  let browser: Browser;
  let script: string;

  before(async () => {
    script = (await build({
      entryPoints: [harness],
      bundle: true,
      write: false,
      format: "iife",
      jsx: "automatic",
      logLevel: "silent",
      plugins: [standIns],
      define: { "process.env.NODE_ENV": '"production"' },
    })).outputFiles[0].text;
    browser = await chromium.launch({ executablePath });
  });

  after(() => browser?.close());

  async function open(onLog: LogHandler): Promise<Page> {
    const page = await browser.newPage();
    await page.route(`${ORIGIN}/view`, route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
    await page.route(`${ORIGIN}/api/**`, async route => {
      const url = new URL(route.request().url());
      const reply = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }).catch(() => {});
      if (url.pathname === "/api/permissions/candidates") {
        return reply({ candidates: [] });
      }
      if (url.pathname === "/api/permissions/log") {
        const result = await onLog(url);
        return reply(result.body, result.status ?? 200);
      }
      return reply({ error: "Not found" }, 404);
    });
    await page.goto(`${ORIGIN}/view`);
    await page.addScriptTag({ content: script });
    return page;
  }

  test("surfaces an inline accessible error alert on pagination failure and clears it on retry recovery", async () => {
    let olderAttempts = 0;
    const page = await open(url => {
      const beforeCursor = url.searchParams.get("before");
      if (!beforeCursor) {
        return { body: { entries: [decision("m-11111111", "git status")], next: "cursor-1", rateFlags: [] } };
      }
      olderAttempts += 1;
      if (olderAttempts === 1) {
        return { status: 500, body: { error: "Host timed out" } };
      }
      return { body: { entries: [decision("m-22222222", "git diff")], rateFlags: [] } };
    });

    try {
      await page.getByText("git status").waitFor({ timeout: 4000 });
      const olderButton = page.getByRole("button", { name: "Show older decisions" });
      await olderButton.click();

      const alert = page.getByRole("alert");
      await alert.waitFor({ timeout: 4000 });
      assert.match(await alert.innerText(), /Could not load older decisions: Host timed out/);
      assert.equal(await olderButton.isEnabled(), true);

      await olderButton.click();
      await page.getByText("git diff").waitFor({ timeout: 4000 });
      assert.equal(await alert.count(), 0);
      assert.equal(await olderButton.count(), 0);
      assert.equal(olderAttempts, 2);
    } finally {
      await page.close();
    }
  });

  test("clears pagination errors on filter switch and guards against stale filter/epoch races", async () => {
    const held: { reject: () => void }[] = [];
    let holdAllOlder = false;
    let failAllOlderImmediately = true;

    const page = await open(async url => {
      const rejected = url.searchParams.get("rejected") === "1";
      const beforeCursor = url.searchParams.get("before");
      if (rejected) {
        if (!beforeCursor) {
          return { body: { entries: [decision("mr-11111111", "blocked deploy", "reject")], next: "cursor-r1", rateFlags: [] } };
        }
        return { body: { entries: [decision("mr-22222222", "older blocked deploy", "reject")], rateFlags: [] } };
      }
      if (!beforeCursor) {
        return { body: { entries: [decision("ma-11111111", "latest mobile check")], next: "cursor-a1", rateFlags: [] } };
      }
      if (failAllOlderImmediately) {
        return { status: 503, body: { error: "Network unreachable" } };
      }
      if (holdAllOlder) {
        return await new Promise<LogReply>(resolve => {
          held.push({ reject: () => resolve({ status: 500, body: { error: "Stale mobile error" } }) });
        });
      }
      return { body: { entries: [decision("ma-22222222", "older mobile check")], rateFlags: [] } };
    });

    try {
      await page.getByText("latest mobile check").waitFor({ timeout: 4000 });
      const olderButton = page.getByRole("button", { name: "Show older decisions" });
      await olderButton.click();
      await page.getByRole("alert").waitFor({ timeout: 4000 });

      await page.getByRole("button", { name: "Rejected" }).click();
      await page.getByText("blocked deploy").waitFor({ timeout: 4000 });
      assert.equal(await page.getByRole("alert").count(), 0);

      failAllOlderImmediately = false;
      holdAllOlder = true;
      await page.getByRole("button", { name: "All" }).click();
      await page.getByText("latest mobile check").waitFor({ timeout: 4000 });
      await olderButton.click();
      for (let waited = 0; held.length < 1 && waited < 2000; waited += 20) {
        await page.waitForTimeout(20);
      }
      assert.equal(held.length, 1);

      await page.getByRole("button", { name: "Rejected" }).click();
      await page.getByText("blocked deploy").waitFor({ timeout: 4000 });
      assert.equal(await olderButton.isEnabled(), true);
      held[0]!.reject();
      await page.waitForTimeout(100);
      assert.equal(await page.getByRole("alert").count(), 0);

      await page.getByRole("button", { name: "All" }).click();
      await page.getByText("latest mobile check").waitFor({ timeout: 4000 });
      await olderButton.click();
      for (let waited = 0; held.length < 2 && waited < 2000; waited += 20) {
        await page.waitForTimeout(20);
      }
      assert.equal(held.length, 2);

      await page.getByRole("button", { name: "Rejected" }).click();
      await page.getByText("blocked deploy").waitFor({ timeout: 4000 });
      await page.getByRole("button", { name: "All" }).click();
      await page.getByText("latest mobile check").waitFor({ timeout: 4000 });

      held[1]!.reject();
      await page.waitForTimeout(100);
      assert.equal(await page.getByRole("alert").count(), 0);
      assert.equal(await olderButton.isEnabled(), true);
    } finally {
      for (const item of held) item.reject();
      await page.close();
    }
  });
});
