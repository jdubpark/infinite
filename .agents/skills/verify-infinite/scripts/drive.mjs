#!/usr/bin/env node
// Drive a running local Infinite host with Playwright, check it, and tear it down.
//
// Usage (from the repository root):
//   node .agents/skills/verify-infinite/scripts/drive.mjs doctor  --instance DIR
//   node .agents/skills/verify-infinite/scripts/drive.mjs sign-in --instance DIR
//   node .agents/skills/verify-infinite/scripts/drive.mjs session --instance DIR
//   node .agents/skills/verify-infinite/scripts/drive.mjs cleanup --instance DIR
//
// DIR is the instance directory from the launch step (config.json, devices.json,
// server.pid, run-dir). Evidence goes to DIR/../evidence and is never deleted by cleanup.
// Device keys are read from devices.json for requests and sign-in only: they are never
// printed, logged, or written to evidence.
// Chromium: PLAYWRIGHT_CHROMIUM_PATH, else the macOS Google Chrome app, else Playwright's bundled build.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { expect } from "@playwright/test";
import { launchChromium, openSignIn, recorder, signInWithKey, writeJourney } from "./browser.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    instance: { type: "string" },
    port: { type: "string" },
    evidence: { type: "string" },
  },
});

const command = positionals[0];
if (!["doctor", "sign-in", "session", "cleanup"].includes(command)) fail("Command must be doctor, sign-in, session, or cleanup");
if (!values.instance) fail("Pass --instance DIR (the instance directory from the launch step)");
const instance = resolve(values.instance);
const configFile = join(instance, "config.json");
// Cleanup still runs when the config is already gone; the other commands need it.
if (!existsSync(configFile) && command !== "cleanup") fail(`No config.json in ${instance}; nothing to ${command}`);
const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
const port = Number(values.port ?? config.port);
const origin = `http://127.0.0.1:${port}`;
const evidence = resolve(values.evidence ?? join(dirname(instance), "evidence"));
const pidFile = join(instance, "server.pid");
const runDirFile = join(instance, "run-dir");
const serverPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : NaN;
const runDir = existsSync(runDirFile) ? readFileSync(runDirFile, "utf8").trim() : "";

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Loaded on demand. Every error and log line passes through redact(), which removes all device keys.
let devices;
function deviceKeys() {
  if (devices === undefined) devices = JSON.parse(readFileSync(join(instance, "devices.json"), "utf8"));
  return devices;
}
const ownerKey = () => deviceKeys().owner;
const redact = (text) => {
  const secrets = existsSync(join(instance, "devices.json")) ? Object.values(deviceKeys()).filter((value) => typeof value === "string" && value) : [];
  return secrets.reduce((out, secret) => out.split(secret).join("[device key]"), String(text));
};

async function api(path, { auth = true, method = "GET", body } = {}) {
  const headers = auth ? { authorization: `Bearer ${ownerKey()}` } : {};
  if (body) headers["content-type"] = "application/json";
  const response = await fetch(`${origin}${path}`, { method, headers, body: body && JSON.stringify(body) });
  return { status: response.status, json: await response.json().catch(() => null) };
}

function listeners() {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8" });
    return out.split("\n").filter((line) => line.startsWith("p")).map((line) => Number(line.slice(1)));
  } catch {
    return [];
  }
}

// ps rows with pid, parent, start time, and command line. The identity (start time plus command line)
// comes from the same row that establishes ownership, so a PID reused later is never adopted. A reused
// PID has a different start time even when its command line is identical. Limits: lstart has one-second
// resolution, and macOS cannot make the check and the signal one step.
const PS_ROW = /^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/;
function psRows(args) {
  try {
    const out = execFileSync("ps", args, { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").flatMap((line) => {
      const match = line.trim().match(PS_ROW);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), args: match[4], identity: `${match[3].replace(/\s+/g, " ")} ${match[4]}` }] : [];
    });
  } catch {
    return [];
  }
}
const processTable = () => psRows(["-axo", "pid=,ppid=,lstart=,args="]);
const processNow = (pid) => (Number.isInteger(pid) ? psRows(["-o", "pid=,ppid=,lstart=,args=", "-p", String(pid)])[0] : undefined);

