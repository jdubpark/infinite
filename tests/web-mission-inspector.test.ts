import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import {
  CHILD_TEAM_1,
  DECISION_ID,
  ENTRY_IDS,
  GEN_1,
  GEN_2,
  INST_1,
  INST_2,
  makeProgressCursor,
  MISSION_ID,
} from "./fixtures/web-mission-inspector-data";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();
const skipBrowser = existsSync(executablePath) ? false : "Chromium for Playwright is not installed";
const harness = fileURLToPath(new URL("./fixtures/web-mission-inspector-harness.tsx", import.meta.url));
const ORIGIN = "http://127.0.0.1/mission-inspector";

type InspectorWindow = {
  __missionInspector: {
    requests: { path: string; body?: unknown }[];
    mutations: { path: string; body: Record<string, unknown> }[];
    openedTeams: string[];
    progressCursors: (string | null)[];
    setResyncStage: (stage: number) => void;
    advanceResyncStage: () => number;
  };
};

describe("web mission inspector Playwright E2E", { skip: skipBrowser }, () => {
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

  async function open(query = ""): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    await page.route(`${ORIGIN}*`, route =>
      route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div>' }),
    );
    await page.goto(`${ORIGIN}${query}#/missions/${MISSION_ID}`);
    await page.addStyleTag({ content: `html,body{margin:0;height:100%}${styles}` });
    await page.addScriptTag({ content: script });
    await page.waitForSelector(".mission-detail");
    return page;
  }

  test("renders pinned decisions, coordinator recorded vs worker status, and sends valid answer and steer payloads", async () => {
    const page = await open();
    try {
      await page.waitForSelector(".team-decisions");
      const overviewText = await page.locator(".mission-overview-grid").textContent();
      assert.match(overviewText ?? "", /0\/2 done/);
      assert.match(overviewText ?? "", /Recorded state: running/);
      assert.match(overviewText ?? "", /Live worker: unavailable/);

      const decisionText = await page.locator(".team-decisions").textContent();
      assert.match(decisionText ?? "", /Roll out strict cursor validation\?/);

      await page.getByRole("button", { name: "Approve, recommended" }).click();
      await page.waitForFunction(() => document.querySelectorAll(".team-decisions").length === 0);

      const steerInput = page.locator("#mission-steer-direction");
      await steerInput.fill("Hold release until integration checks confirm commit B.");
      await page.getByRole("button", { name: "Send direction" }).click();
      await page.waitForFunction(
        () => (document.querySelector(".team-detail-body")?.textContent ?? "").includes("Hold release until integration checks confirm commit B."),
      );

      const mutations = await page.evaluate(() => (window as unknown as InspectorWindow).__missionInspector.mutations);
      assert.equal(mutations.length, 2);
      assert.equal(mutations[0]!.path, `/missions/${MISSION_ID}/answer/${DECISION_ID}`);
      assert.match(String(mutations[0]!.body.requestId), /^[0-9a-f-]{36}$/);
      assert.equal(mutations[0]!.body.revision, 4);
      assert.equal(mutations[0]!.body.text, "Approve");

      assert.equal(mutations[1]!.path, `/missions/${MISSION_ID}/steer`);
      assert.match(String(mutations[1]!.body.requestId), /^[0-9a-f-]{36}$/);
      assert.equal(mutations[1]!.body.revision, 5);
      assert.equal(mutations[1]!.body.text, "Hold release until integration checks confirm commit B.");

      const bodyText = await page.locator(".team-detail-body").textContent();
      assert.match(bodyText ?? "", /Your answer:\s*Approve/);
      assert.match(bodyText ?? "", /Hold release until integration checks confirm commit B\./);
      assert.equal(await steerInput.inputValue(), "");
    } finally {
      await page.close();
    }
  });

  test("shows truthful host-restarted resync banner and preserves post-restart seq 2 and 3 observations", async () => {
    const page = await open("?scenario=resync");
    try {
      await page.waitForFunction(
        expected => (document.querySelector(".mission-cursor-line")?.textContent ?? "").includes(expected),
        makeProgressCursor(GEN_1, INST_1, 1),
      );
      assert.equal(await page.locator(".mission-resync-notice").count(), 0);

      await page.getByRole("button", { name: "Refresh mission" }).click();
      await page.waitForFunction(
        () => (document.querySelector(".mission-observation-list")?.textContent ?? "").includes("Progress sequence #3"),
      );
      assert.equal(await page.locator(".mission-resync-notice").count(), 0);

      await page.evaluate(() => (window as unknown as InspectorWindow).__missionInspector.setResyncStage(1));
      await page.getByRole("button", { name: "Refresh mission" }).click();
      await page.waitForSelector(".mission-resync-notice");
      const bannerText = await page.locator(".mission-resync-notice").textContent();
      assert.match(bannerText ?? "", /Progress resynced \(host-restarted\)/);
      assert.match(bannerText ?? "", /Host restarted since your last progress cursor/);

      await page.evaluate(() => (window as unknown as InspectorWindow).__missionInspector.setResyncStage(2));
      await page.getByRole("button", { name: "Refresh mission" }).click();
      await page.waitForFunction(() => {
        const text = document.querySelector(".mission-observation-list")?.textContent ?? "";
        return text.includes("Progress sequence #2") && text.includes("ready-for-review");
      });

      const obsText = await page.locator(".mission-observation-list").textContent();
      assert.match(obsText ?? "", /Progress sequence #3.*ready-for-review · revision 6/);
      assert.match(obsText ?? "", /Progress sequence #2.*working · revision 5/);

      const cursors = await page.evaluate(() => (window as unknown as InspectorWindow).__missionInspector.progressCursors);
      assert.ok(cursors.includes(null));
      assert.ok(cursors.includes(makeProgressCursor(GEN_1, INST_1, 1)));
      assert.ok(cursors.includes(makeProgressCursor(GEN_1, INST_1, 3)));
      assert.ok(cursors.includes(makeProgressCursor(GEN_2, INST_2, 1)));
    } finally {
      await page.close();
    }
  });

  test("compacts finished assignments, drills into child blackboard entries, opens team, handles not-created subtask, and satisfies 44px floor", async () => {
    const page = await open();
    try {
      await page.waitForSelector(".mission-assignment-list");

      const gridLayout = await page.evaluate(() => {
        const listRect = document.querySelector(".mission-subtask-list")!.getBoundingClientRect();
        const detailRect = document.querySelector(".mission-subtask-detail")!.getBoundingClientRect();
        return {
          listRight: Math.round(listRect.right),
          detailLeft: Math.round(detailRect.left),
          listTop: Math.round(listRect.top),
          detailTop: Math.round(detailRect.top),
        };
      });
      assert.ok(gridLayout.listRight <= gridLayout.detailLeft, `expected side-by-side desktop layout, got ${JSON.stringify(gridLayout)}`);
      assert.equal(gridLayout.listTop, gridLayout.detailTop);

      const activeText = await page.locator(".mission-assignment-list").first().textContent();
      assert.match(activeText ?? "", /Integrator · t-api/);
      assert.match(activeText ?? "", /Earlier attempt \(stopped · r1/);

      const finishedFold = page.locator(".mission-finished-fold", { hasText: "Finished (2)" });
      await finishedFold.waitFor();
      assert.equal(await finishedFold.evaluate(el => (el as HTMLDetailsElement).open), false);
      await finishedFold.locator("summary").click();
      assert.equal(await finishedFold.evaluate(el => (el as HTMLDetailsElement).open), true);
      const finishedText = await finishedFold.textContent();
      assert.match(finishedText ?? "", /Scout · t-discovery/);
      assert.match(finishedText ?? "", /Implementer · t-legacy/);

      await page.getByRole("tab", { name: "Blackboard entries" }).click();
      await page.waitForSelector(".mission-entry-row");

      const entriesText = await page.locator(".mission-entry-list").textContent();
      assert.match(entriesText ?? "", /blackboard #101/);
      assert.match(entriesText ?? "", /host receipt/);
      assert.match(entriesText ?? "", /blackboard #102/);
      assert.match(entriesText ?? "", /agent claim/);
      assert.match(entriesText ?? "", /blackboard #103/);
      assert.match(entriesText ?? "", /owner direction/);

      const layout = await page.evaluate(() => {
        const tabs = [...document.querySelectorAll(".mission-inspector-tabs button")].map(el => ({
          label: el.textContent?.trim() ?? "",
          top: Math.round(el.getBoundingClientRect().top),
          height: Math.round(el.getBoundingClientRect().height),
        }));
        const selects = [...document.querySelectorAll(".mission-entries-controls select")].map(el => ({
          height: Math.round(el.getBoundingClientRect().height),
        }));
        const interactive = [
          ...document.querySelectorAll(
            ".mission-inspector-tabs button, .mission-entries-controls select, .mission-subtask-row, .mission-entry-row, .team-decision-options button, .team-decision .primary, .team-composer-area .primary",
          ),
        ].map(el => ({
          cls: el.className || el.tagName,
          height: Math.round(el.getBoundingClientRect().height),
        }));
        return { tabs, selects, interactive };
      });

      assert.equal(layout.tabs.length, 2);
      assert.equal(layout.tabs[0]!.top, layout.tabs[1]!.top);
      assert.equal(layout.selects.length, 1);
      assert.ok(layout.interactive.every(item => item.height >= 44), `expected >= 44px controls, got ${JSON.stringify(layout)}`);

      await page.locator(".mission-entry-row", { hasText: "blackboard #102" }).click();
      await page.waitForSelector(".mission-entry-detail pre");
      const detailText = await page.locator(".mission-entry-detail").textContent();
      assert.match(detailText ?? "", /blackboard #102/);
      assert.match(detailText ?? "", /Updated generation check/);

      const requests = await page.evaluate(() => (window as unknown as InspectorWindow).__missionInspector.requests.map(r => r.path));
      assert.ok(requests.includes(`/teams/${CHILD_TEAM_1}/entries/${ENTRY_IDS.handoff}`));

      await page.locator(".mission-entries-controls select").selectOption("check");
      await page.waitForFunction(() => document.querySelectorAll(".mission-entry-row").length === 1);
      assert.match((await page.locator(".mission-entry-list").textContent()) ?? "", /blackboard #101/);

      await page.getByRole("button", { name: "Open team" }).click();
      const openedTeams = await page.evaluate(() => (window as unknown as InspectorWindow).__missionInspector.openedTeams);
      assert.deepEqual(openedTeams, [CHILD_TEAM_1]);

      await page.getByRole("option", { name: /Web inspector layout/ }).click();
      await page.waitForFunction(() =>
        (document.querySelector(".mission-subtask-detail")?.textContent ?? "").includes(
          "No subteam run has been created for this subtask yet.",
        ),
      );
      assert.equal(await page.getByRole("tab", { name: "Blackboard entries" }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Open team" }).count(), 0);
    } finally {
      await page.close();
    }
  });
});
