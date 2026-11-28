import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const controller = fileURLToPath(new URL("../scripts/cloud-revision.py", import.meta.url));

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("signed push and same-repository PR heads keep exact SHA status through failure and retry", async t => {
  const dir = mkdtempSync(join(tmpdir(), "cloud-revision-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "source");
  const origin = join(dir, "origin.git");
  mkdirSync(source);
  execFileSync("git", ["init", "-q", "--template=", source]);
  const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  const profile = readFileSync(new URL("../scripts/cloud-check/linux-runner.json", import.meta.url));
  const profileValue = JSON.parse(profile.toString());
  const packageInfo = { name: "fixture-project", version: "1.0.0", private: true, packageManager: "npm@10.9.8", scripts: { check: "node -e 'process.exit(0)'" } };
  writeFileSync(join(source, "package.json"), JSON.stringify(packageInfo));
  writeFileSync(join(source, "package-lock.json"), JSON.stringify({ name: packageInfo.name, version: packageInfo.version, lockfileVersion: 3, requires: true, packages: { "": { name: packageInfo.name, version: packageInfo.version } } }));
  writeFileSync(join(source, ".gitattributes"), "*.payload filter=fixture\n");
  writeFileSync(join(source, "safe.payload"), "committed bytes\n");
  git("add", ".");
  git("commit", "-qm", "passing revision");
  const predecessor = git("rev-parse", "HEAD");
  execFileSync("git", ["clone", "--bare", "-q", source, origin]);
  git("remote", "add", "origin", origin);
  git("push", "-q", "origin", "HEAD:refs/heads/main");
  assert.equal(exists(join(source, "scripts")), false);

  writeFileSync(join(source, "fail.txt"), "verifier fixture marks this revision failing\n");
  git("add", "fail.txt");
  git("commit", "-qm", "failing revision");
  const failing = git("rev-parse", "HEAD");
  git("push", "-q", "origin", "HEAD:refs/heads/main");

  const hookPath = join(dir, "hooks");
  mkdirSync(hookPath);
  const hookMarker = join(dir, "hook-ran");
  const filterMarker = join(dir, "filter-ran");
  writeFileSync(join(hookPath, "post-checkout"), `#!/bin/sh\ntouch '${hookMarker}'\n`, { mode: 0o700 });
  const global = join(dir, "global.gitconfig");
  writeFileSync(global, `[core]\n hooksPath = ${hookPath}\n[filter "fixture"]\n smudge = touch ${filterMarker}\n`);
  const configDir = join(dir, "config");
  const state = join(dir, "state");
  const token = join(dir, "token");
  const secret = join(dir, "webhook-secret");
  writeFileSync(token, "controller-only-token\n", { mode: 0o600 });
  writeFileSync(secret, "webhook-secret-value\n", { mode: 0o600 });
  const launcherCalls = join(dir, "launcher-calls");
  const capacityOpen = join(dir, "capacity-open");
  const installed = join(dir, "installed");
  const launcher = join(installed, "scripts", "cloud-check.py");
  mkdirSync(join(installed, "scripts/cloud-check"), { recursive: true });
  writeFileSync(join(installed, "scripts/cloud-check/linux-runner.json"), profile);
  const command = ["npm", "run", "check"];
  const projectHash = createHash("sha256").update(origin).digest("hex");
  const launcherSource = `#!/usr/bin/env python3
import hashlib, json, os, subprocess, sys
from pathlib import Path
if os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN"):
    raise SystemExit(42)
head = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
with open(${JSON.stringify(launcherCalls)}, "a", encoding="utf-8") as calls:
    calls.write(head + " " + " ".join(sys.argv[1:]) + "\\n")
if Path("rotate-token.txt").exists():
    token_path = Path(${JSON.stringify(token)})
    token_path.write_text("controller-rotated-token\\n", encoding="utf-8")
    token_path.chmod(0o600)
exit_code = 19 if Path("fail.txt").exists() else 0
root = Path(os.environ["XDG_STATE_HOME"]) / "fixture-workspace" / "cloud-check" / "receipts"
for directory in (root.parent.parent, root.parent, root):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
envelope = "fixture-envelope-" + head
guest = {"base": head, "snapshot": "fixture-snapshot", "envelope": envelope, "exit": exit_code, "mode": "npm", "commandSha256": hashlib.sha256(json.dumps(${JSON.stringify(command)}, separators=(",", ":"), ensure_ascii=True).encode("ascii")).hexdigest(), "profile": ${JSON.stringify(profileValue)}, "machine": "fixture-machine", "engine": "fixture-engine"}
receipt = {"version": 1, "workspace": "fixture-workspace", "project": ${JSON.stringify(projectHash)}, "base": head, "archive": "fixture-archive", "envelope": envelope, "requiredTip": None, "current": True, "worktreeChanges": 0, "comparison": None, "runs": [{"runner": "fixture-runner", "exit": exit_code, "receipt": guest}], "exit": exit_code}
if Path("busy-timeout.txt").exists() and (not Path(${JSON.stringify(capacityOpen)}).exists() or Path("ambiguous-receipt.txt").exists()):
    if Path("ambiguous-receipt.txt").exists():
        path = root / (head + ".json")
        path.write_text(json.dumps(receipt), encoding="utf-8")
        path.chmod(0o600)
    if Path("extra-output.txt").exists():
        print("Untrusted task output", file=sys.stderr, flush=True)
    for _ in range(2):
        print("Dispatch to fixture-runner (archive SHA-256 " + "a" * 64 + ")", file=sys.stderr, flush=True)
        print("Runner fixture-runner is busy; checkout not sent", file=sys.stderr, flush=True)
    print("cloud-check: workspace runner pool remained busy until the capacity wait expired", file=sys.stderr, flush=True)
    raise SystemExit(2)
if Path("no-receipt.txt").exists():
    raise SystemExit(0)
if Path("stale-receipt.txt").exists():
    print("RECEIPT " + str(root / ${JSON.stringify(predecessor + ".json")}), flush=True)
    raise SystemExit(0)
if Path("wrong-receipt.txt").exists():
    receipt["base"] = "0" * len(head)
path = root / (head + ".json")
path.write_text(json.dumps(receipt), encoding="utf-8")
path.chmod(0o600)
print("RECEIPT " + str(path), flush=True)
raise SystemExit(exit_code)
`;
  writeFileSync(launcher, launcherSource, { mode: 0o700 });
  const config = {
    repository: "fixture/project",
    origin,
    workspace: "fixture-workspace",
    snapshotRoot: dir,
    runner: "fixture-runner",
    refs: ["refs/heads/main"],
    mode: "npm",
    command,
    profileSha256: createHash("sha256").update(JSON.stringify(profileValue, Object.keys(profileValue).sort())).digest("hex"),
    context: "infinite/cloud-check",
    stateDirectory: state,
    launcher,
    webhookSecretFile: secret,
    githubTokenFile: token,
  };
  mkdirSync(configDir, { mode: 0o700 });
  const configPath = join(configDir, "enrollment.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });

  const published: Array<{ sha: string; state: string; context: string; token: string; description: string }> = [];
  const accepted: Array<{ sha: string; state: string; token: string }> = [];
  let failOneSuccess = false;
  let unavailablePendingSha: string | undefined;
  const api = createServer(async (req, res) => {
    const data = await body(req);
    const match = req.url?.match(/^\/repos\/fixture\/project\/statuses\/([0-9a-f]+)$/);
    if (!match) return respond(res, 404, "unknown route");
    const record = JSON.parse(data.toString());
    published.push({ sha: match[1]!, state: record.state, context: record.context, token: req.headers.authorization ?? "", description: record.description });
    if (unavailablePendingSha === match[1] && record.state === "pending") return respond(res, 503, "publisher unavailable");
    if (failOneSuccess && record.state === "success") {
      failOneSuccess = false;
      return respond(res, 500, "simulated publication interruption");
    }
    accepted.push({ sha: match[1]!, state: record.state, token: req.headers.authorization ?? "" });
    respond(res, 201, "{}", "application/json");
  });
  const apiPort = await listen(api);
  t.after(() => api.close());
  const ingressPort = await freePort();
  const xdgState = join(dir, "xdg-state");
  const localBypass = "127.0.0.1,localhost,::1";
  const controllerEnv = { ...globalThis.process.env, GIT_CONFIG_GLOBAL: global, XDG_STATE_HOME: xdgState, NO_PROXY: localBypass, no_proxy: localBypass };
  const process = spawn("python3", [controller, "--config", configPath, "--serve", "--port", String(ingressPort), "--api", `http://127.0.0.1:${apiPort}`], { env: controllerEnv });
  let startupError = "";
  let startupOutput = "";
  process.stderr?.on("data", chunk => { startupError += chunk.toString(); });
  process.stdout?.on("data", chunk => { startupOutput += chunk.toString(); });
  t.after(async () => {
    if (process.exitCode === null && process.signalCode === null) {
      const exited = new Promise<void>(resolve => process.once("exit", () => resolve()));
      process.kill("SIGTERM");
      await exited;
    }
  });
  let ready = false;
  for (let attempt = 0; attempt < 250; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${ingressPort}/health`);
      ready = true;
      break;
    } catch {
      await delay(20);
    }
  }
  assert.equal(ready, true, `${startupError}${startupOutput}exit=${process.exitCode} signal=${process.signalCode}`);

  async function deliver(event: string, delivery: string, payload: object, signature = true) {
    const data = Buffer.from(JSON.stringify(payload));
    const sig = `sha256=${createHmac("sha256", "webhook-secret-value").update(data).digest("hex")}`;
    return fetch(`http://127.0.0.1:${ingressPort}/github-webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": delivery,
        "x-hub-signature-256": signature ? sig : "sha256=bad",
      },
      body: data,
    });
  }
  async function push(sha: string) {
    return deliver("push", `push-${sha}`, { repository: { full_name: "fixture/project" }, ref: "refs/heads/main", after: sha });
  }
  const runOnce = () => new Promise<{ status: number | string; stdout: string; stderr: string }>(resolve => {
    execFile("python3", [controller, "--config", configPath, "--once", "--api", `http://127.0.0.1:${apiPort}`],
      { encoding: "utf8", env: controllerEnv }, (error, stdout, stderr) => {
        resolve({ status: error ? (error.code ?? 1) : 0, stdout, stderr });
      });
  });

  const badSignature = await deliver("push", "bad-signature", { repository: { full_name: "fixture/project" }, ref: "refs/heads/main", after: predecessor }, false);
  assert.equal(badSignature.status, 401);
  assert.equal((await push(predecessor)).status, 202);
  const sameShaPull = await deliver("pull_request", `pull-${predecessor}`, {
    action: "opened",
    repository: { full_name: "fixture/project" },
    pull_request: {
      base: { ref: "main", repo: { full_name: "fixture/project" } },
      head: { ref: "feature", sha: predecessor, repo: { full_name: "fixture/project", fork: false } },
    },
  });
  assert.equal(sameShaPull.status, 202);
  const firstRun = await runOnce();
  assert.equal(firstRun.status, 0, firstRun.stdout + firstRun.stderr);
  assert.deepEqual(readFileSync(launcherCalls, "utf8").trim().split("\n"), [`${predecessor} --runner fixture-runner`]);
  assert.equal(published.some(row => row.sha === predecessor && row.state === "success"), true);
  assert.equal(published.every(row => row.context === "infinite/cloud-check" && row.token === "Bearer controller-only-token"), true);
  assert.equal(published.every(row => !row.description.includes("fixture-runner")), true);
  const predecessorJob = JSON.parse(readFileSync(join(state, "jobs", readdirSync(join(state, "jobs")).find(name => name.endsWith(".json"))!), "utf8"));
  assert.deepEqual(predecessorJob.deliveries.map((item: { event: string }) => item.event).sort(), ["pull_request", "push"]);
  assert.equal(readFileSync(token, "utf8").trim(), "controller-only-token");

  const fork = await deliver("pull_request", "fork-pr", {
    action: "opened",
    repository: { full_name: "fixture/project" },
    pull_request: {
      base: { ref: "main", repo: { full_name: "fixture/project" } },
      head: { ref: "external", sha: predecessor, repo: { full_name: "attacker/project", fork: true } },
    },
  });
  assert.equal(fork.status, 400);
  const foreignRepo = await deliver("push", "foreign-repo", { repository: { full_name: "attacker/project" }, ref: "refs/heads/main", after: predecessor });
  assert.equal(foreignRepo.status, 400);
  const unlistedRef = await deliver("push", "unlisted-ref", { repository: { full_name: "fixture/project" }, ref: "refs/heads/release", after: predecessor });
  assert.equal(unlistedRef.status, 400);

  assert.equal((await push(failing)).status, 202);
  assert.equal((await runOnce()).status, 0);
  assert.equal(published.some(row => row.sha === failing && row.state === "failure"), true);
  assert.equal(published.some(row => row.sha === predecessor && row.state === "success"), true);
  assert.equal(readFileSync(launcherCalls, "utf8").trim().split("\n").length, 2);
  assert.equal(exists(join(dir, "hook-ran")), false);
  assert.equal(exists(filterMarker), false);

  rmSync(join(source, "fail.txt"));
  writeFileSync(join(source, "rotate-token.txt"), "credential rotates during verification\n");
  writeFileSync(join(source, "next.txt"), "newer source\n");
  git("add", "-u", "fail.txt");
  git("add", "rotate-token.txt");
  git("add", "next.txt");
  git("commit", "-qm", "newer revision");
  const newer = git("rev-parse", "HEAD");
  git("push", "-q", "origin", "HEAD:refs/heads/main");
  failOneSuccess = true;
  unavailablePendingSha = newer;
  assert.equal((await push(newer)).status, 202);
  const interrupted = await runOnce();
  assert.notEqual(interrupted.status, 0);
  assert.equal(published.some(row => row.sha === newer && row.state === "pending"), true);
  assert.equal(accepted.some(row => row.sha === newer && row.state === "pending"), false);
  const retry = await runOnce();
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(published.some(row => row.sha === newer && row.state === "success"), true);
  assert.equal(accepted.some(row => row.sha === newer && row.state === "success" && row.token === "Bearer controller-rotated-token"), true);
  assert.equal(readFileSync(launcherCalls, "utf8").trim().split("\n").length, 3);

  writeFileSync(join(source, "busy-timeout.txt"), "fixture marks pre-transfer capacity expiration\n");
  git("add", "busy-timeout.txt");
  git("commit", "-qm", "runner capacity wait");
  const busyHead = git("rev-parse", "HEAD");
  git("push", "-q", "origin", "HEAD:refs/heads/main");
  assert.equal((await push(busyHead)).status, 202);
  assert.equal((await runOnce()).status, 0);
  const busyJobPath = join(state, "jobs", readdirSync(join(state, "jobs")).find(name => name.endsWith(".json") && JSON.parse(readFileSync(join(state, "jobs", name), "utf8")).sha === busyHead)!);
  const busyJob = JSON.parse(readFileSync(busyJobPath, "utf8"));
  const firstBusyOutput = readFileSync(busyJobPath.replace(/\.json$/, ".log"));
  assert.equal(busyJob.attempts, 1);
  assert.equal(busyJob.admissionWaits, 1);
  assert.equal(busyJob.result, undefined);
  assert.equal(busyJob.outputBytes, firstBusyOutput.length);
  assert.equal(firstBusyOutput.toString(), [
    ...Array(2).fill("Dispatch to fixture-runner (archive SHA-256 " + "a".repeat(64) + ")\nRunner fixture-runner is busy; checkout not sent\n"),
    "cloud-check: workspace runner pool remained busy until the capacity wait expired\n",
  ].join(""));
  busyJob.result = "error";
  busyJob.description = "Cloud verification could not complete";
  busyJob.error = "RevisionError: cloud launcher returned no receipt";
  busyJob.completedAt = 1;
  busyJob.publishedResult = "error";
  accepted.push({ sha: busyHead, state: "error", token: "Bearer controller-only-token" });
  published.push({ sha: busyHead, state: "error", context: "infinite/cloud-check", token: "Bearer controller-only-token", description: busyJob.description });
  delete busyJob.admissionWaits;
  writeFileSync(busyJobPath, JSON.stringify(busyJob));
  const busyLogPath = busyJobPath.replace(/\.json$/, ".log");
  writeFileSync(busyLogPath, firstBusyOutput.subarray(0, firstBusyOutput.length - 2));
  assert.equal((await runOnce()).status, 0);
  assert.equal(JSON.parse(readFileSync(busyJobPath, "utf8")).result, "error");
  writeFileSync(busyLogPath, Buffer.concat([firstBusyOutput.subarray(0, -1), Buffer.from("!")]));
  assert.equal((await runOnce()).status, 0);
  assert.equal(JSON.parse(readFileSync(busyJobPath, "utf8")).result, "error");
  writeFileSync(busyLogPath, firstBusyOutput);
  const archivedBusyLog = busyJobPath.replace(/\.json$/, ".terminal.log");
  writeFileSync(archivedBusyLog, "corrupt archived evidence\n");
  assert.notEqual((await runOnce()).status, 0);
  assert.equal(JSON.parse(readFileSync(busyJobPath, "utf8")).result, "error");
  rmSync(archivedBusyLog);
  const pendingCountBeforeRecovery = published.filter(row => row.sha === busyHead && row.state === "pending").length;
  assert.equal((await runOnce()).status, 0);
  const recoveredJob = JSON.parse(readFileSync(busyJobPath, "utf8"));
  assert.equal(recoveredJob.result, undefined);
  assert.equal(recoveredJob.attempts, 2);
  assert.equal(recoveredJob.admissionWaits, 2);
  assert.equal(recoveredJob.terminalEvidence.result, "error");
  assert.equal(recoveredJob.terminalEvidence.error, "RevisionError: cloud launcher returned no receipt");
  assert.deepEqual(readFileSync(busyJobPath.replace(/\.json$/, ".terminal.log")), firstBusyOutput);
  assert.equal(published.filter(row => row.sha === busyHead && row.state === "pending").length, pendingCountBeforeRecovery + 1);
  writeFileSync(capacityOpen, "operator confirms runner capacity is available\n");
  assert.equal((await runOnce()).status, 0);
  const completedBusyJob = JSON.parse(readFileSync(busyJobPath, "utf8"));
  assert.equal(completedBusyJob.result, "success");
  assert.equal(completedBusyJob.publishedResult, "success");
  assert.equal(published.some(row => row.sha === busyHead && row.state === "success"), true);
  assert.equal(accepted.some(row => row.sha === busyHead && row.state === "success"), true);
  assert.equal(readFileSync(launcherCalls, "utf8").trim().split("\n").length, 6);

  rmSync(capacityOpen);
  writeFileSync(join(source, "extra-output.txt"), "capacity text with unrelated output\n");
  git("add", "extra-output.txt");
  git("commit", "-qm", "extra output is not admission proof");
  const extraOutputHead = git("rev-parse", "HEAD");
  git("push", "-q", "origin", "HEAD:refs/heads/main");
  assert.equal((await push(extraOutputHead)).status, 202);
  assert.equal((await runOnce()).status, 0);
  assert.equal(published.some(row => row.sha === extraOutputHead && row.state === "error"), true);

  writeFileSync(capacityOpen, "operator confirms runner capacity is available\n");
  writeFileSync(join(source, "ambiguous-receipt.txt"), "capacity text with a receipt present\n");
  git("add", "ambiguous-receipt.txt");
  git("commit", "-qm", "receipt blocks admission retry");
  const ambiguousReceiptHead = git("rev-parse", "HEAD");
  git("push", "-q", "origin", "HEAD:refs/heads/main");
  assert.equal((await push(ambiguousReceiptHead)).status, 202);
  assert.equal((await runOnce()).status, 0);
  assert.equal(published.some(row => row.sha === ambiguousReceiptHead && row.state === "error"), true);

  rmSync(join(source, "busy-timeout.txt"));
  rmSync(join(source, "extra-output.txt"));
  rmSync(join(source, "ambiguous-receipt.txt"));
  git("add", "-u");
  git("commit", "-qm", "remove runner capacity fixtures");
  git("push", "-q", "origin", "HEAD:refs/heads/main");

  for (const marker of ["no-receipt.txt", "wrong-receipt.txt", "stale-receipt.txt"]) {
    if (marker === "wrong-receipt.txt") {
      rmSync(join(source, "no-receipt.txt"));
      git("add", "-u", "no-receipt.txt");
    }
    if (marker === "stale-receipt.txt") {
      rmSync(join(source, "wrong-receipt.txt"));
      git("add", "-u", "wrong-receipt.txt");
    }
    writeFileSync(join(source, marker), "receipt rejection fixture\n");
    git("add", marker);
    git("commit", "-qm", `invalid ${marker}`);
    const badReceiptHead = git("rev-parse", "HEAD");
    git("push", "-q", "origin", "HEAD:refs/heads/main");
    assert.equal((await push(badReceiptHead)).status, 202);
    assert.equal((await runOnce()).status, 0);
    assert.equal(published.some(row => row.sha === badReceiptHead && row.state === "error"), true);
    assert.equal(published.some(row => row.sha === badReceiptHead && row.state === "success"), false);
  }
  assert.equal(readFileSync(launcherCalls, "utf8").trim().split("\n").length, 11);

  const foreignOrigin = { ...config, origin: join(dir, "another-project.git") };
  writeFileSync(configPath, JSON.stringify(foreignOrigin), { mode: 0o600 });
  const refusesForeignOrigin = await runOnce();
  assert.equal(refusesForeignOrigin.status, 2);
  assert.match(refusesForeignOrigin.stderr, /enrollment changed/);
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const changedCommand = { ...config, mode: "command", command: ["node", "-e", "different verifier"] };
  writeFileSync(configPath, JSON.stringify(changedCommand), { mode: 0o600 });
  const refusesContextReuse = await runOnce();
  assert.equal(refusesContextReuse.status, 2);
  assert.match(refusesContextReuse.stderr, /enrollment changed/);
  const newStateSameContext = { ...config, mode: "command", command: ["npm", "test"], stateDirectory: join(dir, "alternate-state") };
  writeFileSync(configPath, JSON.stringify(newStateSameContext), { mode: 0o600 });
  const refusesContextReuseAcrossState = await runOnce();
  assert.equal(refusesContextReuseAcrossState.status, 2);
  assert.match(refusesContextReuseAcrossState.stderr, /status context is already bound/);
});

function respond(res: ServerResponse, status: number, text: string, contentType = "text/plain") {
  res.writeHead(status, { "content-type": contentType });
  res.end(text);
}

function exists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
