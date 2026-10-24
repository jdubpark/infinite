import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

if (process.argv[2] === "--command-prefix") {
  const [, receiptDir, command, ...args] = process.argv.slice(2);
  appendFileSync(join(receiptDir, "commands.jsonl"), JSON.stringify({ command, args, cwd: process.cwd() }) + "\n", { mode: 0o600 });
  const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, INFINITE_TEST_COMMAND_IDENTITY: "team-prefix" } });
  child.once("error", () => process.exit(127));
  child.once("exit", code => process.exit(code ?? 128));
  await new Promise(() => {});
}
if (process.argv[2] === "--mirror-restricted-prefix") {
  // Models the deployed launcher: inside a bare source mirror only the pinned base-branch fetch and rev-parse run.
  const [, receiptDir, command, ...args] = process.argv.slice(2);
  const gitSubcommand = () => {
    let index = 0;
    while (args[index] === "-c" || args[index] === "-C") index += 2;
    return args[index];
  };
  const inBareRepository = () => {
    for (let directory = realpathSync(process.cwd()); ; directory = dirname(directory)) {
      const config = join(directory, "config");
      if (existsSync(config) && /bare\s*=\s*true/.test(readFileSync(config, "utf8"))) return true;
      if (dirname(directory) === directory) return false;
    }
  };
  if (command === "git" && inBareRepository() && !["fetch", "rev-parse"].includes(gitSubcommand())) {
    appendFileSync(join(receiptDir, "mirror-commands.jsonl"), JSON.stringify({ cwd: process.cwd(), args, refused: true }) + "\n", { mode: 0o600 });
    process.stderr.write("team-command: only the pinned base-branch fetch and rev-parse are permitted in a source mirror\n");
    process.exit(126);
  }
  const child = spawn(command, args, { stdio: "inherit", env: process.env });
  child.once("error", () => process.exit(127));
  child.once("exit", code => process.exit(code ?? 128));
  await new Promise(() => {});
}
if (process.argv[2] === "--retirement-fail-prefix") {
  const [, receiptDir, workerPid, command, ...args] = process.argv.slice(2);
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    let request;
    try { request = JSON.parse(input); } catch { process.exit(74); }
    if (request.op === "uid") {
      const counter = join(receiptDir, "retirement-probe-count");
      const count = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;
      writeFileSync(counter, String(count));
      if (count === 3) {
        writeFileSync(join(receiptDir, "retirement-before-signals"), "ready");
        const deadline = Date.now() + 5000;
        while (!existsSync(join(receiptDir, "retirement-allow-signals")) && Date.now() < deadline)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    if (request.op === "signal") {
      writeFileSync(join(receiptDir, "retirement-failed-after-worker-exit"), "failed once", { mode: 0o600 });
      writeFileSync(join(receiptDir, "retirement-expand-tree"), "expand", { mode: 0o600 });
      const deadline = Date.now() + 3000;
      while (!existsSync(join(receiptDir, "retirement-discovered-pid.json")) && Date.now() < deadline)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      try { process.kill(Number(workerPid), "SIGKILL"); } catch { /* Simulates a lost stop acknowledgement after worker exit. */ }
      process.stderr.write("Injected a lost retirement acknowledgement after worker exit.\n");
      process.exit(73);
    }
    const result = spawnSync(command, args, { input, encoding: "utf8", env: process.env });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 128);
  });
  await new Promise(() => {});
}
if (process.argv[2] === "--permission-setup") {
  appendFileSync(join(process.argv[3], "permission-setup.jsonl"), JSON.stringify({ cwd: process.cwd() }) + "\n", { mode: 0o600 });
  process.exit(0);
}
if (process.argv[2] === "--bootstrap-setup") {
  if (!existsSync("check.mjs")) throw new Error("The implemented check file is missing");
  const check = readFileSync("check.mjs", "utf8");
  if (process.argv[3] !== "bootstrap-fail" && !check.includes("a.txt"))
    throw new Error("The implemented check does not cover the requested files");
  process.stdout.write("Bootstrap setup completed.\n");
  process.exit(0);
}
if (process.argv[2] === "--hold-check") {
  const receiptDir = process.argv[3];
  writeFileSync(join(receiptDir, "check-ready.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  const until = Date.now() + 30000;
  while (!existsSync(join(receiptDir, "check-release"))) {
    if (Date.now() >= until) process.exit(19);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  process.exit(0);
}

// A real child process reports through its worker's authenticated report
// channel. The receipt directory only coordinates concurrent fixture processes;
// the runner must discover results, commits, and check outcomes through production paths.
const [scenario, receiptDir] = process.argv.slice(2);
const assignment = JSON.parse(process.env.INFINITE_TEAM_ASSIGNMENT ?? "null");
if (scenario === "stall-slow-stop" || scenario === "agent-blocked-once") process.on("SIGTERM", () => setTimeout(() => process.exit(0), 2000));
if (!assignment || !process.env.INFINITE_HOOK_URL || !process.env.INFINITE_HOOK_TOKEN)
  throw new Error("The team worker did not provide its reporting capability");
const receiptFile = join(receiptDir, `${assignment.memberId}.json`);
// Peers poll this directory while members run. Replace a receipt whole, never truncate it in place.
function saveReceipt() {
  writeFileSync(`${receiptFile}.tmp`, JSON.stringify(receipt), { mode: 0o600 });
  renameSync(`${receiptFile}.tmp`, receiptFile);
}
const providerIndex = process.argv.indexOf("--fixture-provider");
const receipt = { ...assignment, cwd: process.cwd(), pid: process.pid, startedAt: Date.now(),
  ...(process.env.INFINITE_TRUSTED_WORKSPACE ? { trustedWorkspace: process.env.INFINITE_TRUSTED_WORKSPACE } : {}),
  ...(providerIndex >= 0 ? { provider: process.argv[providerIndex + 1], argv: process.argv.slice(2) } : {}) };
if (receipt.provider === "opencode") {
  const args = process.argv.slice(providerIndex + 2), boundary = args.indexOf("--");
  if (args[0] !== "run" || boundary < 1 || boundary !== args.length - 2
    || args.slice(0, boundary).some(arg => ["--prompt", "--effort", "-c"].includes(arg)))
    throw new Error("OpenCode needs run mode with one positional prompt, not TUI or Codex arguments");
  const format = args.indexOf("--format");
  if (format < 1 || format >= boundary - 1 || args[format + 1] !== "json")
    throw new Error("OpenCode team members must run with --format json so usage is reported");
  const model = args.indexOf("--model"), variant = args.indexOf("--variant");
  if (model < 1 || model >= boundary - 1 || !args[model + 1].includes("/"))
    throw new Error("OpenCode requires a provider/model selection");
  receipt.model = args[model + 1];
  if (variant >= 0) {
    if (variant >= boundary - 1) throw new Error("OpenCode variant has no value");
    receipt.variant = args[variant + 1];
  }
  receipt.prompt = args[boundary + 1];
  if (scenario === "integrator-limit" && assignment.role === "integrator")
    receipt.sawPartial = existsSync("repair.txt");
} else if (receipt.provider === "codex") {
  receipt.prompt = process.argv.at(-1);
}
// A limit fallback must start in the limited member's working copy, partial file included.
if (scenario.startsWith("limit")) receipt.sawPartial = existsSync("a.txt");
saveReceipt();

async function report(value, overrides = {}) {
  if (receipt.provider === "codex") {
    const settings = new Map();
    const args = process.argv.slice(providerIndex + 2);
    for (let index = 0; index < args.length - 1; index++) {
      if (args[index] === "-c" && args[index + 1].startsWith("mcp_servers.infinite_team.")) {
        const item = args[++index].slice("mcp_servers.infinite_team.".length), equals = item.indexOf("=");
        settings.set(item.slice(0, equals), JSON.parse(item.slice(equals + 1)));
      }
    }
    if (settings.get("tools.report.approval_mode") !== "approve") throw new Error("Codex needs the approved team report tool");
    // Only the variables Codex forwards through env_vars reach the server, so broken forwarding fails here.
    const environment = Object.fromEntries(settings.get("env_vars").map(name => [name, process.env[name]]));
    const server = spawn(settings.get("command"), settings.get("args"), { stdio: ["pipe", "pipe", "inherit"], env: { PATH: process.env.PATH ?? "", ...environment } });
    const lines = createInterface({ input: server.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    let id = 0;
    const request = async (method, params) => {
      const requestId = ++id;
      server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, ...(params === undefined ? {} : { params }) }) + "\n");
      const next = await iterator.next();
      if (next.done) throw new Error("The Codex team MCP server stopped before its receipt");
      const response = JSON.parse(next.value);
      if (response.id !== requestId || response.error) throw new Error(response.error?.message ?? "The Codex team MCP response did not match its request");
      return response.result;
    };
    try {
      await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "team-fixture", version: "1.0.0" } });
      server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const listed = await request("tools/list");
      if (!listed.tools.some(tool => tool.name === "report")) throw new Error("The Codex team MCP server did not expose report");
      const result = await request("tools/call", { name: "report", arguments: { report: value } });
      if (result.isError || result.structuredContent?.memberId !== assignment.memberId)
        throw new Error(result.content?.[0]?.text ?? "The Codex team report was not confirmed");
      server.stdin.end();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.once("exit", code => code === 0 ? resolve() : reject(new Error(`Codex team MCP server exited with ${code}`)));
      });
      lines.close();
      return;
    } catch (error) {
      server.kill();
      lines.close();
      throw error;
    }
  }
  const response = await fetch(`${process.env.INFINITE_HOOK_URL}/team-report`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.INFINITE_HOOK_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: randomUUID(), runId: assignment.runId,
      memberId: assignment.memberId, revision: assignment.revision, report: value, ...overrides }),
  });
  if (!response.ok && Object.keys(overrides).length === 0) {
    const detail = await response.text();
    throw new Error(`Team report was refused with status ${response.status}${detail ? `: ${detail}` : ""}`);
  }
}

