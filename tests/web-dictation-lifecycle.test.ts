import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";

// Runs the web client's real dictation hook and controls in Chromium against a stand-in recognizer and cleanup route.
// PLAYWRIGHT_CHROMIUM_PATH selects a Chromium build other than the one `npx playwright install chromium` provides.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();
const skip = existsSync(executablePath) ? false : "Chromium for Playwright is not installed; run `npx playwright install chromium`";
const harness = fileURLToPath(new URL("./fixtures/web-dictation-harness.tsx", import.meta.url));
const ORIGIN = "http://127.0.0.1/dictation";

type Harness = Window & {
  dictation: {
    recognizers: { aborted: boolean; say(text: string): void }[];
    cleanups: { text: string; resolve(value: { model: string; text: string }): void; reject(error: Error): void }[];
  };
};

describe("web dictation lifecycle", { skip }, () => {
  let browser: Browser;
  let script: string;
  before(async () => {
    const bundle = await build({ entryPoints: [harness], bundle: true, write: false, format: "iife", jsx: "automatic", logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' } });
    script = bundle.outputFiles[0].text;
    browser = await chromium.launch({ executablePath });
  });
  after(() => browser?.close());

  async function open() {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    // A loopback origin is a secure context, which the client's crypto.randomUUID() requires; nothing listens on it.
    await page.route(ORIGIN, route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
    await page.goto(ORIGIN);
    await page.addScriptTag({ content: script });
    await page.getByRole("button", { name: "Dictate" }).waitFor();
    return { page, errors };
  }
  const say = (page: Page, text: string) => page.evaluate(text => (window as unknown as Harness).dictation.recognizers.at(-1)!.say(text), text);
  const cleanups = (page: Page) => page.evaluate(() => (window as unknown as Harness).dictation.cleanups.map(cleanup => cleanup.text));
  const reply = (page: Page, text: string) => page.evaluate(text => (window as unknown as Harness).dictation.cleanups.at(-1)!.resolve({ model: "test-cleanup", text }), text);
  const fail = (page: Page, message: string) => page.evaluate(message => (window as unknown as Harness).dictation.cleanups.at(-1)!.reject(new Error(message)), message);
  // Lets a settled reply and the renders it causes finish before the page is read.
  const settle = (page: Page) => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
  const field = (page: Page) => page.getByLabel("Field").inputValue();
  const notice = (page: Page) => page.getByRole("status").innerText();

  async function capture(page: Page, transcript: string) {
    await page.getByRole("button", { name: "Dictate" }).click();
    await page.getByRole("button", { name: "Stop dictation" }).waitFor();
    await say(page, transcript);
    await page.getByRole("button", { name: "Stop dictation" }).click();
    await page.getByRole("button", { name: "Cleaning up dictation" }).waitFor();
  }

  test("locking the field while it listens stops the recognizer and adds nothing", async () => {
    const { page, errors } = await open();
    await page.getByRole("button", { name: "Dictate" }).click();
    await page.getByRole("button", { name: "Stop dictation" }).waitFor();
    await say(page, "add retries");
    await page.getByRole("button", { name: "Lock field", exact: true }).click();
    await page.getByText("Dictation stopped because the field was locked").waitFor();
    assert.equal(await page.evaluate(() => (window as unknown as Harness).dictation.recognizers[0].aborted), true);
    assert.equal(await page.getByRole("button", { name: "Dictate" }).isDisabled(), true);
    await page.getByRole("button", { name: "Unlock field", exact: true }).click();
    await settle(page);
    assert.equal(await field(page), "Draft");
    assert.deepEqual(await cleanups(page), []);
    assert.equal(await page.getByRole("button", { name: "Dictate" }).isEnabled(), true);
    assert.deepEqual(errors, []);
  });

  test("a cleanup reply that arrives after the field locked is discarded, even once it unlocks", async () => {
    const { page, errors } = await open();
    await capture(page, "um add retries");
    assert.deepEqual(await cleanups(page), ["um add retries"]);
    await page.getByRole("button", { name: "Lock field", exact: true }).click();
    await page.getByText("Dictation stopped because the field was locked").waitFor();
    await page.getByRole("button", { name: "Unlock field", exact: true }).click();
    await reply(page, "Add retries.");
    await settle(page);
    assert.equal(await field(page), "Draft");
    assert.match(await notice(page), /Dictation stopped because the field was locked/);
    assert.deepEqual(errors, []);
  });

  test("Use original is offered only while the field is editable and still shows the cleaned text", async () => {
    const { page, errors } = await open();
    await page.getByRole("button", { name: "Dictate" }).click();
    await page.getByRole("button", { name: "Stop dictation" }).waitFor();
    // Typing during capture is kept; dictation appends to the latest text.
    await page.getByLabel("Field").fill("Draft typed");
    await say(page, "um add retries");
    await page.getByRole("button", { name: "Stop dictation" }).click();
    await page.getByRole("button", { name: "Cleaning up dictation" }).waitFor();
    await reply(page, "Add retries.");
    await page.getByRole("button", { name: "Use original" }).waitFor();
    assert.equal(await field(page), "Draft typed Add retries.");
    assert.match(await notice(page), /Cleaned up by test-cleanup\./);

    // A send in flight or awaiting retry locks the field; the cleaned text must stay as sent.
    await page.getByRole("button", { name: "Lock field", exact: true }).click();
    await page.getByRole("button", { name: "Unlock field", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Use original" }).count(), 0);
    assert.match(await notice(page), /Cleaned up by test-cleanup\./);

    await page.getByRole("button", { name: "Unlock field", exact: true }).click();
    await page.getByRole("button", { name: "Use original" }).click();
    assert.equal(await field(page), "Draft typed um add retries");
    assert.match(await notice(page), /Original transcript inserted\./);
    assert.deepEqual(errors, []);
  });

  test("a failed cleanup inserts the raw transcript and says why", async () => {
    const { page, errors } = await open();
    await capture(page, "add retries");
    await fail(page, "The dictation model failed");
    await page.getByText("Added without cleanup").waitFor();
    assert.equal(await field(page), "Draft add retries");
    assert.match(await notice(page), /Added without cleanup \(The dictation model failed\)\./);
    assert.equal(await page.getByRole("button", { name: "Use original" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Dictate" }).isEnabled(), true);
    assert.deepEqual(errors, []);
  });
});
