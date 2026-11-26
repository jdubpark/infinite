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

test("TeamOverview renders criteria groups, separate provisional assessment, reviewer claims, and collapsed finished roster", () => {
  const noop = () => {};
  const html = renderToStaticMarkup(
    createElement(
      ApiContext.Provider,
      { value: (async () => ({})) as unknown as Api },
      createElement(TeamOverview, {
        team: fixtureTeam,
        sessions: fixtureSessions,
        onOpenSession: noop,
        onInspectMemberEntries: noop,
        onViewMemberLogs: noop,
      }),
    ),
  );
  assert.ok(html.includes("1 of 1 tasks integrated"));
  assert.ok(html.includes("Provisional assessment: Met"));
  assert.ok(html.includes("Reviewer acceptance claims"));
  assert.ok(html.includes("Verified (claim)"));
  assert.ok(html.includes("Finished (2)"));
  assert.ok(!html.includes("check failed on commit A"));
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

  async function open(hash = `#/teams/${TEAM_ID}`): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    await page.route(`${ORIGIN}*`, route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
    await page.goto(`${ORIGIN}${hash}`);
    await page.addStyleTag({ content: `html,body{margin:0;height:100%}${styles}` });
    await page.addScriptTag({ content: script });
    await page.waitForSelector(".team-detail-heading");
    return page;
  }

  test("repair trace shows pinned decisions, replacement links, commit hashes, supersedes, and session links", async () => {
    const page = await open();
    try {
      await page.waitForSelector(".team-decisions");
      const decisionText = await page.locator(".team-decisions").textContent();
      assert.match(decisionText ?? "", /Confirm release window\?/);

      await page.getByRole("button", { name: /Finished \(2\)/ }).click();
      await page.getByRole("button", { name: /Replacement/ }).click();
      assert.ok(await page.locator(`#ti-member-${fixtureTeam.members[1]!.memberId}.is-highlighted`).count() === 1);

      await page.getByRole("button", { name: "Board" }).click();
      await page.waitForSelector(".ti-entry-row");
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

  test("deep link #/teams/:id/entries/:entryId opens Board directly to that entry", async () => {
    const page = await open(`#/teams/${TEAM_ID}/entries/${ENTRY_IDS.checkPass}`);
    try {
      await page.waitForSelector(".ti-entry-detail");
      const boardPressed = await page.getByRole("button", { name: "Board" }).getAttribute("aria-pressed");
      assert.equal(boardPressed, "true");
      const detailText = await page.locator(".ti-entry-detail").textContent();
      assert.match(detailText ?? "", /seq 104/);
      assert.match(detailText ?? "", /PASS src\/gate\.test\.ts on commit B/);
    } finally {
      await page.close();
    }
  });
});