async function waitForPeer() {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const peers = readdirSync(receiptDir).filter(name => name.endsWith(".json"))
      .map(name => JSON.parse(readFileSync(join(receiptDir, name), "utf8")))
      .filter(value => value.runId === assignment.runId && value.revision === assignment.revision && value.role === "implementer");
    if (new Set(peers.map(value => value.taskId)).size >= 2) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error("Independent implementers did not overlap");
}

async function main() {
  process.stdin.resume();
  if (scenario === "mcp" || scenario === "stall-slow-stop") {
    // A private runtime receipt lets the test drive the actual worker capability
    // through a separate MCP child. It never enters a repository or API response.
    writeFileSync(join(receiptDir, "mcp-capability.json"), JSON.stringify({ assignment,
      url: process.env.INFINITE_HOOK_URL, token: process.env.INFINITE_HOOK_TOKEN }), { mode: 0o600 });
    return;
  }
  if (scenario === "unreported") {
    await report({ kind: "plan", summary: "A foreign report must not become a plan", tasks: [
      { id: "foreign", title: "Foreign task", instructions: "Do not schedule this task", paths: ["foreign.txt"], dependsOn: [] },
    ] }, { memberId: randomUUID() });
    await report({ kind: "result", summary: "An old revision must not finish this member" }, { revision: assignment.revision + 1 });
    process.stdout.write("Task complete. All checks passed.\n");
    process.exit(0);
  }
  if (assignment.role === "project-manager") {
    if (scenario === "no-change") {
      await report({ kind: "no-change", summary: "The requested behavior already exists in the inspected project.", evidence: [
        { source: "Current implementation", observation: "The accepted behavior is already implemented and the required check covers it." },
      ] });
      return;
    }
    if (scenario === "limit" && !existsSync(join(receiptDir, "limit-owner-question-asked"))) {
      writeFileSync(join(receiptDir, "limit-owner-question-asked"), "asked", { mode: 0o600 });
      await report({ kind: "question", question: "Which display label should the first file use?", options: ["Detailed", "Compact"] });
      return;
    }
    if (scenario.startsWith("agent-blocked-") && assignment.revision > 1) {
      await report({ kind: "plan", summary: "Replan the blocked assignment while retaining the independent report as evidence", tasks: [
        { id: "a", title: "Build the first file", instructions: "Write a.txt with the current revision", paths: ["a.txt"], dependsOn: [] },
        { id: "b", title: "Build the second file", instructions: "Write b.txt with the current revision", paths: ["b.txt"], dependsOn: [] },
      ] });
      return;
    }
    if ((scenario === "bootstrap-replan" || scenario === "bootstrap-change") && assignment.revision === 2) {
      const recoveryQuestion = join(receiptDir, `${assignment.runId}.bootstrap-recovery-asked`);
      if (!existsSync(recoveryQuestion)) {
        writeFileSync(recoveryQuestion, "asked", { mode: 0o600 });
        await report({ kind: "question", question: "Should the already accepted verification remain mandatory for this work?", options: ["Keep it mandatory", "Review it after replanning"] });
        return;
      }
    }
    if (scenario === "mixed" && assignment.revision > 1) {
      const recoveryQuestion = join(receiptDir, `${assignment.runId}.mixed-recovery-asked`);
      if (!existsSync(recoveryQuestion)) {
        writeFileSync(recoveryQuestion, "asked", { mode: 0o600 });
        await report({ kind: "question", question: "Which display label should the second file use?", options: ["Detailed", "Compact"] });
        return;
      }
    }
    if (scenario === "mixed" && assignment.revision === 1) {
      const response = await fetch(`${process.env.INFINITE_HOOK_URL}/claude`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.INFINITE_HOOK_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Read", tool_input: { file_path: "original.txt" } }),
      });
      if (response.status !== 204) throw new Error(`Provider permission hook was refused with status ${response.status}`);
      const until = Date.now() + 30000;
      while (!existsSync(join(receiptDir, `${assignment.memberId}.permission-release`))) {
        if (Date.now() >= until) throw new Error("The test did not release the provider permission wait");
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    }
    const asked = join(receiptDir, `${assignment.runId}.asked`);
    if (scenario === "question" && !existsSync(asked)) {
      writeFileSync(asked, "asked", { mode: 0o600 });
      await report({ kind: "question", question: "Which display label should the implementation use?", options: ["Detailed", "Compact"] });
      return;
    }
    const tasks = [
      { id: "a", title: "Build the first file", instructions: "Write a.txt with the current revision", paths: scenario === "delivery-base-recovery" ? ["a.txt", "README.md"] : ["a.txt"], dependsOn: [] },
      { id: "b", title: "Build the second file", instructions: "Write b.txt with the current revision", paths: ["b.txt"], dependsOn: [] },
    ];
    if (scenario === "mixed") tasks[1].dependsOn = ["a"];
    if (scenario === "scale-up") tasks.push({ id: "c", title: "Build the third file", instructions: "Write c.txt with the current revision", paths: ["c.txt"], dependsOn: [] });
    if (scenario.startsWith("bootstrap")) tasks[0].paths.push("check.mjs");
    if (scenario === "usage") {
      tasks[0].agentProfileId = "spark-high";
      tasks[1].agentProfileId = "deepseek-high";
    } else if (scenario === "mixed") {
      tasks[0].agentProfileId = "spark-high";
      tasks[1].agentProfileId = "astra-xhigh";
    } else if (scenario.startsWith("permissions") || scenario.startsWith("delivery") || scenario === "integrator-limit" || scenario === "result-operation-fails-once") {
      tasks[0].agentProfileId = scenario.startsWith("permissions-codex") ? "codex-light" : "haiku";
      tasks[1].agentProfileId = scenario.startsWith("permissions-codex") ? "haiku" : "codex-light";
    } else if (scenario.startsWith("limit")) {
      tasks[0].agentProfileId = "haiku";
      tasks[1].agentProfileId = "astra-light";
    } else if (scenario === "mixed-invalid") {
      // The first task is valid: rejection must inspect the whole plan before
      // dispatching any member, including work preceding the invalid choice.
      tasks[0].agentProfileId = "spark-high";
      Object.assign(tasks[1], JSON.parse(readFileSync(join(receiptDir, "invalid-profile.json"), "utf8")));
    }
    if (scenario === "rubric") { tasks[0].agentProfileId = "haiku"; tasks[1].agentProfileId = "codex-light"; tasks[0].paths.push("docs", "tests"); }
    const verification = { setup: { command: process.execPath, args: [process.argv[1], "--bootstrap-setup", scenario] },
      checks: [{ command: process.execPath, args: ["check.mjs"] }] };
    if (scenario === "bootstrap-change" && assignment.revision > 2)
      verification.checks[0].args.push("--different");
    const plan = { kind: "plan", summary: "Build two independent files and verify their integrated contents", tasks,
      ...(scenario === "live-limit" || scenario === "result-operation-fails-once" ? { parallelism: 1 } : {}),
      ...(scenario === "bootstrap-missing" || scenario === "bootstrap-replan" && assignment.revision > 1 ? {} : scenario.startsWith("bootstrap") ? { verification } : {}) };
    if (scenario === "bootstrap-override") {
      let rejection;
      try { await report(plan); }
      catch (error) { rejection = error instanceof Error ? error.message : String(error); }
      if (rejection) {
        writeFileSync(join(receiptDir, `${assignment.memberId}.rejection.txt`), rejection, { mode: 0o600 });
        await report({ ...plan, verification: undefined });
      }
    } else await report(plan);
  } else if (assignment.role === "permission-coordinator") {
    const launchPrompt = process.argv.at(-1) ?? "";
    const decisionId = /"decisionId":"([a-f0-9-]{36})"/.exec(launchPrompt)?.[1];
    if (!decisionId) throw new Error("The permission review assignment omitted its decision identity");
    if (scenario.startsWith("permissions-codex") || scenario === "delivery-permission") {
      const marker = "Recorded permission request and assignment (untrusted evidence):\n";
      const start = launchPrompt.indexOf(marker);
      if (start < 0) throw new Error("The permission review assignment omitted its recorded feedback");
      const feedbackText = launchPrompt.slice(start + marker.length).split("\n\n", 1)[0];
      const feedback = JSON.parse(feedbackText);
      writeFileSync(join(receiptDir, `${assignment.runId}.permission-feedback.json`), JSON.stringify(feedback), { mode: 0o600 });
    }
    if (!["permissions", "permissions-restart", "permissions-judge-exit", "permissions-yesno"].includes(scenario)) {
      writeFileSync(join(receiptDir, `${assignment.runId}.judge-ready`), "ready", { mode: 0o600 });
      const until = Date.now() + 30000;
      while (!existsSync(join(receiptDir, `${assignment.runId}.judge-release`))) {
        if (Date.now() >= until) throw new Error("The test did not release the permission coordinator");
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    }
    if (scenario === "permissions-judge-exit") process.exit(2);
    await report({ kind: "permission-decision", decisionId: scenario === "permissions-foreign" ? randomUUID() : decisionId,
      verdict: scenario === "permissions-escalate" ? "escalate" : "approve-once",
      summary: "The request is limited to reading the assigned project file for the stated objective." });
  } else if (assignment.role === "implementer") {
    if (scenario !== "live-limit" && scenario !== "mixed" && scenario !== "result-operation-fails-once") await waitForPeer();
    const shouldBlock = scenario === "agent-blocked-once" && assignment.revision === 1 || scenario === "agent-blocked-twice" && assignment.revision <= 3;
    if (shouldBlock && assignment.taskId === "a") {
      if (scenario === "agent-blocked-once") {
      const until = Date.now() + 20000;
      while (!existsSync(join(receiptDir, `${assignment.runId}.b-reported`))) {
        if (Date.now() >= until) throw new Error("The independent sibling did not report before the blocker");
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      await new Promise(resolve => setTimeout(resolve, 250));
      }
      await report({ kind: "blocked", summary: "The first assignment hit a recoverable worker issue." });
      return;
    }
    if (scenario === "agent-blocked-once" && assignment.revision === 1 && assignment.taskId === "b") {
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    if (scenario === "scale-up" && assignment.taskId === "a") {
      const until = Date.now() + 20000;
      while (!readdirSync(receiptDir).filter(name => name.endsWith(".json"))
        .map(name => JSON.parse(readFileSync(join(receiptDir, name), "utf8")))
        .some(value => value.runId === assignment.runId && value.revision === assignment.revision && value.role === "implementer" && value.taskId === "c")) {
        if (Date.now() >= until) throw new Error("Task c did not start before task a finished");
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    }
    if (scenario === "live-limit" && assignment.taskId === "a") {
      writeFileSync(join(receiptDir, `${assignment.runId}.a-started`), "started", { mode: 0o600 });
      const until = Date.now() + 30000;
      while (!existsSync(join(receiptDir, `${assignment.runId}.release`))) {
        if (Date.now() >= until) throw new Error("The test did not release the first implementer");
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    }
    const asked = join(receiptDir, `${assignment.runId}.${assignment.taskId}.asked`);
    if ((scenario === "mixed" || (scenario === "bootstrap-replan" || scenario === "bootstrap-change") && assignment.revision === 1) && assignment.taskId === "b" && !existsSync(asked)) {
      writeFileSync(asked, "asked", { mode: 0o600 });
      await report({ kind: "question", question: "Which display label should the second file use?", options: ["Detailed", "Compact"] });
      return;
    }
    if (scenario.startsWith("limit") && receipt.provider === "claude" && receipt.argv[receipt.argv.indexOf("--model") + 1] === "claude-haiku-5-5") {
      // Partial work, then Claude Code's limit notice and its StopFailure hook. The notice comes
      // first so the hook arrives as its corroboration: a hook alone switches the member before a
      // later notice could record the host-level limit. The member idles without reporting.
      // The stated reset is two hours ahead of this clock (read as UTC), so it is never in the past.
      writeFileSync("a.txt", "partial\n");
      const reset = new Date(Date.now() + 2 * 3600_000); reset.setUTCSeconds(0, 0);
      const hour = reset.getUTCHours();
      receipt.limitNotice = `You've hit your session limit · resets ${hour % 12 || 12}:${String(reset.getUTCMinutes()).padStart(2, "0")}${hour < 12 ? "am" : "pm"}`;
      receipt.expectedResetsAt = reset.toISOString();
      saveReceipt();
      process.stdout.write(`${receipt.limitNotice}\n`);
      await new Promise(resolve => setTimeout(resolve, 500));
      const response = await fetch(`${process.env.INFINITE_HOOK_URL}/claude`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.INFINITE_HOOK_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ hook_event_name: "StopFailure", error: "rate_limit" }),
      });
      if (response.status !== 204) throw new Error(`StopFailure hook was refused with status ${response.status}`);
      return;
    }
    if (scenario === "question") {
      while (!existsSync(join(receiptDir, `${assignment.runId}.release`)))
        await new Promise(resolve => setTimeout(resolve, 40));
    }
    if (scenario.startsWith("permissions-codex") && assignment.taskId === "a") {
      writeFileSync("a.txt", "draft before the permission request\n");
      const waitFor = async (name, what) => {
        const until = Date.now() + 30000;
        while (!existsSync(join(receiptDir, `${assignment.runId}.${name}`))) {
          if (Date.now() >= until) throw new Error(`The test did not ${what}`);
          await new Promise(resolve => setTimeout(resolve, 40));
        }
      };
      if (["permissions-codex-profile-missing", "permissions-codex-realpath"].includes(scenario)) {
        writeFileSync(join(receiptDir, `${assignment.runId}.target-ready`), "ready", { mode: 0o600 });
        await waitFor("target-release", "release the Codex permission prompt");
      }
      if (scenario === "permissions-codex-evidence-change")
        writeFileSync(join(receiptDir, `${assignment.runId}.target-ready`), "ready", { mode: 0o600 });
      // The Codex 0.163 command dialog layout: pinned under the transcript, key hint on the last row.
      // Every line fits 80 columns, so the `$` line is always row 11 and the options rows 14-16.
      const options = ["1. Yes, proceed (y)", "2. Yes, and don't ask again for commands that start with `npm run check` (p)",
        "3. No, and tell Codex what to do differently (esc)"];
      const optionRows = marker => options.map((label, index) => `${index === marker ? "›" : " "} ${label}`);
      let marker = scenario === "permissions-codex-midway" ? 2 : 0;
      // Like the real TUI, read keys as they arrive and without echo.
      if (scenario === "permissions-codex-midway") process.stdin.setRawMode(true);
      process.stdout.write([
        "\u001b[2J\u001b[H• Running npm run check", "", "",
        "  Would you like to run the following command?", "",
        "  Environment: local", "",
        "  Reason: May I run npm run check outside the sandbox? Its tsx test runner",
        "  needs a local IPC socket that the sandbox blocks.", "",
        "  $ npm run check", "", "",
        ...optionRows(marker), "",
        "  Press enter to confirm or esc to cancel",
      ].join("\r\n"));
      if (scenario === "permissions-codex-respace") {
        // Spacing inside a line is outside the screen hash: the reviewed command must still not be answered.
        writeFileSync(join(receiptDir, `${assignment.runId}.target-ready`), "ready", { mode: 0o600 });
        await waitFor("target-change", "change the Codex command");
        process.stdout.write("\u001b[11;1H\u001b[2K  $ npm run  check");
      }
      for (;;) {
        const input = String(await new Promise(resolve => process.stdin.once("data", resolve)));
        if (scenario === "permissions-codex-evidence-change")
          writeFileSync(join(receiptDir, `${assignment.runId}.target-key`), input, { mode: 0o600 });
        if (scenario !== "permissions-codex-midway") break;
        if (input.includes("\r")) { writeFileSync(join(receiptDir, `${assignment.runId}.enter`), "enter", { mode: 0o600 }); break; }
        // The first arrow redraws the command with other spacing in the same write that moves the
        // marker, so the answer reaches its chosen option only on a screen that no longer matches.
        marker = Math.max(0, marker - (input.match(/\u001b[[O]A/g)?.length ?? 0));
        process.stdout.write(`\u001b[11;1H\u001b[2K  $ npm run  check${optionRows(marker).map((row, index) => `\u001b[${14 + index};1H\u001b[2K${row}`).join("")}`);
      }
      process.stdout.write("\u001b[2J\u001b[HPermission request closed.\n");
    } else if (scenario.startsWith("permissions") && assignment.taskId === "a") {
      const menu = scenario === "permissions-restart"
        ? `\nBash command\ncat original.txt\nDo you want to proceed?\n${Array.from({ length: 8 }, (_, index) => `  ${index + 1}. No, stop`).join("\n")}\n❯ 9. Yes\n`
        : scenario === "permissions-yesno" ? "\nRun this command? [Y/n] "
          : "\nBash command\ncat original.txt\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again for Bash commands\n  3. No, and tell Claude what to do differently (esc)\n";
      process.stdout.write(`\u001b[2J\u001b[H${menu}`);
      await new Promise(resolve => setTimeout(resolve, 200));
      const response = await fetch(`${process.env.INFINITE_HOOK_URL}/claude`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.INFINITE_HOOK_TOKEN}`, "Content-Type": "application/json" },
        // A hook correlates with a yes-no line only when its command text is that line.
        body: JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash",
          tool_input: { command: scenario === "permissions-yesno" ? "Run this command? [Y/n]" : "cat original.txt" } }),
      });
      if (response.status !== 204) throw new Error(`Provider permission hook was refused with status ${response.status}`);
      if (scenario === "permissions-stale") {
        writeFileSync(join(receiptDir, `${assignment.runId}.target-ready`), "ready", { mode: 0o600 });
        const until = Date.now() + 30000;
        while (!existsSync(join(receiptDir, `${assignment.runId}.target-change`))) {
          if (Date.now() >= until) throw new Error("The test did not change the permission prompt");
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        process.stdout.write("\u001b[2J\u001b[H");
        await new Promise(resolve => setTimeout(resolve, 250));
        const closed = await fetch(`${process.env.INFINITE_HOOK_URL}/claude`, {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.INFINITE_HOOK_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ hook_event_name: "PermissionDenied", reason: "The fixture changed the pending request" }),
        });
        if (closed.status !== 204) throw new Error(`Provider prompt change was refused with status ${closed.status}`);
      }
      await new Promise(resolve => process.stdin.once("data", resolve));
      if (scenario === "permissions-restart") await new Promise(resolve => setTimeout(resolve, 5000));
      process.stdout.write("\u001b[2J\u001b[HPermission request closed.\n");
    }
    if (scenario.startsWith("bootstrap") && assignment.taskId === "a") {
      const check = scenario === "bootstrap-fail"
        ? 'console.error("Coordinator check failed"); process.exit(17);'
        : [
          'import assert from "node:assert/strict";',
          'import { readFileSync } from "node:fs";',
          'assert.equal(readFileSync("a.txt", "utf8"), readFileSync("b.txt", "utf8"));',
        ].join("\n");
      writeFileSync("check.mjs", check + "\n");
    }
    // Keep both processes alive after the barrier so overlap can be measured
    // independently of the member states returned by the API.
    await new Promise(resolve => setTimeout(resolve, 150));
    const name = scenario === "scope-escape" && assignment.taskId === "a" ? " a.txt" : `${assignment.taskId}.txt`;
    writeFileSync(name, `revision ${assignment.revision}\n`);
    if (scenario === "delivery-base-recovery" && assignment.taskId === "a") {
      const readme = readFileSync("README.md", "utf8").trimEnd();
      writeFileSync("README.md", `${readme}\nTeam update revision ${assignment.revision}\n`);
    }
    if (scenario === "result-operation-fails-once" && assignment.revision === 1 && assignment.taskId === "a") {
      writeFileSync(join(receiptDir, "result-failure-ready.json"), JSON.stringify({ cwd: process.cwd(), memberId: assignment.memberId }), { mode: 0o600 });
      const until = Date.now() + 30000;
      while (!existsSync(join(receiptDir, "result-failure-report-release"))) {
        if (Date.now() >= until) throw new Error("The test did not release the first result report");
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    }
    if (scenario === "rubric" && assignment.taskId === "a") {
      mkdirSync("docs", { recursive: true }); mkdirSync("tests", { recursive: true });
      writeFileSync("docs/x.md", "Documentation evidence.\n");
      writeFileSync("tests/y.test.ts", "export {};\n");
    }
    if (scenario === "usage" && receipt.provider === "opencode") {
      // The `opencode run --format json` stream: one line per part event, with a step-finish
      // part for each step of the assistant message, then unrelated plain text.
      const line = (type, part) => JSON.stringify({ type, timestamp: Date.now(), sessionID: "ses_fixture", part });
      const step = (n, cost, input, output) => line("step_finish", { type: "step-finish", id: `prt_${assignment.taskId}_${n}`,
        messageID: `msg_${assignment.taskId}`, sessionID: "ses_fixture", reason: "tool-calls", cost,
        tokens: { input, output, reasoning: 0, cache: { read: 1, write: 1 } } });
      process.stdout.write([
        line("text", { type: "text", id: `prt_${assignment.taskId}_0`, messageID: `msg_${assignment.taskId}`, sessionID: "ses_fixture", text: "Working." }),
        line("tool_use", { type: "tool", id: `prt_${assignment.taskId}_t`, messageID: `msg_${assignment.taskId}`, sessionID: "ses_fixture", tool: "bash",
          callID: `call_${assignment.taskId}`, state: { status: "completed", input: { command: "ls" }, output: "a.txt" } }),
        step(1, 0.1, 400, 100),
        step(2, 0.4, 600, 400),
        "Implementation notes follow.",
      ].join("\n") + "\n");
    }
    receipt.finishedAt = Date.now();
    saveReceipt();
    await report({ kind: "result", summary: `Implemented ${assignment.taskId}.txt` });
    if (scenario === "agent-blocked-once" && assignment.revision === 1 && assignment.taskId === "b") {
      writeFileSync(join(receiptDir, `${assignment.runId}.b-reported`), "reported", { mode: 0o600 });
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  } else if (assignment.role === "integrator") {
    if (scenario === "delivery-base-recovery") {
      const launchPrompt = receipt.prompt ?? process.argv.at(-1) ?? "";
      const originalWorkspace = /The original integration copy is preserved at ([^\r\n]+?) \(workspace path /.exec(launchPrompt)?.[1];
      if (!originalWorkspace || !existsSync(join(originalWorkspace, "a.txt")) || !existsSync(join(originalWorkspace, "b.txt")))
        throw new Error("The delivery recovery integrator could not read the preserved implementation workspace");
      for (const name of ["a.txt", "b.txt"])
        writeFileSync(name, readFileSync(join(originalWorkspace, name)));
      const upstreamReadme = readFileSync("README.md", "utf8").trimEnd();
      const priorReadme = readFileSync(join(originalWorkspace, "README.md"), "utf8");
      const carriedLines = priorReadme.split(/\r?\n/).filter(line => /^Team update revision \d+$/.test(line));
      if (carriedLines.length !== 1) throw new Error("The preserved implementation README change could not be identified");
      writeFileSync("README.md", `${upstreamReadme}\n${carriedLines.join("\n")}\n`);
      await report({ kind: "result", summary: "Imported both implementation files and reconciled the README change from the preserved workspace" });
      return;
    }
    if (scenario === "repeat-failed-check") {
      await report({ kind: "result", summary: "No implementation change is required for this verification result" });
      return;
    }
    if (scenario === "integrator-limit" && receipt.provider === "claude") {
      writeFileSync("repair.txt", "partial repair from the limited integrator\n");
      console.log("You've hit your session limit · resets 3:45pm");
      await new Promise(resolve => setTimeout(resolve, 1100));
      const response = await fetch(`${process.env.INFINITE_HOOK_URL}/claude`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.INFINITE_HOOK_TOKEN}` },
        body: JSON.stringify({ hook_event_name: "StopFailure", error: "rate_limit" }),
      });
      if (response.status !== 204) throw new Error(`Claude limit hook was refused with status ${response.status}`);
      await new Promise(() => {});
    }
    writeFileSync("repair.txt", `${assignment.memberId}\n`);
    await report({ kind: "result", summary: "Applied a local repair for verification" });
  } else if (assignment.role === "delivery") {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const base = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { encoding: "utf8" }).trim().split("\n")[0];
    const context = JSON.parse(readFileSync(join(".git", "infinite-team-context.json"), "utf8"));
    const launchPrompt = receipt.prompt ?? process.argv.at(-1) ?? "";
    const reconciling = /Automatic delivery reconciliation/i.test(launchPrompt);
    const existingDeliveryMembers = readdirSync(receiptDir).filter(name => name.endsWith(".json"))
      .map(name => JSON.parse(readFileSync(join(receiptDir, name), "utf8")))
      .filter(value => value.runId === assignment.runId && value.role === "delivery");
    appendFileSync(join(receiptDir, "delivery-attempts.jsonl"), JSON.stringify({ memberId: assignment.memberId, revision: assignment.revision,
      head, reconciling, prompt: launchPrompt }) + "\n", { mode: 0o600 });
    if (reconciling) {
      const branch = readFileSync(join(receiptDir, "delivery-branch"), "utf8").trim();
      const baseHeadCommit = existsSync(join(receiptDir, "delivery-base-head"))
        ? readFileSync(join(receiptDir, "delivery-base-head"), "utf8").trim()
        : context.baseCommit;
      const reconciliation = { kind: "delivery-reconciliation", headCommit: context.headCommit,
        repository: "example/app", branch, baseHeadCommit, disposition: "no-publication",
        summary: "The configured branch has no pull request or publication; no remote write was made." };
      appendFileSync(join(receiptDir, "delivery-reconciliations.jsonl"), JSON.stringify(reconciliation) + "\n", { mode: 0o600 });
      await report(reconciliation);
      return;
    }
    if (scenario === "delivery-capability-failure" || scenario === "delivery-capability-repair") {
      const failure = { kind: "blocked", summary: "The existing provider lacks the required publication capability; no publication was attempted." };
      if (existingDeliveryMembers.length <= 1) {
        writeFileSync(join(receiptDir, "delivery-started.json"), JSON.stringify({ head, memberId: assignment.memberId }), { mode: 0o600 });
        while (!existsSync(join(receiptDir, "delivery-release"))) await new Promise(resolve => setTimeout(resolve, 40));
        if (scenario === "delivery-capability-repair") {
          await report(failure);
          return;
        }
      }
      if (scenario === "delivery-capability-repair") {
        if (existsSync("repair.txt")) {
          await report({ kind: "pull-request", headCommit: context.headCommit, pullRequestUrl: "https://github.com/example/app/pull/1",
            summary: "Published the repaired, checked, and independently reviewed head exactly once." });
        } else {
          await report({ kind: "delivery-repair", headCommit: context.headCommit,
            summary: "The inspected no-publication attempt is blocked by CI; repair the reviewed change before another delivery." });
        }
        return;
      }
      await report(failure);
      return;
    }
    if (scenario === "delivery-base-recovery") {
      if (existingDeliveryMembers.length <= 1) {
        writeFileSync(join(receiptDir, "delivery-started.json"), JSON.stringify({ head, memberId: assignment.memberId }), { mode: 0o600 });
        while (!existsSync(join(receiptDir, "delivery-release"))) await new Promise(resolve => setTimeout(resolve, 40));
        await report({ kind: "blocked", summary: "The base branch moved while this reviewed README change conflicted; no pull request or publication was created." });
        return;
      }
      await report({ kind: "pull-request", headCommit: context.headCommit, pullRequestUrl: "https://github.com/example/app/pull/1",
        summary: "Opened one pull request for the newly checked and independently reviewed head." });
      return;
    }
    const mergeCommit = execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit-tree", `${scenario === "delivery-baseline-changed" ? base : head}^{tree}`, "-p", base, "-m", "Synthetic squash delivery"], { encoding: "utf8" }).trim();
    execFileSync("git", ["update-ref", "refs/heads/synthetic-merge", mergeCommit]);
    writeFileSync(join(receiptDir, "delivery-started.json"), JSON.stringify({ head, memberId: assignment.memberId }), { mode: 0o600 });
    if (scenario === "delivery-permission") {
      const context = JSON.parse(readFileSync(join(".git", "infinite-team-context.json"), "utf8"));
      const launchPrompt = process.argv.at(-1) ?? "";
      const branch = launchPrompt.match(/pushing branch ([^\s]+) at exactly that commit/)?.[1];
      if (!branch) throw new Error("The fixture could not identify the delivery branch retained from the prepared integration copy");
      const command = `git push https://github.com/example/app.git \\
${context.headCommit}:refs/heads/\\
${branch}`;
      process.stdout.write(`\u001b[2J\u001b[HBash command\n${command}\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again\n  3. No, and tell the agent what to do differently (esc)\n`);
      await new Promise(resolve => setTimeout(resolve, 200));
      const permission = await fetch(`${process.env.INFINITE_HOOK_URL}/claude`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.INFINITE_HOOK_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command } }),
      });
      if (permission.status !== 204) throw new Error(`Delivery permission hook was refused with status ${permission.status}`);
      writeFileSync(join(receiptDir, `${assignment.runId}.delivery-target-ready`), "ready", { mode: 0o600 });
      const input = String(await new Promise(resolve => process.stdin.once("data", resolve)));
      writeFileSync(join(receiptDir, `${assignment.runId}.delivery-target-key`), input, { mode: 0o600 });
    }
    if (scenario === "delivery-hold" || scenario === "delivery-unreported") {
      while (!existsSync(join(receiptDir, "delivery-release"))) await new Promise(resolve => setTimeout(resolve, 40));
    }
    if (scenario === "delivery-unreported") process.exit(0);
    if (scenario === "delivery-repair" && !existsSync("repair.txt")) {
      await report({ kind: "delivery-repair", headCommit: head, summary: "CI requires a scoped repair before another review." }); return;
    }
    if (scenario === "delivery-dirty") writeFileSync("unreviewed.txt", "This was not reviewed.\n");
    await report({ kind: "delivery", headCommit: scenario === "delivery-stale" ? "0".repeat(40) : head,
      pullRequestUrl: scenario === "delivery-foreign" ? "https://github.com/example/other/pull/1" : "https://github.com/example/app/pull/1",
      mergeCommit: scenario === "delivery-baseline-tree" ? execFileSync("git", ["rev-parse", `${head}^{tree}`], { encoding: "utf8" }).trim() : mergeCommit, summary: "Synthetic delivery report exercising host binding; no GitHub request was made." });
  } else if (assignment.role === "reviewer") {
    if (scenario === "reviewer-recording-error" && !existsSync(join(receiptDir, "reviewer-recording-error-started"))) {
      writeFileSync(join(receiptDir, "reviewer-recording-error-started"), "started", { mode: 0o600 });
      const descendantScript = `const { existsSync, writeFileSync } = require('node:fs'); const { join } = require('node:path'); let child; process.on('SIGTERM',()=>{}); setInterval(() => { if (!child && existsSync(join(${JSON.stringify(receiptDir)}, 'retirement-expand-tree'))) { child = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { detached:true, stdio:'ignore' }); writeFileSync(join(${JSON.stringify(receiptDir)}, 'retirement-discovered-pid.json'), JSON.stringify({ pid:child.pid }), { mode:0o600 }); } }, 50);`;
      const descendant = spawn(process.execPath, ["-e", descendantScript],
        { detached: true, stdio: "ignore" });
      writeFileSync(join(receiptDir, "reviewer-hold.json"), JSON.stringify({ pid: process.pid, descendantPid: descendant.pid }), { mode: 0o600 });
      for (;;) { process.stdout.write("recording-error reviewer remains active\n"); await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    for (const name of ["a.txt", "b.txt"])
      if (!readFileSync(name, "utf8").startsWith("revision ")) throw new Error("The review checkout lacks integrated work");
    if (scenario === "reviewer-recording-error" && !existsSync(join(receiptDir, "retirement-review-repair"))) {
      writeFileSync(join(receiptDir, "retirement-review-repair"), "requested");
      await report({ kind: "review", verdict: "changes-requested", summary: "Exercise a normal repair round after the replacement review." });
      return;
    }
    if (scenario === "changed-after-check")
      writeFileSync(join(process.cwd(), "..", "..", "integration", "a.txt"), "Changed after verification\n");
    await report({ kind: "review", verdict: "approved", summary: "Both requested files are present in the integrated checkout",
      ...(scenario === "rubric" ? { rubric: ["a", "b"].map(taskId => ({ taskId,
        correctness: { score: 5, why: "The assigned file is present." }, cleanliness: { score: 4, why: "The change is narrow." },
        extensibility: { score: 4, why: "The structure is easy to extend." }, docs: { score: 3, why: "The task evidence is clear." } })) } : {}) });
  }
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
