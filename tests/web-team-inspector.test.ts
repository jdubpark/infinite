import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { ApiContext, type Api } from "../apps/web/src/api";
import { TeamOverview } from "../apps/web/src/team-inspector/TeamOverview";
import {
  COMMIT_A,
  COMMIT_B,
  ENTRY_IDS,
  SESSION_IDS,
  TEAM_ID,
  fixtureSessions,
  fixtureTeam,
} from "./fixtures/web-team-inspector-data";

(globalThis as { React?: unknown }).React = React;

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();
const skipBrowser = existsSync(executablePath) ? false : "Chromium for Playwright is not installed";
const harness = fileURLToPath(new URL("./fixtures/web-team-inspector-harness.tsx", import.meta.url));
const ORIGIN = "http://127.0.0.1/team-inspector";

test("TeamOverview renders criteria groups, separate provisional assessment, reviewer claims, unassigned tasks, and collapsed finished roster", () => {
  const noop = () => {};
  const teamWithOther = {
    ...fixtureTeam,
    tasks: [
      ...fixtureTeam.tasks,
      {
        id: "task-extra",
        title: "Extra unpinned work",
        instructions: "Extra",
        paths: ["src/extra.ts"],
        dependsOn: [],
        status: "running" as const,
      },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(
      ApiContext.Provider,
      { value: (async () => ({})) as unknown as Api },
      createElement(TeamOverview, {
        team: teamWithOther,
        sessions: fixtureSessions,
        onOpenSession: noop,
        onInspectMemberEntries: noop,
        onViewMemberLogs: noop,
      }),
    ),
  );
  assert.ok(html.includes("1 of 1 tasks integrated"));
  assert.ok(html.includes("Other tasks"));
  assert.ok(html.includes("0 of 1 tasks integrated"));
  assert.ok(html.includes("Provisional assessment: Met"));
  assert.ok(html.includes("Reviewer acceptance claims"));
  assert.ok(html.includes("Verified (claim)"));
  assert.ok(html.includes("Finished (2)"));
  assert.ok(html.includes("Why this run is waiting"));
  assert.ok(html.includes("Spinner-only screen"));
  assert.ok(html.includes("Spinner-only screen since"));
  assert.ok(!html.includes("check failed on commit A"));
});

test("TeamOverview tolerates unparseable and blank wait timestamps without throwing", () => {
  const noop = () => {};
  const badTimestampsTeam = {
    ...fixtureTeam,
    members: [
      {
        ...fixtureTeam.members[1]!,
        stalledAt: "not-iso",
        spinnerOnlySince: "   ",
      },
    ],
    waitReasons: [
      {
        kind: "provider-limit" as const,
        since: "   ",
        resetsAt: "next Tuesday",
        summary: "Provider limit active.",
      },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(
      ApiContext.Provider,
      { value: (async () => ({})) as unknown as Api },
      createElement(TeamOverview, {
        team: badTimestampsTeam,
        sessions: fixtureSessions,
        onOpenSession: noop,
        onInspectMemberEntries: noop,
        onViewMemberLogs: noop,
      }),
    ),
  );
  assert.ok(html.includes("Stalled since not-iso"));
  assert.ok(!html.includes("Spinner-only screen since"));
  assert.ok(html.includes("resets next Tuesday"));
  assert.ok(!html.includes("since    "));
});

describe("web team inspector repair trace", { skip: skipBrowser }, () => {
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

  async function open(hash = `#/teams/${TEAM_ID}`, query = ""): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    await page.route(`${ORIGIN}*`, route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
    await page.goto(`${ORIGIN}${query}${hash}`);
    await page.addStyleTag({ content: `html,body{margin:0;height:100%}${styles}` });
    await page.addScriptTag({ content: script });
    await page.waitForSelector(".team-detail-heading");
    return page;
  }

  test("repair trace shows pinned decisions, replacement links, toolbar layout, 44px controls, commit hashes, supersedes, and session links", async () => {
    const page = await open();
    try {
      await page.waitForSelector(".team-decisions");
      const decisionText = await page.locator(".team-decisions").textContent();
      assert.match(decisionText ?? "", /Confirm release window\?/);

      await page.waitForSelector(".ti-wait-reasons");
      const waitText = await page.locator(".ti-wait-reasons").textContent();
      assert.match(waitText ?? "", /Why this run is waiting/);
      assert.match(waitText ?? "", /Spinner-only screen/);
      assert.match(waitText ?? "", /Repair attempt is showing spinner or status redraws/);
      assert.ok((waitText ?? "").indexOf("Spinner-only screen") < (waitText ?? "").indexOf("Worker slot"));

      const activeMemberText = await page.locator(`#ti-member-${fixtureTeam.members[1]!.memberId}`).textContent();
      assert.match(activeMemberText ?? "", /Spinner-only screen since/);

      const waitBtnHeights = await page.evaluate(() =>
        [...document.querySelectorAll(".ti-wait-reasons .ti-link-btn")].map(el => Math.round(el.getBoundingClientRect().height)),
      );
      assert.ok(waitBtnHeights.length >= 2 && waitBtnHeights.every(h => h >= 44), `expected >= 44px wait action buttons, got ${JSON.stringify(waitBtnHeights)}`);

      await page.getByRole("button", { name: /Finished \(2\)/ }).click();
      await page.getByRole("button", { name: /Replacement/ }).click();
      assert.ok(await page.locator(`#ti-member-${fixtureTeam.members[1]!.memberId}.is-highlighted`).count() === 1);

      await page.locator(".ti-wait-reasons").getByRole("button", { name: "Logs" }).click();
      await page.waitForSelector(".team-logs");
      const logsText = await page.locator(".team-logs").textContent();
      assert.match(logsText ?? "", /Integrator/);
      assert.match(logsText ?? "", /Repair attempt/);

      await page.getByRole("button", { name: "Board" }).click();
      await page.waitForSelector(".ti-entry-row");

      const layout = await page.evaluate(() => {
        const toolbar = document.querySelector(".ti-board-toolbar")!.getBoundingClientRect();
        const selects = [...document.querySelectorAll(".ti-board-toolbar select")].map(el => el.getBoundingClientRect());
        const controls = [
          ...document.querySelectorAll(".ti-finished-toggle, .ti-follow-btn, .ti-board-toolbar select, .ti-board-toolbar input, .ti-link-btn"),
        ].map(el => ({ tag: el.tagName, height: Math.round(el.getBoundingClientRect().height) }));
        return {
          toolbarWidth: Math.round(toolbar.width),
          selects: selects.map(r => ({ width: Math.round(r.width), top: Math.round(r.top) })),
          controls,
        };
      });
      assert.equal(layout.selects.length, 4);
      assert.ok(layout.selects.every(s => s.width < layout.toolbarWidth * 0.5), `expected side-by-side selects, got ${JSON.stringify(layout)}`);
      assert.ok(layout.controls.every(c => c.height >= 44), `expected >= 44px controls, got ${JSON.stringify(layout.controls)}`);

      const listText = await page.locator(".ti-entry-list").textContent();
      assert.match(listText ?? "", /seq 101/);
      assert.match(listText ?? "", /Host receipt/);
      assert.match(listText ?? "", /Agent claim/);
      assert.match(listText ?? "", /Owner direction/);
      assert.match(listText ?? "", new RegExp(COMMIT_A.slice(0, 7)));
      assert.match(listText ?? "", new RegExp(COMMIT_B.slice(0, 7)));

      await page.locator(".ti-entry-row", { hasText: "seq 101" }).click();
      await page.waitForSelector(".ti-entry-detail");
      let detailText = await page.locator(".ti-entry-detail").textContent();
      assert.match(detailText ?? "", new RegExp(COMMIT_A));
      assert.match(detailText ?? "", /FAIL src\/gate\.test\.ts on commit A/);

      await page.locator(".ti-entry-row", { hasText: "seq 106" }).click();
      await page.getByRole("button", { name: /Supersedes seq 105/ }).waitFor();
      detailText = await page.locator(".ti-entry-detail").textContent();
      assert.match(detailText ?? "", /approved/);
      assert.match(detailText ?? "", /Verified trace link in web UI/);

      await page.getByRole("button", { name: /Open session/ }).click();
      const opened = await page.evaluate(() => (window as unknown as { inspector: { openedSessions: string[] } }).inspector.openedSessions);
      assert.deepEqual(opened, [SESSION_IDS.reviewer]);

      await page.getByRole("button", { name: /Supersedes seq 105/ }).click();
      detailText = await page.locator(".ti-entry-detail").textContent();
      assert.match(detailText ?? "", /seq 105/);
      assert.match(detailText ?? "", /changes-requested/);
    } finally {
      await page.close();
    }
  });

  test("deep link #/teams/:id/entries/:entryId opens Board directly, survives follow, and clears on hashchange back to team", async () => {
    const page = await open(`#/teams/${TEAM_ID}/entries/${ENTRY_IDS.checkPass}`);
    try {
      await page.waitForSelector(".ti-entry-detail");
      const boardPressed = await page.getByRole("button", { name: "Board" }).getAttribute("aria-pressed");
      assert.equal(boardPressed, "true");
      let detailText = await page.locator(".ti-entry-detail").textContent();
      assert.match(detailText ?? "", /seq 104/);
      assert.match(detailText ?? "", /PASS src\/gate\.test\.ts on commit B/);

      await page.evaluate(hash => { window.location.hash = hash; }, `#/teams/${TEAM_ID}/entries/${ENTRY_IDS.checkFail}`);
      await page.waitForFunction(() => (document.querySelector(".ti-entry-detail")?.textContent ?? "").includes("seq 101"));
      detailText = await page.locator(".ti-entry-detail").textContent();
      assert.match(detailText ?? "", /seq 101/);

      await page.evaluate(hash => { window.location.hash = hash; }, `#/teams/${TEAM_ID}`);
      await page.waitForFunction(() => (document.querySelector(".ti-entry-detail")?.textContent ?? "").includes("Select an entry"));
    } finally {
      await page.close();
    }
  });

  test("pagination Load more advances cursor and subsequent polls use since=55 without regressing", async () => {
    const firstEntry = "99999999-9999-4999-8999-000000000001";
    const page = await open(`#/teams/${TEAM_ID}/entries/${firstEntry}`, "?paged=1");
    try {
      const loadMoreBtn = page.getByRole("button", { name: "Load more" });
      await loadMoreBtn.waitFor();
      await loadMoreBtn.click();
      await page.waitForFunction(() => document.querySelectorAll(".ti-entry-row").length === 55);
      assert.equal(await loadMoreBtn.count(), 0);

      await page.waitForTimeout(2300);
      const requests = await page.evaluate(() => (window as unknown as { inspector: { requests: string[] } }).inspector.requests.slice());
      const entryPolls = requests.filter(path => path.includes("/entries?"));
      assert.ok(entryPolls.some(path => path.includes("since=55")), `expected incremental poll since=55, got ${JSON.stringify(entryPolls)}`);
      assert.equal(await loadMoreBtn.count(), 0);
    } finally {
      await page.close();
    }
  });
});
