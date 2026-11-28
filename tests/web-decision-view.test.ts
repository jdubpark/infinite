import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();
const harness = fileURLToPath(new URL("./fixtures/web-decision-view-harness.tsx", import.meta.url));
const ORIGIN = "http://127.0.0.1";
const TEAM = "22222222-2222-4222-8222-222222222222", SESSION = "11111111-1111-4111-8111-111111111111";
const since = "2026-11-21T12:00:00.000Z";

type Sent = { path: string; body: Record<string, unknown> };
type Decision = { answerPath: string };
type Host = { decisions: Decision[]; sent: Sent[]; queueStatus: number; hold?: Promise<void>; release?: () => void };
const hostWith = (...decisions: Decision[]): Host => ({ decisions, sent: [], queueStatus: 200 });

const teamDecision = (id: string) => ({
  kind: "team", key: `team:${TEAM}:${id}`, since, origin: { id: TEAM, title: "Upload reliability" },
  answerPath: `/api/teams/${TEAM}/decisions/${id}/answer`, revision: 3,
  decision: { id, question: `Which limit for ${id}?`, options: ["3 attempts", "5 attempts"], answerMode: "single", createdAt: since },
});
const destructivePrompt = {
  kind: "session", key: `session:${SESSION}:7`, since, origin: { id: SESSION, title: "Fix the upload test" }, answerPath: `/api/sessions/${SESSION}/answer`,
  prompt: {
    id: 7, kind: "permission", title: "Bash command", detail: "rm -rf build/", destructive: { pattern: "recursive-force-remove" },
    options: [{ index: 0, label: "Yes", role: "accept" }, { index: 1, label: "No, and say what to do", role: "reject-with-feedback" }],
    highlighted: 0, acceptsText: false, source: "screen", hash: "a1b2c3", pinned: true,
  },
};
const sessionRow = { id: SESSION, title: "Fix the upload test", provider: "claude", projectId: "demo", status: "running", createdAt: since, seq: 1, contextVersion: 1, backend: "infinite", capabilities: { terminalSnapshot: 1 } };

