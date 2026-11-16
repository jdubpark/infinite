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
      note(`stop session ${session.id.slice(0, 8)} (${session.provider}): HTTP ${stop.status}`);
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
else await cleanup();
