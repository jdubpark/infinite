import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";

// Runs the phone's real dictation hook in Chromium, with the native recognizer, screen focus, and host API
// replaced by tests/fixtures/mobile-dictation-native.ts. Two screens share the one recognizer, as on the phone.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();
const skip = existsSync(executablePath) ? false : "Chromium for Playwright is not installed; run `npx playwright install chromium`";
const harness = fileURLToPath(new URL("./fixtures/mobile-dictation-harness.tsx", import.meta.url));
const standInPath = fileURLToPath(new URL("./fixtures/mobile-dictation-native.ts", import.meta.url));
const ORIGIN = "http://127.0.0.1/mobile-dictation";

const standIns: Plugin = {
  name: "mobile-dictation-native",
  setup(builder) {
    builder.onResolve({ filter: /^(expo|expo-router|\.\.\/api\/client)$/ }, () => ({ path: standInPath }));
  },
};

type Native = { starts: number; aborts: number; holdEnds: boolean; cleanups: { text: string; resolve(value: { model: string; text: string }): void }[]; say(text: string): void; releaseEnds(): void };

describe("phone dictation lifecycle", { skip }, () => {
  let browser: Browser;
  let script: string;
  before(async () => {
    const bundle = await build({ entryPoints: [harness], bundle: true, write: false, format: "iife", jsx: "automatic", logLevel: "silent", plugins: [standIns], define: { "process.env.NODE_ENV": '"production"' } });
    script = bundle.outputFiles[0].text;
    browser = await chromium.launch({ executablePath });
  });
  after(() => browser?.close());

  async function open() {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route(ORIGIN, route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
    await page.goto(ORIGIN);
    await page.addScriptTag({ content: script });
    await page.getByRole("region", { name: "Terminal" }).waitFor();
    return { page, errors };
  }
  const native = (page: Page) => ({
    starts: () => page.evaluate(() => (window as unknown as { dictation: Native }).dictation.starts),
    aborts: () => page.evaluate(() => (window as unknown as { dictation: Native }).dictation.aborts),
    cleanups: () => page.evaluate(() => (window as unknown as { dictation: Native }).dictation.cleanups.map(cleanup => cleanup.text)),
    say: (text: string) => page.evaluate(text => (window as unknown as { dictation: Native }).dictation.say(text), text),
    reply: (text: string) => page.evaluate(text => (window as unknown as { dictation: Native }).dictation.cleanups.at(-1)!.resolve({ model: "test-cleanup", text }), text),
    holdEnds: () => page.evaluate(() => { (window as unknown as { dictation: Native }).dictation.holdEnds = true; }),
    releaseEnds: () => page.evaluate(() => (window as unknown as { dictation: Native }).dictation.releaseEnds()),
  });
  const screen = (page: Page, name: string) => {
    const region = page.getByRole("region", { name });
    return {
      button: (label: string) => region.getByRole("button", { name: label, exact: true }),
      field: () => region.getByLabel("Field").inputValue(),
      notice: () => region.getByRole("status").innerText(),
    };
  };
  // Lets timers, replies, and the renders they cause finish before the page is read.
  const settle = (page: Page) => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));

  test("a capture in one screen keeps another from starting, and its words reach only its own field", async () => {
    const { page, errors } = await open();
    const brief = screen(page, "Brief"), terminal = screen(page, "Terminal"), speech = native(page);
    await brief.button("Dictate").click();
    await brief.button("Stop dictation").waitFor();
    await terminal.button("Dictate").click();
    await settle(page);
    assert.equal(await speech.starts(), 1);
    assert.match(await terminal.notice(), /already running in another field/);
    await speech.say("add retries");
    await brief.button("Stop dictation").click();
    await brief.button("Cleaning up dictation").waitFor();
    assert.deepEqual(await speech.cleanups(), ["add retries"]);
    await speech.reply("Add retries.");
    await settle(page);
    assert.equal(await brief.field(), "Draft Add retries.");
    assert.equal(await terminal.field(), "Draft");
    await terminal.button("Dictate").click();
    await terminal.button("Stop dictation").waitFor();
    assert.deepEqual(errors, []);
  });

  test("leaving the screen stops its capture and adds nothing", async () => {
    const { page, errors } = await open();
    const brief = screen(page, "Brief"), speech = native(page);
    await brief.button("Dictate").click();
    await brief.button("Stop dictation").waitFor();
    await speech.say("add retries");
    await page.getByRole("button", { name: "Leave Brief" }).click();
    await settle(page);
    assert.equal(await speech.aborts(), 1);
    assert.match(await brief.notice(), /you left this screen/);
    await page.getByRole("button", { name: "Return to Brief" }).click();
    await settle(page);
    assert.equal(await brief.field(), "Draft");
    assert.deepEqual(await speech.cleanups(), []);
    assert.deepEqual(errors, []);
  });

  test("an abandoned capture's late end cannot finish the next capture", async () => {
    const { page, errors } = await open();
    const brief = screen(page, "Brief"), terminal = screen(page, "Terminal"), speech = native(page);
    await speech.holdEnds();
    await brief.button("Dictate").click();
    await brief.button("Stop dictation").waitFor();
    await brief.button("Lock field").click();
    await brief.button("Unlock field").click();
    // The aborted capture has not ended yet, however long that takes, so neither screen may start over it.
    await page.waitForTimeout(3200);
    await brief.button("Dictate").click();
    await terminal.button("Dictate").click();
    await settle(page);
    assert.equal(await speech.starts(), 1);
    assert.match(await terminal.notice(), /still stopping/);
    await speech.releaseEnds();
    await terminal.button("Dictate").click();
    await terminal.button("Stop dictation").waitFor();
    await settle(page);
    await speech.say("add retries");
    await terminal.button("Stop dictation").click();
    await terminal.button("Cleaning up dictation").waitFor();
    assert.deepEqual(await speech.cleanups(), ["add retries"]);
    assert.deepEqual(errors, []);
  });
});