describe("web decision queue view", () => {
  let browser: Browser;
  let script: string;
  before(async () => {
    script = (await build({ entryPoints: [harness], bundle: true, write: false, format: "iife", jsx: "automatic", logLevel: "silent",
      loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' } })).outputFiles[0].text;
    browser = await chromium.launch({ executablePath });
  });
  after(() => browser?.close());

  async function open(host: Host, settings: { role?: string; interval?: number } = {}): Promise<Page> {
    const page = await browser.newPage();
    await page.route(`${ORIGIN}/view`, route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
    await page.route(`${ORIGIN}/api/**`, async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }).catch(() => {});
      if (request.method() !== "GET") {
        host.sent.push({ path, body: request.postDataJSON() as Record<string, unknown> });
        host.decisions = host.decisions.filter(decision => decision.answerPath !== path);
        return reply(path.startsWith("/api/sessions/") ? { state: "delivered", result: "closed" } : { revision: 4 });
      }
      if (path === "/api/decision-queue") {
        if (host.hold) await host.hold;
        return host.queueStatus === 200 ? reply({ decisions: host.decisions }) : reply({ error: "Not found" }, host.queueStatus);
      }
      if (path === `/api/sessions/${SESSION}`) return reply(sessionRow);
      return reply({ error: "Not found" }, 404);
    });
    await page.goto(`${ORIGIN}/view`);
    await page.evaluate(value => { Object.assign(window, { decisionView: value }); }, settings);
    await page.addScriptTag({ content: script });
    return page;
  }
  const settle = (page: Page) => page.waitForTimeout(700);
  const setVisibility = (page: Page, state: "hidden" | "visible") => page.evaluate(state => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
  async function sentOnce(host: Host): Promise<Sent> {
    for (let waited = 0; host.sent.length === 0 && waited < 4000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(host.sent.length, 1, "the view sends one request");
    return host.sent[0];
  }

  test("a key selects and sends nothing; Enter sends the selection once", async () => {
    const host = hostWith(teamDecision("d1"), teamDecision("d2"));
    const page = await open(host);
    try {
      await page.getByText("Which limit for d1?").waitFor({ timeout: 4000 });
      await page.keyboard.press("Enter");
      await page.keyboard.press("1");
      await page.getByRole("button", { name: "3 attempts", pressed: true }).waitFor({ timeout: 2000 });
      await settle(page);
      assert.deepEqual(host.sent, [], "Enter without a selection and the selection itself send nothing");

      await page.keyboard.press("Enter");
      const sent = await sentOnce(host);
      await page.getByText("Which limit for d2?").waitFor({ timeout: 4000 });
      await settle(page);
      assert.equal(host.sent.length, 1, "the answer is sent once, and the next decision gets none");
      assert.equal(sent.path, `/api/teams/${TEAM}/decisions/d1/answer`);
      const { requestId, ...body } = sent.body;
      assert.match(String(requestId), /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
      assert.deepEqual(body, { revision: 3, text: "3 attempts" });
    } finally {
      await page.close();
    }
  });

  test("a queue read that does not come back turns answers off until one does", async () => {
    const host = hostWith(teamDecision("d1"));
    const page = await open(host, { interval: 200 });
    try {
      const submit = page.getByRole("button", { name: "Submit selected answer" });
      await page.getByRole("button", { name: "3 attempts" }).click();
      assert.equal(await submit.isEnabled(), true, "a current queue takes the selected answer");

      host.hold = new Promise(resolve => { host.release = resolve; });
      await page.getByText(/has not refreshed since/).waitFor({ timeout: 6000 });
      assert.equal(await submit.isDisabled(), true);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("Enter");
      await settle(page);
      assert.deepEqual(host.sent, [], "a queue that is not current sends nothing");

      host.hold = undefined;
      host.release?.();
      await page.getByText(/has not refreshed since/).waitFor({ state: "detached", timeout: 4000 });
      assert.equal(await submit.isEnabled(), true, "the selection is kept and can be sent once the queue is current");
      await submit.click();
      assert.equal((await sentOnce(host)).body.text, "3 attempts");
    } finally {
      host.release?.();
      await page.close();
    }
  });

  test("hiding the tab drops the warning; returning takes no answers until a read lands and warns again after three seconds", async () => {
    const host = hostWith(teamDecision("d1"));
    const page = await open(host, { interval: 200 });
    const notice = page.getByText(/has not refreshed since/);
    try {
      const submit = page.getByRole("button", { name: "Submit selected answer" });
      await page.getByRole("button", { name: "3 attempts" }).click();
      host.hold = new Promise(resolve => { host.release = resolve; });
      await notice.waitFor({ timeout: 6000 });

      await setVisibility(page, "hidden");
      await notice.waitFor({ state: "detached", timeout: 1000 });
      await page.waitForTimeout(3600);
      assert.equal(await notice.count(), 0, "time in a hidden tab counts toward no warning");

      await setVisibility(page, "visible");
      await page.waitForTimeout(1500);
      assert.equal(await notice.count(), 0, "returning gives the next read its own three seconds");
      assert.equal(await submit.isDisabled(), true, "and takes no answers until a read lands");
      await notice.waitFor({ timeout: 3000 });

      host.hold = undefined;
      host.release?.();
      await notice.waitFor({ state: "detached", timeout: 4000 });
      assert.equal(await submit.isEnabled(), true, "a read that lands turns answers back on");
    } finally {
      host.release?.();
      await page.close();
    }
  });

  test("a destructive prompt takes an accepting option from a click, not from a key", async () => {
    const host = hostWith(destructivePrompt);
    const page = await open(host);
    try {
      const yes = page.getByRole("button", { name: "Yes", exact: true });
      await page.getByText("No control is needed to answer.").waitFor({ timeout: 4000 });
      await page.keyboard.press("1");
      await page.keyboard.press("Enter");
      await settle(page);
      assert.equal(await yes.getAttribute("aria-pressed"), "false", "the key does not select the accepting option");
      assert.deepEqual(host.sent, []);

      await yes.click();
      await settle(page);
      assert.equal(await yes.getAttribute("aria-pressed"), "true");
      assert.deepEqual(host.sent, [], "a click selects and sends nothing");
      await page.getByRole("button", { name: "Submit selected answer" }).click();
      const sent = await sentOnce(host);
      assert.equal(sent.path, `/api/sessions/${SESSION}/answer`);
      const { requestId, ...body } = sent.body;
      assert.equal(typeof requestId, "string");
      assert.deepEqual(body, { promptId: 7, option: 0 });
    } finally {
      await page.close();
    }
  });

  test("a decision that leaves the queue is reported as gone, not as answered", async () => {
    const host = hostWith(teamDecision("d1"), teamDecision("d2"));
    const page = await open(host);
    try {
      await page.getByText("Which limit for d1?").waitFor({ timeout: 4000 });
      host.decisions = host.decisions.slice(1);
      await page.getByText("Which limit for d2?").waitFor({ timeout: 4000 });
      await page.getByText("The decision shown before is no longer in the queue.").waitFor({ timeout: 2000 });
      assert.equal(await page.getByText(/answered/i).count(), 0, "the queue says a decision left, not why");
      assert.deepEqual(host.sent, []);
    } finally {
      await page.close();
    }
  });

  test("a host without the queue route gets one line and nothing to retry", async () => {
    const host = hostWith();
    host.queueStatus = 404;
    const page = await open(host);
    try {
      await page.getByText("The decision queue is not available on this host.").waitFor({ timeout: 4000 });
      assert.equal(await page.getByRole("button").count(), 0);
    } finally {
      await page.close();
    }
  });

  test("a host that stops serving the queue gets that line in place of its last queue", async () => {
    const host = hostWith(teamDecision("d1"));
    const page = await open(host);
    try {
      await page.getByText("Which limit for d1?").waitFor({ timeout: 4000 });
      host.queueStatus = 404;
      await page.getByText("The decision queue is not available on this host.").waitFor({ timeout: 4000 });
      assert.equal(await page.getByText("Which limit for d1?").count(), 0, "the last queue does not stay as if the host still had one");
      await page.keyboard.press("1");
      await page.keyboard.press("Enter");
      await settle(page);
      assert.deepEqual(host.sent, []);

      host.queueStatus = 200;
      await page.getByText("Which limit for d1?").waitFor({ timeout: 4000 });
    } finally {
      await page.close();
    }
  });
});
