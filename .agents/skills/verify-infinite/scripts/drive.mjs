#!/usr/bin/env node
// Drive a running local Infinite host with Playwright, check it, and tear it down.
//
// Usage (from the repository root):
//   node .agents/skills/verify-infinite/scripts/drive.mjs doctor  --instance DIR
//   node .agents/skills/verify-infinite/scripts/drive.mjs sign-in --instance DIR
//   node .agents/skills/verify-infinite/scripts/drive.mjs cleanup --instance DIR
//
// DIR is the instance directory from the launch step (config.json, devices.json,
// server.pid, run-dir). Evidence goes to DIR/../evidence and is never deleted by cleanup.
// The owner key is read from devices.json for requests only: it is never printed,
// logged, or written to evidence.
// Chromium: PLAYWRIGHT_CHROMIUM_PATH, else the macOS Google Chrome app, else Playwright's bundled build.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { expect } from "@playwright/test";

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
if (!["doctor", "sign-in", "cleanup"].includes(command)) fail("Command must be doctor, sign-in, or cleanup");
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

// Loaded on demand. Every error and log line passes through redact().
let key;
function ownerKey() {
  if (key === undefined) key = JSON.parse(readFileSync(join(instance, "devices.json"), "utf8")).owner;
  return key;
}
const redact = (text) => {
  const secret = key ?? (existsSync(join(instance, "devices.json")) ? ownerKey() : undefined);
  return secret ? String(text).split(secret).join("[owner key]") : String(text);
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

function processArgs(pid) {
  try {
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function processTable() {
  return execFileSync("ps", ["-axo", "pid=,ppid=,args="], { encoding: "utf8" }).split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] }] : [];
  });
}

// Names lsof reports for one process's open files, e.g. unix socket paths with -U.
function openNames(pid, flags) {
  try {
    const out = execFileSync("lsof", ["-nP", "-a", ...flags, "-p", String(pid), "-Fn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
  } catch {
    return [];
  }
}

// Processes that belong to this instance and are not the API: session workers, the agent
// processes they started (descendants), and anything with files or a working directory in the instance.
// A worker is matched by a unix socket under this instance's run directory; the path stays
// visible to lsof even after the directory is removed, so orphans are still found.
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
  if (existsSync(instance)) {
    try {
      const out = execFileSync("lsof", ["+D", instance, "-Fp"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      for (const line of out.split("\n")) if (line.startsWith("p")) found.add(Number(line.slice(1)));
    } catch {
      /* no open files in the instance */
    }
  }
  found.delete(serverPid);
  found.delete(process.pid);
  return [...found].filter(alive);
}

// A PID that already exited is not an error; only signal what is still there.
const signal = (pid, name) => {
  try {
    process.kill(pid, name);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

// Polls until the PIDs exit or the timeout passes. Node timers, not a shell sleep.
async function waitForExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && pids.some(alive)) await new Promise((done) => setTimeout(done, 200));
  return pids.filter(alive);
}

// Gives each PID time to exit on its own, then sends TERM, then KILL. Only the PIDs passed in are signalled.
async function stopAll(pids, note) {
  if (!pids.length) return note("instance processes: none");
  note(`instance processes found: ${pids.join(",")}`);
  const stillRunning = await waitForExit(pids, 10000);
  for (const pid of stillRunning) {
    note(`process ${pid} still running; SIGTERM`);
    signal(pid, "SIGTERM");
  }
  for (const pid of await waitForExit(stillRunning, 5000)) {
    note(`process ${pid} ignored SIGTERM; SIGKILL`);
    signal(pid, "SIGKILL");
  }
}

function ownsThisInstance(pid) {
  return Number.isInteger(pid) && processArgs(pid).includes(`--config ${configFile}`);
}

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

function findChrome() {
  return [process.env.PLAYWRIGHT_CHROMIUM_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    .find((candidate) => candidate && existsSync(candidate));
}

async function signIn() {
  mkdirSync(evidence, { recursive: true });
  const steps = [];
  const pageErrors = [];
  const startedAt = new Date().toISOString();
  const executablePath = findChrome();
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const step = (name, ok, detail = "") => steps.push({ name, ok, detail: redact(detail), at: new Date().toISOString() });
  let page;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(redact(error.message)));
    await page.goto(origin);
    await expect(page.getByRole("heading", { name: "Pick up where you left off." })).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: join(evidence, "01-sign-in.png") });
    step("sign-in page shown", true, origin);

    // Negative control: a well-formed but unknown key must be refused and must not sign in.
    await page.locator("#device-key").fill("x".repeat(40));
    await page.locator("form:has(#device-key) button.primary").click();
    await expect(page.getByRole("alert")).toHaveText("Device key was not recognized", { timeout: 15000 });
    step("unknown key refused", true, "Device key was not recognized");

    await page.locator("#device-key").fill(ownerKey());
    await page.locator("form:has(#device-key) button.primary").click();
    await expect(page.getByRole("navigation", { name: "Sessions", exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("navigation", { name: "Workspace views" })).toBeVisible();
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
    await browser.close();
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
  writeFileSync(join(evidence, "sign-in.json"), JSON.stringify(record, null, 2) + "\n");
  writeFileSync(
    join(evidence, "sign-in.log"),
    steps.map((item) => `${item.at} ${item.ok ? "ok  " : "FAIL"} ${item.name}${item.detail ? ` (${item.detail})` : ""}`).join("\n") + `\nverdict: ${record.verdict}\n`,
  );
  console.log(`sign-in: ${record.verdict} (${steps.length} steps) -> ${join(evidence, "sign-in.json")}`);
  process.exit(failed.length ? 1 : 0);
}

// Stops only what this instance started: sessions through the owner API, then the PIDs
// holding files under this instance's run directory, then the API PID. Evidence is kept.
async function cleanup() {
  mkdirSync(evidence, { recursive: true });
  const log = [];
  const note = (line) => {
    log.push(line);
    console.log(line);
  };
  const apiUp = ownsThisInstance(serverPid);
  // Session workers are detached and outlive the API, so they are found and stopped even when the API is gone.
  const known = new Set(instanceProcesses());
  if (apiUp) {
    const sessions = await api("/api/sessions").catch(() => ({ json: null }));
    for (const session of sessions.json?.sessions ?? []) {
      if (!["running", "starting"].includes(session.status)) continue;
      const stop = await api(`/api/sessions/${session.id}/stop`, { method: "POST", body: { requestId: randomUUID() } })
        .catch((error) => ({ status: redact(error.message) }));
      note(`stop session ${session.id.slice(0, 8)} (${session.provider}): HTTP ${stop.status}`);
    }
  }
  for (const pid of instanceProcesses()) known.add(pid);
  await stopAll([...known], note);
  if (apiUp) {
    signal(serverPid, "SIGTERM");
    const apiLeft = await waitForExit([serverPid], 10000);
    if (apiLeft.length) {
      note(`API ${serverPid} still running after SIGTERM; SIGKILL`);
      signal(serverPid, "SIGKILL");
    }
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
else await cleanup();
