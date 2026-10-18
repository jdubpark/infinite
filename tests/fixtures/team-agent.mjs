import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

if (process.argv[2] === "--command-prefix") {
  const [, receiptDir, command, ...args] = process.argv.slice(2);
  appendFileSync(join(receiptDir, "commands.jsonl"), JSON.stringify({ command, args, cwd: process.cwd() }) + "\n", { mode: 0o600 });
  const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, INFINITE_TEST_COMMAND_IDENTITY: "team-prefix" } });
  child.once("error", () => process.exit(127));
  child.once("exit", code => process.exit(code ?? 128));
  await new Promise(() => {});
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

// A real child process reports through its worker's authenticated hook. The
// receipt directory only coordinates concurrent fixture processes; the runner
// must discover results, commits, and check outcomes through production paths.
const [scenario, receiptDir] = process.argv.slice(2);
const assignment = JSON.parse(process.env.INFINITE_TEAM_ASSIGNMENT ?? "null");
if (!assignment || !process.env.INFINITE_HOOK_URL || !process.env.INFINITE_HOOK_TOKEN)
  throw new Error("The team worker did not provide its reporting capability");
const receiptFile = join(receiptDir, `${assignment.memberId}.json`);
const providerIndex = process.argv.indexOf("--fixture-provider");
const receipt = { ...assignment, cwd: process.cwd(), pid: process.pid, startedAt: Date.now(),
  ...(providerIndex >= 0 ? { provider: process.argv[providerIndex + 1], argv: process.argv.slice(2) } : {}) };
if (receipt.provider === "opencode") {
  const args = process.argv.slice(providerIndex + 2), boundary = args.indexOf("--");
  if (args[0] !== "run" || boundary < 1 || boundary !== args.length - 2
    || args.slice(0, boundary).some(arg => ["--prompt", "--effort", "-c"].includes(arg)))
    throw new Error("OpenCode needs run mode with one positional prompt, not TUI or Codex arguments");
  const model = args.indexOf("--model"), variant = args.indexOf("--variant");
  if (model < 1 || model >= boundary - 1 || !args[model + 1].includes("/"))
    throw new Error("OpenCode requires a provider/model selection");
  receipt.model = args[model + 1];
  if (variant >= 0) {
    if (variant >= boundary - 1) throw new Error("OpenCode variant has no value");
    receipt.variant = args[variant + 1];
  }
  receipt.prompt = args[boundary + 1];
}
writeFileSync(receiptFile, JSON.stringify(receipt), { mode: 0o600 });

async function report(value, overrides = {}) {
  const response = await fetch(`${process.env.INFINITE_HOOK_URL}/team-report`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.INFINITE_HOOK_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: randomUUID(), runId: assignment.runId,
      memberId: assignment.memberId, revision: assignment.revision, report: value, ...overrides }),
  });
  if (!response.ok && Object.keys(overrides).length === 0)
    throw new Error(`Team report was refused with status ${response.status}`);
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
  if (scenario === "mcp") {
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
    if (scenario === "mixed") {
      tasks[0].agentProfileId = "spark-high";
      tasks[1].agentProfileId = "astra-xhigh";
    } else if (scenario === "mixed-invalid") {
      // The first task is valid: rejection must inspect the whole plan before
      // dispatching any member, including work preceding the invalid choice.
      tasks[0].agentProfileId = "spark-high";
      Object.assign(tasks[1], JSON.parse(readFileSync(join(receiptDir, "invalid-profile.json"), "utf8")));
    }
    await report({ kind: "plan", summary: "Build two independent files and verify their integrated contents", tasks });
  } else if (assignment.role === "implementer") {
    await waitForPeer();
    const asked = join(receiptDir, `${assignment.runId}.${assignment.taskId}.asked`);
    if (scenario === "mixed" && assignment.taskId === "b" && !existsSync(asked)) {
      writeFileSync(asked, "asked", { mode: 0o600 });
      await report({ kind: "question", question: "Which display label should the second file use?", options: ["Detailed", "Compact"] });
      return;
    }
    if (scenario === "question") {
      while (!existsSync(join(receiptDir, `${assignment.runId}.release`)))
        await new Promise(resolve => setTimeout(resolve, 40));
    }
    // Keep both processes alive after the barrier so overlap can be measured
    // independently of the member states returned by the API.
    await new Promise(resolve => setTimeout(resolve, 150));
    const name = scenario === "scope-escape" && assignment.taskId === "a" ? " a.txt" : `${assignment.taskId}.txt`;
    writeFileSync(name, `revision ${assignment.revision}\n`);
    receipt.finishedAt = Date.now();
    writeFileSync(receiptFile, JSON.stringify(receipt), { mode: 0o600 });
    await report({ kind: "result", summary: `Implemented ${assignment.taskId}.txt` });
  } else if (assignment.role === "integrator") {
    writeFileSync("repair.txt", `${assignment.memberId}\n`);
    await report({ kind: "result", summary: "Applied a local repair for verification" });
  } else if (assignment.role === "reviewer") {
    for (const name of ["a.txt", "b.txt"])
      if (!readFileSync(name, "utf8").startsWith("revision ")) throw new Error("The review checkout lacks integrated work");
    if (scenario === "changed-after-check")
      writeFileSync(join(process.cwd(), "..", "..", "integration", "a.txt"), "Changed after verification\n");
    await report({ kind: "review", verdict: "approved", summary: "Both requested files are present in the integrated checkout" });
  }
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
