
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect } from "@playwright/test";

export function findChrome() {
  return [process.env.PLAYWRIGHT_CHROMIUM_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    .find((candidate) => candidate && existsSync(candidate));
}

export async function launchChromium() {
  const executablePath = findChrome();
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  return { browser, executablePath };
}

export async function openSignIn(page, origin) {
  await page.goto(origin);
  await expect(page.getByRole("heading", { name: "Pick up where you left off." })).toBeVisible({ timeout: 15000 });
}

export async function signInWithKey(page, key) {
  await page.locator("#device-key").fill(key);
  await page.locator("form:has(#device-key) button.primary").click();
  await expect(page.getByRole("navigation", { name: "Sessions", exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("navigation", { name: "Workspace views" })).toBeVisible();
}

export function recorder(redact) {
  const steps = [];
  const step = (name, ok, detail = "") => steps.push({ name, ok, detail: redact(detail), at: new Date().toISOString() });
  return { steps, step };
}

export function writeJourney(evidence, name, record) {
  writeFileSync(join(evidence, `${name}.json`), JSON.stringify(record, null, 2) + "\n");
  writeFileSync(
    join(evidence, `${name}.log`),
    record.steps.map((item) => `${item.at} ${item.ok ? "ok  " : "FAIL"} ${item.name}${item.detail ? ` (${item.detail})` : ""}`).join("\n") +
      `\nverdict: ${record.verdict}\n`,
  );
}