// Names lsof reports for one process's open files, e.g. unix socket paths with -U.
function openNames(pid, flags) {
  try {
    const out = execFileSync("lsof", ["-nP", "-a", ...flags, "-p", String(pid), "-Fn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
  } catch {
    return [];
  }
}

// Processes that belong to this instance and are not the API: session workers and the agent
// processes they started (descendants). Nothing else qualifies, so a shell or editor that merely
// has a file open in the instance is never signalled. A worker is matched by a unix socket under
// this instance's run directory; the path stays visible to lsof even after the directory is
// removed, so orphans are still found. Each entry keeps the start time and command line seen at discovery.
function instanceProcesses() {
  const table = processTable();
  const runDirs = [runDir, existsSync(runDir) ? realpathSync(runDir) : ""].filter(Boolean);
  const found = new Set();
  for (const entry of table) {
    if (entry.pid === serverPid || entry.pid === process.pid) continue;
    if (!/packages\/host\/(src|dist)\/worker\.(ts|js)\b/.test(entry.args)) continue;
    if (openNames(entry.pid, ["-U"]).some((name) => runDirs.some((dir) => name.startsWith(`${dir}/`)))) found.add(entry.pid);
  }
  const queue = [...found];
  while (queue.length) {
    const parent = queue.pop();
    for (const child of table) {
      if (child.ppid === parent && !found.has(child.pid)) {
        found.add(child.pid);
        queue.push(child.pid);
      }
    }
  }
  found.delete(serverPid);
  found.delete(process.pid);
  const rows = new Map(table.map((entry) => [entry.pid, entry]));
  return [...found].map((pid) => rows.get(pid)).filter(Boolean);
}

// True only while the PID is still the process recorded at discovery (same start time and command line).
const unchanged = (entry) => processNow(entry.pid)?.identity === entry.identity;

// Signals a recorded process only if its PID still holds that process. A PID that already exited is not an error.
const signalIfUnchanged = (entry, name) => {
  if (!unchanged(entry)) return false;
  try {
    process.kill(entry.pid, name);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  return true;
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

// Polls until the processes exit (or stop matching their recorded identity) or the timeout passes.
async function waitForExit(entries, timeoutMs) {
  const running = (entry) => alive(entry.pid) && unchanged(entry);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && entries.some(running)) await new Promise((done) => setTimeout(done, 200));
  return entries.filter(running);
}

// Gives each process time to exit on its own, then sends TERM, then KILL. Only the entries passed in are
// signalled, and each one only after its identity is checked again.
async function stopAll(entries, note) {
  if (!entries.length) return note("instance processes: none");
  note(`instance processes found: ${entries.map((entry) => entry.pid).join(",")}`);
  const stillRunning = await waitForExit(entries, 10000);
  for (const entry of stillRunning) if (signalIfUnchanged(entry, "SIGTERM")) note(`process ${entry.pid} still running; sent SIGTERM`);
  for (const entry of await waitForExit(stillRunning, 5000)) if (signalIfUnchanged(entry, "SIGKILL")) note(`process ${entry.pid} ignored SIGTERM; sent SIGKILL`);
}

// The API is ours when its command line carries this instance's config path.
const isThisInstance = (entry) => Boolean(entry?.args.includes(`--config ${configFile}`));
const ownsThisInstance = (pid) => isThisInstance(processNow(pid));

async function doctor() {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });
  check("server.pid recorded", Number.isInteger(serverPid), Number.isInteger(serverPid) ? `pid ${serverPid}` : "missing");
  check("process is this instance", ownsThisInstance(serverPid), ownsThisInstance(serverPid) ? "config path matches" : "no matching process");
  check("port owned by that process", listeners().includes(serverPid), `listeners on ${port}: ${listeners().join(",") || "none"}`);
  const anonymous = await api("/api/me", { auth: false }).catch((error) => ({ status: redact(error.message) }));
  check("unauthenticated /api/me refused", anonymous.status === 401, `status ${anonymous.status}`);
  const me = await api("/api/me").catch((error) => ({ status: redact(error.message), json: null }));
  check("owner key accepted", me.status === 200 && me.json?.role === "owner", `status ${me.status}, role ${me.json?.role ?? "none"}, environment ${me.json?.environment ?? "none"}`);
  const sessions = await api("/api/sessions").catch(() => ({ status: 0, json: null }));
  check("session list readable", sessions.status === 200, `status ${sessions.status}, sessions ${sessions.json?.sessions?.length ?? "n/a"}`);
  check("web client built", existsSync(join(repoRoot, "apps/web/dist/index.html")), "apps/web/dist/index.html");
  check("host CLI built", existsSync(join(repoRoot, "packages/host/dist/cli.js")), "packages/host/dist/cli.js");
  for (const line of checks) console.log(`${line.ok ? "ok  " : "FAIL"} ${line.name}: ${line.detail}`);
  const failed = checks.filter((line) => !line.ok).length;
  console.log(failed ? `doctor: ${failed} check(s) failed` : "doctor: ok");
  process.exit(failed ? 1 : 0);
}

async function signIn() {
  mkdirSync(evidence, { recursive: true });
  const pageErrors = [];
  const startedAt = new Date().toISOString();
  const { steps, step } = recorder(redact);
  let browser, executablePath, page;
  try {
    ({ browser, executablePath } = await launchChromium());
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(redact(error.message)));
    await openSignIn(page, origin);
    await page.screenshot({ path: join(evidence, "01-sign-in.png") });
    step("sign-in page shown", true, origin);

    // Negative control: a well-formed but unknown key must be refused and must not sign in.
    await page.locator("#device-key").fill("x".repeat(40));
    await page.locator("form:has(#device-key) button.primary").click();
    await expect(page.getByRole("alert")).toHaveText("Device key was not recognized", { timeout: 15000 });
    step("unknown key refused", true, "Device key was not recognized");

    await signInWithKey(page, ownerKey());
    step("owner signed in", true, "session rail visible");

    // The session cookie is scoped to path /api, so ask for a URL under it.
    const cookies = await context.cookies(`${origin}/api/me`);
    const cookie = cookies.find((item) => item.name === "infinite");
    step("browser session cookie set", Boolean(cookie?.httpOnly), cookie ? `httpOnly ${cookie.httpOnly}, sameSite ${cookie.sameSite}` : "missing");

    await page.getByRole("group", { name: "Filter sessions" }).getByRole("button", { name: /^All/ }).click();
    const heading = (await page.getByRole("heading", { name: /^Sessions/ }).first().textContent()) ?? "";
    const shownCount = Number(heading.replace(/\D+/g, ""));
    const sessionsResponse = await api("/api/sessions");
    const apiCount = sessionsResponse.json?.sessions?.length;
    step("session list matches host API", sessionsResponse.status === 200 && shownCount === apiCount, `rail ${shownCount}, API ${apiCount}`);
    const emptyText = (await page.locator(".rail-empty").count()) ? (await page.locator(".rail-empty").first().textContent()).trim() : "";
    if (apiCount === 0) await expect(page.locator(".rail-empty")).toContainText("Create a session on this machine to see it here.");
    step("session list rendered in All view", true, apiCount === 0 ? `empty state: ${emptyText}` : `${apiCount} rows`);

    const pageText = await page.locator("body").innerText();
    const html = await page.content();
    step("owner key absent from page", !pageText.includes(ownerKey()) && !html.includes(ownerKey()), "");
    await page.screenshot({ path: join(evidence, "02-session-list.png"), fullPage: true });
    step("no page errors", pageErrors.length === 0, `${pageErrors.length} page error(s)`);
  } catch (error) {
    if (page) await page.screenshot({ path: join(evidence, "99-failure.png"), fullPage: true }).catch(() => {});
    step("journey completed", false, error.message.split("\n")[0]);
  } finally {
    await browser?.close().catch((error) => step("browser closed", false, error.message.split("\n")[0]));
  }
  const failed = steps.filter((item) => !item.ok);
  const record = {
    journey: "sign-in",
    origin,
    chrome: executablePath ?? "playwright-bundled",
    startedAt,
    finishedAt: new Date().toISOString(),
    verdict: failed.length ? "fail" : "pass",
    steps,
    pageErrors,
  };
  writeJourney(evidence, "sign-in", record);
  console.log(`sign-in: ${record.verdict} (${steps.length} steps) -> ${join(evidence, "sign-in.json")}`);
  process.exit(failed.length ? 1 : 0);
}

