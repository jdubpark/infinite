#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
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
    profile: { type: "string" },
  },
});

const command = positionals[0];
const COMMANDS = ["doctor", "sign-in", "session", "claim", "configure", "team", "goal", "cleanup"];
if (!COMMANDS.includes(command)) fail(`Command must be one of ${COMMANDS.join(", ")}`);
if (!values.instance) fail("Pass --instance DIR (the instance directory from the launch step)");
const RESERVED_PORT = 4780;
const instance = resolve(values.instance);
const configFile = join(instance, "config.json");
if (!existsSync(configFile) && !["cleanup", "claim"].includes(command)) fail(`No config.json in ${instance}; nothing to ${command}`);
const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
const port = Number(values.port ?? config.port);
if (port === RESERVED_PORT) fail(`Refusing port ${RESERVED_PORT}: it is reserved and no verification command may use it`);
if (values.port !== undefined && config.port !== undefined && Number(values.port) !== Number(config.port)) {
  fail(`--port ${values.port} does not match the instance's configured port ${config.port}; refusing before any request`);
}
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
  assertTarget();
  const headers = auth ? { authorization: `Bearer ${ownerKey()}` } : {};
  if (body) headers["content-type"] = "application/json";
  const response = await fetch(`${origin}${path}`, { method, headers, body: body && JSON.stringify(body) });
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function openGuarded(page) {
  assertTarget();
  await openSignIn(page, origin);
}
async function signInGuarded(page, key) {
  assertTarget();
  await signInWithKey(page, key);
}

function assertTarget() {
  if (port === RESERVED_PORT || !Number.isInteger(port)) throw new Error(`refusing request to port ${values.port ?? config.port ?? "unknown"}`);
  if (Number(config.port) !== port) throw new Error(`port ${port} is not the instance's configured port ${config.port}`);
  if (!isThisInstance(processNow(serverPid))) throw new Error("the recorded API process is not this instance; nothing sent");
  if (!listeners().includes(serverPid)) throw new Error(`the instance process ${serverPid} is not listening on ${port}; nothing sent`);
}

function listeners() {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8" });
    return out.split("\n").filter((line) => line.startsWith("p")).map((line) => Number(line.slice(1)));
  } catch {
    return [];
  }
}

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

