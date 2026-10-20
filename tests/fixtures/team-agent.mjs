import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";

if (process.argv[2] === "--command-prefix") {
  const [, receiptDir, command, ...args] = process.argv.slice(2);
  appendFileSync(join(receiptDir, "commands.jsonl"), JSON.stringify({ command, args, cwd: process.cwd() }) + "\n", { mode: 0o600 });
  const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, INFINITE_TEST_COMMAND_IDENTITY: "team-prefix" } });
  child.once("error", () => process.exit(127));
  child.once("exit", code => process.exit(code ?? 128));
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
if (scenario === "stall-slow-stop") process.on("SIGTERM", () => setTimeout(() => process.exit(0), 2000));
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
    if (scenario === "mixed") {
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
      { id: "a", title: "Build the first file", instructions: "Write a.txt with the current revision", paths: ["a.txt"], dependsOn: [] },
      { id: "b", title: "Build the second file", instructions: "Write b.txt with the current revision", paths: ["b.txt"], dependsOn: [] },
    ];
    if (scenario.startsWith("bootstrap")) tasks[0].paths.push("check.mjs");
    if (scenario === "usage") {
      tasks[0].agentProfileId = "spark-high";
      tasks[1].agentProfileId = "deepseek-high";
    } else if (scenario === "mixed") {
      tasks[0].agentProfileId = "spark-high";
      tasks[1].agentProfileId = "astra-xhigh";
    } else if (scenario.startsWith("permissions") || scenario.startsWith("delivery") || scenario === "integrator-limit") {
      tasks[0].agentProfileId = "haiku";
      tasks[1].agentProfileId = "codex-light";
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
    if (scenario === "bootstrap-change" && assignment.revision > 1)
      verification.checks[0].args.push("--different");
    const plan = { kind: "plan", summary: "Build two independent files and verify their integrated contents", tasks,
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
    if (!["permissions", "permissions-restart", "permissions-judge-exit"].includes(scenario)) {
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
    await waitForPeer();
    const asked = join(receiptDir, `${assignment.runId}.${assignment.taskId}.asked`);
    if ((scenario === "mixed" || (scenario === "bootstrap-replan" || scenario === "bootstrap-change") && assignment.revision === 1) && assignment.taskId === "b" && !existsSync(asked)) {
      writeFileSync(asked, "asked", { mode: 0o600 });
      await report({ kind: "question", question: "Which display label should the second file use?", options: ["Detailed", "Compact"] });
      return;
    }
    if (scenario.startsWith("limit") && receipt.provider === "claude" && receipt.argv[receipt.argv.indexOf("--model") + 1] === "claude-haiku-5-5") {
      // In `limit`, the first attempt asks a question so the limited attempt carries a user answer.
      if (scenario === "limit" && !existsSync(asked)) {
        writeFileSync(asked, "asked", { mode: 0o600 });
        await report({ kind: "question", question: "Which display label should the first file use?", options: ["Detailed", "Compact"] });
        return;
      }
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
    if (scenario.startsWith("permissions") && assignment.taskId === "a") {
      const menu = scenario === "permissions-restart"
        ? `\nBash command\ncat original.txt\nDo you want to proceed?\n${Array.from({ length: 8 }, (_, index) => `  ${index + 1}. No, stop`).join("\n")}\n❯ 9. Yes\n`
        : "\nBash command\ncat original.txt\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again for Bash commands\n  3. No, and tell Claude what to do differently (esc)\n";
      process.stdout.write(`\u001b[2J\u001b[H${menu}`);
      await new Promise(resolve => setTimeout(resolve, 200));
      const response = await fetch(`${process.env.INFINITE_HOOK_URL}/claude`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.INFINITE_HOOK_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "cat original.txt" } }),
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
  } else if (assignment.role === "integrator") {
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
    const mergeCommit = execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit-tree", `${scenario === "delivery-baseline-changed" ? base : head}^{tree}`, "-p", base, "-m", "Synthetic squash delivery"], { encoding: "utf8" }).trim();
    execFileSync("git", ["update-ref", "refs/heads/synthetic-merge", mergeCommit]);
    writeFileSync(join(receiptDir, "delivery-started.json"), JSON.stringify({ head, memberId: assignment.memberId }), { mode: 0o600 });
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
    for (const name of ["a.txt", "b.txt"])
      if (!readFileSync(name, "utf8").startsWith("revision ")) throw new Error("The review checkout lacks integrated work");
    if (scenario === "changed-after-check")
      writeFileSync(join(process.cwd(), "..", "..", "integration", "a.txt"), "Changed after verification\n");
    await report({ kind: "review", verdict: "approved", summary: "Both requested files are present in the integrated checkout",
      ...(scenario === "rubric" ? { rubric: ["a", "b"].map(taskId => ({ taskId,
        correctness: { score: 5, why: "The assigned file is present." }, cleanliness: { score: 4, why: "The change is narrow." },
        extensibility: { score: 4, why: "The structure is easy to extend." }, docs: { score: 3, why: "The task evidence is clear." } })) } : {}) });
  }
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