const SESSION_TITLE = "Verification session";
const FIRST_REQUEST = "Reply with one line.";
const STEER_MESSAGE = "Verification message from the session journey";

// Owner starts a Rehearsal session, takes control, steers it, and checks the PID across an offline gap.
// A controller on a 390x844 touch phone then checks the same transcript and PID.
async function session() {
  mkdirSync(evidence, { recursive: true });
  const startedAt = new Date().toISOString();
  const { steps, step } = recorder(redact);
  const pageErrors = [];
  const pages = {};
  let browser, executablePath, sessionId;
  let pid;

  // Runs one named step. A failure is recorded with the first line of its error and stops the journey.
  const check = async (name, action) => {
    try {
      step(name, true, (await action()) ?? "");
    } catch (error) {
      step(name, false, error.message.split("\n")[0]);
      throw error;
    }
  };
  const sessionDetail = async (id) => {
    const { status, json } = await api(`/api/sessions/${id}`);
    if (status !== 200) throw new Error(`GET session returned HTTP ${status}`);
    return json;
  };
  // The page clears its own lease before the host confirms a release, so lease state is read from the host.
  const waitHostLease = async (held) => {
    const deadline = Date.now() + 15000;
    for (;;) {
      if (Boolean((await sessionDetail(sessionId)).control) === held) return;
      if (Date.now() > deadline) throw new Error(held ? "the host shows no control lease" : "the host still holds a control lease");
      await new Promise((done) => setTimeout(done, 250));
    }
  };
  const headerPid = async (page) => {
    const text = await page.locator(".session-meta", { hasText: "PID" }).first().innerText();
    const match = text.match(/PID (\d+)/);
    if (!match) throw new Error("session header shows no PID");
    return Number(match[1]);
  };
  const row = (page) => page.getByRole("navigation", { name: "Sessions", exact: true }).getByRole("button", { name: new RegExp(SESSION_TITLE) }).first();

  try {
    ({ browser, executablePath } = await launchChromium());
    const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const owner = pages.owner = await ownerContext.newPage();
    owner.on("pageerror", (error) => pageErrors.push(redact(error.message)));

    await check("owner signed in (1440x1000)", async () => {
      await openSignIn(owner, origin);
      await signInWithKey(owner, ownerKey());
    });
    await check("Rehearsal session started", async () => {
      await owner.getByRole("button", { name: "New session", exact: true }).click();
      await owner.locator("#provider").selectOption("demo");
      await owner.locator("#title").fill(SESSION_TITLE);
      await owner.locator("#prompt").fill(FIRST_REQUEST);
      await owner.getByRole("button", { name: "Start session", exact: true }).click();
    });
    await check("session shows as running", async () => {
      await expect(row(owner)).toBeVisible({ timeout: 15000 });
      await expect(row(owner)).toContainText(/running/i, { timeout: 15000 });
      return (await row(owner).innerText()).split("\n").filter(Boolean).slice(0, 3).join(" | ");
    });
    await check("session opened", async () => {
      await row(owner).click();
      await expect(owner.getByRole("heading", { name: SESSION_TITLE, exact: true })).toBeVisible({ timeout: 15000 });
      const listed = (await api("/api/sessions")).json?.sessions?.filter((item) => item.title === SESSION_TITLE) ?? [];
      if (listed.length !== 1) throw new Error(`expected one session titled "${SESSION_TITLE}", found ${listed.length}`);
      sessionId = listed[0].id;
      return `session ${sessionId.slice(0, 8)}`;
    });
    await check("control taken on Catch up", async () => {
      await owner.getByRole("tab", { name: "Catch up", exact: true }).click();
      const take = owner.getByRole("button", { name: /^Take (control|over)$/ });
      await expect(take).toBeVisible({ timeout: 15000 });
      await take.click();
      await expect(owner.getByRole("button", { name: "Stop controlling", exact: true })).toBeVisible({ timeout: 15000 });
      await waitHostLease(true);
    });
    const screen = owner.locator("pre.screen");
    await check("steering message echoed and answered", async () => {
      await owner.locator("#message").fill(STEER_MESSAGE);
      await owner.getByRole("button", { name: "Send message", exact: true }).click();
      await expect(screen).toContainText(`You: ${STEER_MESSAGE}`, { timeout: 10000 });
      await expect(screen).toContainText("Rehearsal: message received by process", { timeout: 10000 });
      await expect(owner.getByText("Input delivered to terminal", { exact: true })).toBeVisible({ timeout: 10000 });
      await owner.screenshot({ path: join(evidence, "01-steering.png") });
    });
    await check("header PID matches reply and API", async () => {
      pid = await headerPid(owner);
      const replies = [...(await screen.innerText()).matchAll(/message received by process (\d+)/g)];
      const replyPid = Number(replies.at(-1)?.[1]);
      if (replyPid !== pid) throw new Error(`reply came from process ${replyPid}, header shows PID ${pid}`);
      const apiPid = (await sessionDetail(sessionId)).pid;
      if (apiPid !== pid) throw new Error(`API reports pid ${apiPid}, header shows PID ${pid}`);
      return `PID ${pid}`;
    });
    await check("offline shows Reconnecting and disables Send", async () => {
      await owner.locator("#message").fill("Draft written offline");
      await ownerContext.setOffline(true);
      await expect(owner.locator(".connection")).toContainText("Reconnecting", { timeout: 30000 });
      await expect(owner.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
      await owner.screenshot({ path: join(evidence, "02-offline.png") });
    });
    await check("online again with the same PID", async () => {
      await ownerContext.setOffline(false);
      await expect(owner.locator(".connection")).toContainText("Up to date", { timeout: 30000 });
      const after = await headerPid(owner);
      if (after !== pid) throw new Error(`PID changed from ${pid} to ${after} across the offline gap`);
      await owner.locator("#message").fill("");
      return `PID ${after}`;
    });
    // After the gap the page shows Monitoring even when the host still holds its lease, so take control again.
    await check("control retaken after reconnecting", async () => {
      const take = owner.getByRole("button", { name: /^Take (control|over)$/ });
      const stop = owner.getByRole("button", { name: "Stop controlling", exact: true });
      await expect(stop.or(take)).toBeVisible({ timeout: 15000 });
      const lost = await take.isVisible();
      if (lost) await take.click();
      await expect(stop).toBeVisible({ timeout: 15000 });
      await waitHostLease(true);
      return lost ? "the page had dropped control; retaken" : "control was kept";
    });
    await check("Terminal tab shows the xterm screen", async () => {
      await owner.getByRole("tab", { name: "Terminal", exact: true }).click();
      await expect(owner.locator(".xterm-screen")).toBeVisible({ timeout: 15000 });
      await owner.screenshot({ path: join(evidence, "03-terminal.png") });
    });
    await check("Context tab shows the first request", async () => {
      await owner.getByRole("tab", { name: "Context", exact: true }).click();
      await expect(owner.getByText(FIRST_REQUEST, { exact: true })).toBeVisible({ timeout: 15000 });
      await owner.screenshot({ path: join(evidence, "04-context.png") });
    });

    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    const phone = pages.controller = await phoneContext.newPage();
    phone.on("pageerror", (error) => pageErrors.push(redact(error.message)));
    await check("controller signed in (390x844 touch)", async () => {
      await openSignIn(phone, origin);
      await signInWithKey(phone, deviceKeys().controller);
    });
    await check("controller sees the transcript", async () => {
      await row(phone).click();
      await expect(phone.getByRole("heading", { name: SESSION_TITLE, exact: true })).toBeVisible({ timeout: 15000 });
      await phone.getByRole("tab", { name: "Catch up", exact: true }).click();
      await expect(phone.locator("pre.screen")).toContainText(`You: ${STEER_MESSAGE}`, { timeout: 10000 });
    });
    await check("controller header PID matches owner", async () => {
      const controllerPid = await headerPid(phone);
      if (controllerPid !== pid) throw new Error(`controller sees PID ${controllerPid}, owner saw ${pid}`);
      return `PID ${controllerPid}`;
    });
    await check("phone layout fits the viewport", async () => {
      const fits = await phone.evaluate("document.documentElement.scrollWidth <= window.innerWidth");
      await phone.screenshot({ path: join(evidence, "05-controller-phone.png"), fullPage: true });
      if (!fits) throw new Error("document is wider than the 390px viewport");
    });
    // A held control lease makes the worker refuse a stop from any other actor (HTTP 409) until it expires
    // (30 seconds), so the journey ends by releasing it.
    await check("owner released control", async () => {
      await owner.getByRole("tab", { name: "Catch up", exact: true }).click();
      const stop = owner.getByRole("button", { name: "Stop controlling", exact: true });
      const take = owner.getByRole("button", { name: /^Take (control|over)$/ });
      await expect(stop.or(take)).toBeVisible({ timeout: 15000 });
      if (await stop.isVisible()) await stop.click();
      await expect(take).toBeVisible({ timeout: 15000 });
      await waitHostLease(false);
      return "the host lease is cleared";
    });
  } catch (error) {
    if (!steps.some((item) => !item.ok)) step("journey completed", false, error.message.split("\n")[0]);
    for (const [role, page] of Object.entries(pages)) {
      await page.screenshot({ path: join(evidence, `99-failure-${role}.png`), fullPage: true }).catch(() => {});
    }
  } finally {
    await browser?.close().catch((error) => step("browser closed", false, error.message.split("\n")[0]));
  }
  step("no page errors", pageErrors.length === 0, `${pageErrors.length} page error(s)`);
  const failed = steps.filter((item) => !item.ok);
  const record = {
    journey: "session",
    origin,
    chrome: executablePath ?? "playwright-bundled",
    startedAt,
    finishedAt: new Date().toISOString(),
    verdict: failed.length ? "fail" : "pass",
    sessionId,
    pid,
    steps,
    pageErrors,
  };
  writeJourney(evidence, "session", record);
  console.log(`session: ${record.verdict} (${steps.length} steps) -> ${join(evidence, "session.json")}`);
  process.exit(failed.length ? 1 : 0);
}

// Stops only what this instance started: sessions through the owner API, then the session workers
// and their descendants, then the API PID. Evidence is kept.
async function cleanup() {
  mkdirSync(evidence, { recursive: true });
  const log = [];
  const note = (line) => {
    log.push(line);
    console.log(line);
  };
  // The API's identity is recorded once here and rechecked before each signal, like every other process.
  const apiEntry = processNow(serverPid);
  const apiUp = isThisInstance(apiEntry);
  // Session workers are detached and outlive the API, so they are found and stopped even when the API is gone.
  const known = new Map(instanceProcesses().map((entry) => [entry.pid, entry]));
  if (apiUp) {
    const sessions = await api("/api/sessions").catch(() => ({ json: null }));
    for (const session of sessions.json?.sessions ?? []) {
      if (!["running", "starting"].includes(session.status)) continue;
      const stop = await api(`/api/sessions/${session.id}/stop`, { method: "POST", body: { requestId: randomUUID() } })
        .catch((error) => ({ status: redact(error.message) }));
      note(`stop session ${session.id.slice(0, 8)} (${session.provider}): HTTP ${stop.status}${stop.status === 409 ? " (another device holds control; the worker is stopped by signal below)" : ""}`);
    }
  }
  for (const entry of instanceProcesses()) if (!known.has(entry.pid)) known.set(entry.pid, entry);
  await stopAll([...known.values()], note);
  if (apiUp) {
    signalIfUnchanged(apiEntry, "SIGTERM");
    const apiLeft = await waitForExit([apiEntry], 10000);
    if (apiLeft.length && signalIfUnchanged(apiEntry, "SIGKILL")) note(`API ${serverPid} still running after SIGTERM; sent SIGKILL`);
    note(`API ${serverPid} stopped`);
    await stopAll(instanceProcesses(), note);
  } else {
    note(`no API process for this instance (pid file: ${Number.isInteger(serverPid) ? serverPid : "missing"})`);
  }
  if (runDir && /^\/tmp\/iv-/.test(runDir) && existsSync(runDir)) {
    rmSync(runDir, { recursive: true, force: true });
    note(`removed run directory ${runDir}`);
  }
  rmSync(instance, { recursive: true, force: true });
  note(`removed instance directory ${instance}`);
  appendFileSync(join(evidence, "cleanup.log"), `${new Date().toISOString()}\n${log.join("\n")}\n`);
  note(`evidence kept: ${evidence}`);
}

if (command === "doctor") await doctor();
else if (command === "sign-in") await signIn();
else if (command === "session") await session();
else await cleanup();