function openNames(pid, flags) {
  try {
    const out = execFileSync("lsof", ["-nP", "-a", ...flags, "-p", String(pid), "-Fn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
  } catch {
    return [];
  }
}

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

const unchanged = (entry) => processNow(entry.pid)?.identity === entry.identity;

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

async function waitForExit(entries, timeoutMs) {
  const running = (entry) => alive(entry.pid) && unchanged(entry);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && entries.some(running)) await new Promise((done) => setTimeout(done, 200));
  return entries.filter(running);
}

async function stopAll(entries, note) {
  if (!entries.length) return note("instance processes: none");
  note(`instance processes found: ${entries.map((entry) => entry.pid).join(",")}`);
  const stillRunning = await waitForExit(entries, 10000);
  for (const entry of stillRunning) if (signalIfUnchanged(entry, "SIGTERM")) note(`process ${entry.pid} still running; sent SIGTERM`);
  for (const entry of await waitForExit(stillRunning, 5000)) if (signalIfUnchanged(entry, "SIGKILL")) note(`process ${entry.pid} ignored SIGTERM; sent SIGKILL`);
}

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
    await openGuarded(page);
    await page.screenshot({ path: join(evidence, "01-sign-in.png") });
    step("sign-in page shown", true, origin);

    await page.locator("#device-key").fill("x".repeat(40));
    await page.locator("form:has(#device-key) button.primary").click();
    await expect(page.getByRole("alert")).toHaveText("Device key was not recognized", { timeout: 15000 });
    step("unknown key refused", true, "Device key was not recognized");

    await signInGuarded(page, ownerKey());
    step("owner signed in", true, "session rail visible");

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

const TEAM_TERMINAL = ["ready-for-review", "merged", "no-change", "cancelled"];
const GOAL_TERMINAL = ["ready-for-review", "no-opportunity", "limit-reached", "cancelled", "achieved"];
const SESSION_TITLE = "Verification session";
const FIRST_REQUEST = "Reply with one line.";
const STEER_MESSAGE = "Verification message from the session journey";

async function session() {
  mkdirSync(evidence, { recursive: true });
  const startedAt = new Date().toISOString();
  const { steps, step } = recorder(redact);
  const pageErrors = [];
  const pages = {};
  let browser, executablePath, sessionId;
  let pid;

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
      await openGuarded(owner);
      await signInGuarded(owner, ownerKey());
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
    await check("control kept after reconnecting", async () => {
      const stop = owner.getByRole("button", { name: "Stop controlling", exact: true });
      await expect(stop).toBeVisible({ timeout: 15000 });
      await waitHostLease(true);
      return "control was kept";
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
      await openGuarded(phone);
      await signInGuarded(phone, deviceKeys().controller);
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

const TEAM_LINEUP = {
  coordinator: { id: "coordinator", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  implementers: [{ id: "light", label: "Light worker", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
  escalations: [{ id: "strong", label: "Strong worker", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" }],
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
};
const TEAM_CHECK = [
  'import assert from "node:assert/strict";',
  'import { readFileSync } from "node:fs";',
  'assert.match(readFileSync("a.txt", "utf8"), /^revision [1-9][0-9]*\\n$/);',
  'assert.equal(readFileSync("a.txt", "utf8"), readFileSync("b.txt", "utf8"));',
].join("\n") + "\n";
const GOAL_CHECK = [
  'import assert from "node:assert/strict";',
  'import { readFileSync } from "node:fs";',
  'const progress = JSON.parse(readFileSync("features/progress.json", "utf8"));',
  'assert.deepEqual(Object.keys(progress), ["completed"]);',
  'assert.ok(Number.isInteger(progress.completed) && progress.completed >= 1 && progress.completed <= 2);',
].join("\n") + "\n";

function createProject(directory, profile) {
  const files = profile === "teams"
    ? { "original.txt": "The configured project remains unchanged.\n", "check.mjs": TEAM_CHECK }
    : { "features/progress.json": '{"completed":0}\n', "check.mjs": GOAL_CHECK };
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, name)), { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, name), content);
  }
  const git = (...args) => execFileSync("git", ["-c", "user.name=Verification", "-c", "user.email=verify@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--initial-branch=main");
  git("add", ...Object.keys(files));
  git("commit", "-m", "Verification project");
}

const OWNERSHIP = "ownership.json";
const FIXTURES = join(repoRoot, "tests/fixtures");

function insideInstance(realInstance, path) {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return false;
  const real = realpathSync(path);
  return real === realInstance || real.startsWith(realInstance + sep);
}

function readReceipt() {
  const file = join(instance, OWNERSHIP);
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()) return undefined;
  return JSON.parse(readFileSync(file, "utf8"));
}

function claim() {
  if (!Number.isInteger(port) || port === RESERVED_PORT) fail(`claim needs a port other than ${RESERVED_PORT}`);
  if (existsSync(instance) && (lstatSync(instance).isSymbolicLink() || readdirSync(instance).length)) {
    fail(`refusing to claim ${instance}: it exists and is not an empty directory`);
  }
  if (listeners().length) fail(`refusing to claim: port ${port} already has a listener`);
  mkdirSync(instance, { recursive: true, mode: 0o700 });
  const runDir = mkdtempSync("/tmp/iv-");
  writeFileSync(join(instance, "run-dir"), runDir + "\n", { mode: 0o600 });
  const receipt = {
    harness: "verify-infinite",
    token: randomUUID(),
    instance: realpathSync(instance),
    runDir,
    port,
    profile: values.profile ?? null,
    state: "claimed",
    claimedAt: new Date().toISOString(),
  };
  writeFileSync(join(instance, OWNERSHIP), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  console.log(`claimed ${instance} for port ${port}`);
}

function configure() {
  const profile = values.profile;
  if (!["teams", "goals"].includes(profile)) fail("Pass --profile teams or --profile goals");
  if (lstatSync(instance).isSymbolicLink()) fail("refusing: the instance directory is a symbolic link");
  const realInstance = realpathSync(instance);
  const receipt = readReceipt();
  if (!receipt || receipt.harness !== "verify-infinite" || typeof receipt.token !== "string") {
    fail(`refusing: ${OWNERSHIP} is missing or not written by this harness. Run claim first.`);
  }
  if (receipt.instance !== realInstance) fail("refusing: the ownership receipt belongs to another directory");
  if (receipt.state !== "claimed") fail(`refusing: the instance is ${receipt.state}; configure runs once, before the first start`);
  if (receipt.profile !== profile) fail(`refusing: the instance was claimed for ${receipt.profile}, not ${profile}`);
  if (Number(config.port) !== receipt.port) fail(`refusing: config port ${config.port} differs from the claimed port ${receipt.port}`);
  if (lstatSync(configFile).isSymbolicLink() || !insideInstance(realInstance, configFile)) fail("refusing: config.json must be a regular file inside the instance");
  for (const [label, path] of [["stateDir", config.stateDir], ["keyFile", config.keyFile]]) {
    if (!path || !insideInstance(realInstance, path)) fail(`refusing: ${label} does not resolve inside the instance (${path})`);
  }
  if (config.runDir !== receipt.runDir || !/^\/tmp\/iv-/.test(receipt.runDir) || lstatSync(receipt.runDir).isSymbolicLink()) {
    fail("refusing: runDir is not the run directory this claim created");
  }
  if (!Array.isArray(config.projects) || config.projects.length !== 1) fail("refusing: the config has unexpected projects");
  const placeholder = join(instance, "workspace");
  if (config.projects[0].path !== placeholder || !insideInstance(realInstance, placeholder) || readdirSync(placeholder).length) {
    fail("refusing: the placeholder workspace is not an empty directory inside the instance");
  }
  for (const artifact of [join(instance, "project"), join(instance, "teams"), join(instance, "receipts")]) {
    if (existsSync(artifact)) fail(`refusing: ${artifact} already exists`);
  }
  if (Number.isInteger(serverPid) && alive(serverPid)) fail("refusing: the API recorded in server.pid is running");
  if (listeners().length) fail(`refusing: something is listening on ${port}`);

  const receipts = join(instance, "receipts");
  const project = join(instance, "project");
  mkdirSync(receipts, { mode: 0o700 });
  createProject(project, profile);
  if (profile === "goals" && !process.env.VERIFY_HOLD_FIRST_PLAN) writeFileSync(join(receipts, "release-first-plan"), "continue", { mode: 0o600 });
  const next = profile === "teams"
    ? {
      ...config,
      enableDemo: true,
      agents: { demo: { command: process.execPath, args: [join(FIXTURES, "team-agent.mjs"), "success", receipts] } },
      teams: { workspaceDir: join(instance, "teams"), publishHeads: false },
    }
    : {
      ...config,
      agents: {
        claude: { command: process.execPath, args: [join(FIXTURES, "goal-agent.mjs"), "cycles", receipts, "claude"] },
        codex: { command: process.execPath, args: [join(FIXTURES, "goal-agent.mjs"), "cycles", receipts, "codex"] },
      },
      teams: { workspaceDir: join(instance, "teams"), publishHeads: false, lineup: TEAM_LINEUP },
    };
  next.projects = [{
    id: "verify-team",
    name: "Verification project",
    path: project,
    team: { checks: [{ command: process.execPath, args: ["check.mjs"] }] },
  }];
  writeFileSync(configFile, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });

  const written = JSON.parse(readFileSync(configFile, "utf8"));
  const agentNames = Object.keys(written.agents ?? {});
  if (!agentNames.length) fail("refusing: no fixture agents were written");
  for (const name of agentNames) {
    const agent = written.agents[name];
    if (agent.command !== process.execPath || !String(agent.args?.[0] ?? "").startsWith(FIXTURES + sep)) {
      fail(`refusing: agent ${name} is not a fixture under tests/fixtures`);
    }
  }
  const updated = { ...receipt, state: "configured", configuredAt: new Date().toISOString() };
  writeFileSync(join(instance, OWNERSHIP), JSON.stringify(updated, null, 2) + "\n", { mode: 0o600 });
  console.log(`configured ${profile}: agents ${agentNames.join(", ")} are fixtures; project and team workspace inside DIR`);
}

const TEAM_LABELS = { planning: "Planning", discovering: "Investigating", implementing: "Implementing", integrating: "Integrating", verifying: "Running checks", reviewing: "Reviewing", delivering: "Delivering", merged: "Merge reported", "needs-input": "Needs your input", paused: "Paused", blocked: "Blocked", "ready-for-review": "Ready for your review", "no-change": "No change proposed", cancelled: "Cancelled" };
const GOAL_LABELS = { running: "Working", "needs-input": "Needs your input", paused: "Paused", blocked: "Blocked", "ready-for-review": "Ready for your review", "no-opportunity": "No opportunity found", "limit-reached": "Limit reached", cancelled: "Cancelled", achieved: "Outcome recorded: achieved" };
const TEAM_END = ["Ready for your review", "Merge reported", "No change proposed", "Cancelled", "Blocked", "Needs your input"];
const GOAL_END = ["Ready for your review", "Limit reached", "No opportunity found", "Cancelled", "Outcome recorded: achieved", "Blocked", "Needs your input"];
const TEAM_TITLE = "Verification team";
const TEAM_OBJECTIVE = "Write matching revision files for the verification project.";
const GOAL_TITLE = "Verification goal";
const GOAL_OBJECTIVE = "Advance the verification progress file by one step.";
const GOAL_SUCCESS = "The progress file reaches the next step and the check passes.";

async function waitForEnd(locator, ends, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  for (;;) {
    text = (await locator.first().innerText().catch(() => "")).trim();
    if (ends.includes(text) || Date.now() > deadline) return text;
    await new Promise((done) => setTimeout(done, 1000));
  }
}

async function runRunJourney(name, body) {
  mkdirSync(evidence, { recursive: true });
  const startedAt = new Date().toISOString();
  const { steps, step } = recorder(redact);
  const pageErrors = [];
  const pages = {};
  const record = { journey: name, origin, startedAt };
  let browser, executablePath;
  const check = async (stepName, action) => {
    try {
      step(stepName, true, (await action()) ?? "");
    } catch (error) {
      step(stepName, false, error.message.split("\n")[0]);
      throw error;
    }
  };
  try {
    ({ browser, executablePath } = await launchChromium());
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = (pages.owner = await context.newPage());
    page.on("pageerror", (error) => pageErrors.push(redact(error.message)));
    await body({ check, step, page, record, api, pages });
    const pageText = await page.locator("body").innerText();
    const html = await page.content();
    step("owner key absent from page", !pageText.includes(ownerKey()) && !html.includes(ownerKey()), "");
  } catch (error) {
    if (!steps.some((item) => !item.ok)) step("journey completed", false, error.message.split("\n")[0]);
    for (const [role, page] of Object.entries(pages)) await page.screenshot({ path: join(evidence, `99-failure-${role}.png`), fullPage: true }).catch(() => {});
  } finally {
    await browser?.close().catch((error) => step("browser closed", false, error.message.split("\n")[0]));
  }
  step("no page errors", pageErrors.length === 0, `${pageErrors.length} page error(s)`);
  const failed = steps.filter((item) => !item.ok);
  const result = {
    ...record,
    chrome: executablePath ?? "playwright-bundled",
    finishedAt: new Date().toISOString(),
    verdict: failed.length ? "fail" : "pass",
    steps,
    pageErrors,
  };
  writeJourney(evidence, name, result);
  console.log(`${name}: ${result.verdict} (${steps.length} steps) -> ${join(evidence, `${name}.json`)}`);
  process.exit(failed.length ? 1 : 0);
}

async function team() {
  await runRunJourney("team", async ({ check, page, record, api: call, pages }) => {
    let teamId, pageStatus = "";
    await check("owner signed in", async () => {
      await openGuarded(page);
      await signInGuarded(page, ownerKey());
    });
    await check("teams enabled and a workspace is ready", async () => {
      await page.getByRole("button", { name: "Teams", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Give your team an outcome." })).toBeVisible({ timeout: 15000 });
      const me = (await call("/api/me")).json;
      if (!me?.teams?.enabled) throw new Error("GET /api/me reports teams.enabled false");
      if (await page.getByRole("status").filter({ hasText: "Teams need host setup." }).count()) throw new Error("the page shows Teams need host setup.");
      if (await page.getByRole("status").filter({ hasText: "No workspace is ready for a team." }).count()) throw new Error("the page shows No workspace is ready for a team.");
      await page.screenshot({ path: join(evidence, "01-team-list.png"), fullPage: true });
      return `${me.projects.length} workspace(s)`;
    });
    await check("team started from the New team form", async () => {
      await page.getByRole("button", { name: "New team", exact: true }).first().click();
      await page.locator("#team-title").fill(TEAM_TITLE);
      await page.locator("#team-objective").fill(TEAM_OBJECTIVE);
      await page.locator("#team-project").selectOption("verify-team");
      await page.getByRole("button", { name: "Start team", exact: true }).click();
      const started = page.getByRole("status").filter({ hasText: "Team started." });
      await expect(started.or(page.getByRole("heading", { name: TEAM_TITLE, exact: true }))).toBeVisible({ timeout: 15000 });
    });
    await check("API lists the new run once", async () => {
      const runs = ((await call("/api/teams")).json?.teams ?? []).filter((item) => item.title === TEAM_TITLE);
      if (runs.length !== 1) throw new Error(`expected one run titled "${TEAM_TITLE}", found ${runs.length}`);
      teamId = runs[0].id;
      return `run ${teamId.slice(0, 8)}`;
    });
    await check("team page opened", async () => {
      const open = page.getByRole("button", { name: "Open team", exact: true });
      if (await open.isVisible().catch(() => false)) await open.click();
      await expect(page.getByRole("heading", { name: TEAM_TITLE, exact: true })).toBeVisible({ timeout: 15000 });
    });
    await check("run reaches an end state on the page", async () => {
      pageStatus = await waitForEnd(page.locator(".team-status"), TEAM_END, 300000);
      await page.screenshot({ path: join(evidence, "02-team-run.png"), fullPage: true });
      if (pageStatus !== TEAM_LABELS["ready-for-review"]) throw new Error(`the page shows "${pageStatus}"`);
      return pageStatus;
    });
    await check("page and team API agree on status", async () => {
      const detail = await call(`/api/teams/${teamId}`);
      if (detail.status !== 200) throw new Error(`GET /api/teams/:id returned HTTP ${detail.status}`);
      const listed = ((await call("/api/teams")).json?.teams ?? []).find((item) => item.id === teamId);
      if (listed?.status !== detail.json.status) throw new Error("GET /api/teams and GET /api/teams/:id disagree");
      const label = TEAM_LABELS[detail.json.status];
      if (label !== pageStatus) throw new Error(`API status ${detail.json.status} (${label}) does not match the page "${pageStatus}"`);
      record.teamId = teamId;
      record.revision = detail.json.revision;
      return `API ${detail.json.status} = page "${pageStatus}" at revision ${detail.json.revision}`;
    });
  });
}

async function goal() {
  await runRunJourney("goal", async ({ check, page, record, api: call }) => {
    let goalId, pageStatus = "";
    await check("owner signed in", async () => {
      await openGuarded(page);
      await signInGuarded(page, ownerKey());
    });
    await check("goals enabled with a configured lineup", async () => {
      await page.getByRole("button", { name: "Goals", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Set the outcome and the limits." })).toBeVisible({ timeout: 15000 });
      const me = (await call("/api/me")).json;
      if (!me?.goals?.enabled) throw new Error("GET /api/me reports goals.enabled false");
      if (await page.getByRole("status").filter({ hasText: "Goals need a configured team lineup." }).count()) throw new Error("the page shows Goals need a configured team lineup.");
      await page.screenshot({ path: join(evidence, "01-goal-list.png"), fullPage: true });
      return "goals.enabled true";
    });
    await check("goal started from the New goal form", async () => {
      await page.getByRole("button", { name: "New goal", exact: true }).first().click();
      await page.locator("#goal-title").fill(GOAL_TITLE);
      await page.locator("#goal-objective").fill(GOAL_OBJECTIVE);
      await page.locator("#goal-success").fill(GOAL_SUCCESS);
      await page.locator("#goal-paths").fill("features/progress.json");
      await page.locator("#goal-maxRuns").fill("1");
      await page.locator("#goal-project").selectOption("verify-team");
      await page.getByRole("button", { name: "Start goal", exact: true }).click();
    });
    await check("API lists the new goal once", async () => {
      const deadline = Date.now() + 20000;
      for (;;) {
        const goals = ((await call("/api/goals")).json?.goals ?? []).filter((item) => item.title === GOAL_TITLE);
        if (goals.length === 1) { goalId = goals[0].id; return `goal ${goalId.slice(0, 8)}`; }
        if (goals.length > 1 || Date.now() > deadline) throw new Error(`expected one goal titled "${GOAL_TITLE}", found ${goals.length}`);
        await new Promise((done) => setTimeout(done, 500));
      }
    });
    await check("goal page opened", async () => {
      const opened = page.getByRole("heading", { name: GOAL_TITLE, exact: true });
      const row = page.locator(".team-run-row", { hasText: GOAL_TITLE }).locator("button").first();
      await expect(opened.or(row)).toBeVisible({ timeout: 15000 });
      if (!(await opened.isVisible().catch(() => false))) await row.click();
      await expect(opened).toBeVisible({ timeout: 15000 });
    });
    await check("goal reaches an end state on the page", async () => {
      pageStatus = await waitForEnd(page.locator(".goal-status"), GOAL_END, 300000);
      await page.screenshot({ path: join(evidence, "02-goal.png"), fullPage: true });
      if (pageStatus !== GOAL_LABELS["ready-for-review"]) throw new Error(`the page shows "${pageStatus}", not "${GOAL_LABELS["ready-for-review"]}"`);
      return pageStatus;
    });
    await check("page and goal API agree on status and scope", async () => {
      const detail = await call(`/api/goals/${goalId}`);
      if (detail.status !== 200) throw new Error(`GET /api/goals/:id returned HTTP ${detail.status}`);
      const listed = ((await call("/api/goals")).json?.goals ?? []).find((item) => item.id === goalId);
      if (listed?.status !== detail.json.status) throw new Error("GET /api/goals and GET /api/goals/:id disagree");
      const label = GOAL_LABELS[detail.json.status];
      if (label !== pageStatus) throw new Error(`API status ${detail.json.status} (${label}) does not match the page "${pageStatus}"`);
      if (detail.json.status !== "ready-for-review") throw new Error(`API status is ${detail.json.status}, not ready-for-review`);
      if (detail.json.objective !== GOAL_OBJECTIVE) throw new Error("the API objective differs from the form");
      if (JSON.stringify(detail.json.allowedPaths) !== JSON.stringify(["features/progress.json"])) throw new Error("the API allowed paths differ from the form");
      record.goalId = goalId;
      record.cycles = (detail.json.cycles ?? []).length;
      return `API ${detail.json.status} = page "${pageStatus}", ${record.cycles} cycle(s)`;
    });
    await check("exactly one reviewed cycle reached success", async () => {
      const detail = (await call(`/api/goals/${goalId}`)).json;
      if (detail.cycles?.length !== 1) throw new Error(`expected exactly one cycle, found ${detail.cycles?.length ?? 0}`);
      const cycle = detail.cycles[0];
      if (!["ready-for-review", "merged"].includes(cycle.status)) throw new Error(`cycle status is ${cycle.status}`);
      const team = await call(`/api/teams/${cycle.teamId}`);
      if (team.status !== 200) throw new Error(`GET /api/teams/:cycleTeam returned HTTP ${team.status}`);
      if (team.json.status !== "ready-for-review") throw new Error(`the cycle's team is ${team.json.status}, not ready-for-review`);
      if (team.json.review?.verdict !== "approved") throw new Error(`the cycle's team review is ${team.json.review?.verdict ?? "missing"}, not approved`);
      return `cycle ${cycle.cycle} team ${cycle.teamId.slice(0, 8)} ready-for-review, review approved`;
    });
  });
}

async function cleanup() {
  mkdirSync(evidence, { recursive: true });
  const log = [];
  const note = (line) => {
    log.push(line);
    console.log(line);
  };
  const apiEntry = processNow(serverPid);
  const apiUp = isThisInstance(apiEntry);
  const known = new Map(instanceProcesses().map((entry) => [entry.pid, entry]));
  if (apiUp) {
    const sessions = await api("/api/sessions").catch(() => ({ json: null }));
    for (const session of sessions.json?.sessions ?? []) {
      if (!["running", "starting"].includes(session.status)) continue;
      const stop = await api(`/api/sessions/${session.id}/stop`, { method: "POST", body: { requestId: randomUUID() } })
        .catch((error) => ({ status: redact(error.message) }));
      note(`stop session ${session.id.slice(0, 8)} (${session.provider}): HTTP ${stop.status}${stop.status === 409 ? " (another device holds control; the worker is stopped by signal below)" : ""}`);
    }
    const goalRuns = (await api("/api/goals").catch(() => ({ json: null }))).json?.goals ?? [];
    const activeGoals = goalRuns.filter((goal) => !GOAL_TERMINAL.includes(goal.status));
    if (!activeGoals.length) note("active goals: none");
    for (const goal of activeGoals) {
      const cancel = await api(`/api/goals/${goal.id}/cancel`, { method: "POST", body: { requestId: randomUUID(), revision: goal.revision } })
        .catch((error) => ({ status: redact(error.message) }));
      note(`cancel goal ${goal.id.slice(0, 8)} (${goal.status}): HTTP ${cancel.status}`);
    }
    const teamRuns = (await api("/api/teams").catch(() => ({ json: null }))).json?.teams ?? [];
    const activeTeams = teamRuns.filter((run) => !TEAM_TERMINAL.includes(run.status) && !run.goal);
    if (!activeTeams.length) note("active team runs: none");
    for (const run of activeTeams) {
      const cancel = await api(`/api/teams/${run.id}/cancel`, { method: "POST", body: { requestId: randomUUID(), revision: run.revision } })
        .catch((error) => ({ status: redact(error.message) }));
      note(`cancel team ${run.id.slice(0, 8)} (${run.status}): HTTP ${cancel.status}`);
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
else if (command === "claim") claim();
else if (command === "configure") configure();
else if (command === "team") await team();
else if (command === "goal") await goal();
else await cleanup();
