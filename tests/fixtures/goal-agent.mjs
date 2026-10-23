import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const [scenario, receipts, provider] = process.argv.slice(2);
if (scenario === "goal-slow-stop") process.on("SIGTERM", () => setTimeout(() => process.exit(0), 2000));
const cycleScenario = scenario === "cycles" || scenario === "goal-slow-stop";
const assignment = JSON.parse(process.env.INFINITE_TEAM_ASSIGNMENT ?? "null");
if (!assignment || !process.env.INFINITE_HOOK_URL || !process.env.INFINITE_HOOK_TOKEN)
  throw new Error("A goal member needs its worker's report capability");
const prompt = process.argv.at(-1);
const progress = JSON.parse(readFileSync("features/progress.json", "utf8"));
const receipt = { ...assignment, provider, cwd: process.cwd(), pid: process.pid,
  startedAt: Date.now(), before: progress, prompt };
const receiptFile = join(receipts, `${assignment.memberId}.json`);
const record = () => {
  writeFileSync(receiptFile + ".tmp", JSON.stringify(receipt), { mode: 0o600 });
  renameSync(receiptFile + ".tmp", receiptFile);
};
record();
process.stdin.resume();

async function report(value) {
  const response = await fetch(`${process.env.INFINITE_HOOK_URL}/team-report`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.INFINITE_HOOK_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: randomUUID(), runId: assignment.runId,
      memberId: assignment.memberId, revision: assignment.revision, report: value }),
  });
  if (response.status !== 204) throw new Error(`Goal report refused: ${response.status}`);
}

async function until(ready) {
  const deadline = Date.now() + 30000;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error("Goal fixture coordination timed out");
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

async function main() {
  if (assignment.role === "project-manager") {
    if (scenario === "recoverable-blocker" && assignment.revision > 1) {
      writeFileSync(join(receipts, `${assignment.runId}.recovery-pm-started`), "started", { mode: 0o600 });
      await until(() => existsSync(join(receipts, `${assignment.runId}.release-recovery-pm`)));
      const target = progress.completed + 1;
      await report({ kind: "plan", summary: `Recover and implement progress step ${target}`, brief: {
        title: `Progress step ${target}`, problem: `The fixture is missing progress step ${target}`,
        evidence: [{ source: "features/progress.json", observation: `The current completed value is ${progress.completed}` }],
        dataShape: "The progress object contains a numeric completed field", acceptance: [`The completed field is ${target}`],
        expectedOutcome: "The next progress step is available; product impact needs user evidence", uiChanges: false,
      }, tasks: [{ id: "progress", title: `Add progress step ${target}`, instructions: `Set completed to ${target} and leave no draft field`,
        agentProfileId: "light", paths: ["features/progress.json"], dependsOn: [] }] });
      return;
    }
    if (cycleScenario && progress.completed === 0)
      await until(() => existsSync(join(receipts, "release-first-plan")));
    if (scenario === "no-change") {
      await report({ kind: "no-change", summary: "The available evidence does not justify another change",
        evidence: [{ source: "features/progress.json", observation: "The fixture has no observed demand for a new feature" }] });
      return;
    }
    const discovery = join(receipts, `${assignment.runId}.discovery-requested`);
    if (cycleScenario && progress.completed === 0 && !existsSync(discovery)) {
      writeFileSync(discovery, "requested", { mode: 0o600 });
      await report({ kind: "explore", summary: "Inspect the data and its verification before planning", tasks: [
        { id: "data", title: "Inspect progress data", instructions: "Read the progress file and report its current value", agentProfileId: "light" },
        { id: "checks", title: "Inspect verification", instructions: "Read the configured check without changing files", agentProfileId: "light" },
      ] });
      return;
    }
    if (cycleScenario && progress.completed === 0) {
      if (!prompt.includes(".git/infinite-team-context.json"))
        throw new Error("The planning coordinator was not directed to the full discovery context");
      const context = JSON.parse(readFileSync(".git/infinite-team-context.json", "utf8"));
      const observations = (context.discovery?.tasks ?? []).flatMap(task => task.evidence ?? []).map(item => item.observation);
      if (!observations.some(value => value.includes("progress starts at 0"))
        || !observations.some(value => value.includes("check.mjs validates progress")))
        throw new Error("The planning coordinator could not read the scouts' complete recorded evidence");
    }
    const target = progress.completed + 1;
    await report({ kind: "plan", summary: `Implement progress step ${target}`, brief: {
      title: `Progress step ${target}`, problem: `The fixture is missing progress step ${target}`,
      evidence: [{ source: "features/progress.json", observation: `The current completed value is ${progress.completed}` }],
      dataShape: "The progress object contains a numeric completed field", acceptance: [`The completed field is ${target}`],
      expectedOutcome: "The next progress step is available; product impact needs user evidence", uiChanges: scenario === "ui-evidence",
    }, tasks: [{ id: "progress", title: `Add progress step ${target}`, instructions: `Set completed to ${target} and leave no draft field`,
      agentProfileId: "light", paths: [scenario === "scope" ? "outside.txt" : "features/progress.json"], dependsOn: [] }],
    ...(scenario === "bootstrap-goal" && progress.completed === 0
      ? { verification: { checks: [{ command: process.execPath, args: ["check.mjs"] }] } } : {}) });
  } else if (assignment.role === "scout") {
    await until(() => readdirSync(receipts).filter(name => name.endsWith(".json"))
      .map(name => JSON.parse(readFileSync(join(receipts, name), "utf8")))
      .filter(item => item.runId === assignment.runId && item.role === "scout").length === 2);
    const checks = assignment.taskId === "checks";
    if (checks && !readFileSync("check.mjs", "utf8").includes("completed")) throw new Error("The check does not inspect progress");
    receipt.finishedAt = Date.now(); record();
    await report({ kind: "findings", summary: checks ? "Inspected verification" : "Inspected progress data",
      evidence: [{ source: checks ? "check.mjs" : "features/progress.json",
        observation: checks ? "check.mjs validates progress" : `progress starts at ${progress.completed}` }] });
  } else if (assignment.role === "implementer") {
    if (scenario === "recoverable-blocker" && assignment.revision === 1) {
      await report({ kind: "blocked", summary: "The first assignment hit a recoverable worker issue." });
      return;
    }
    if (scenario === "bootstrap-goal" && progress.completed === 0)
      await until(() => existsSync(join(receipts, "release-first-implementation")));
    const model = process.argv[process.argv.indexOf("--model") + 1];
    if (cycleScenario && progress.completed === 0 && model !== "gpt-6-astra") {
      writeFileSync("features/progress.json", JSON.stringify({ completed: 0, draft: "Step prepared by the light worker" }) + "\n");
      await report({ kind: "escalate", agentProfileId: "strong", reason: "The partial step needs stronger reasoning; inspect the existing draft" });
      return;
    }
    if (cycleScenario && progress.completed === 0 && !progress.draft)
      throw new Error("Escalation discarded the first worker's partial edit");
    writeFileSync("features/progress.json", JSON.stringify({ completed: progress.completed + 1 }) + "\n");
    await report({ kind: "result", summary: "Implemented the next scoped progress step" });
  } else if (assignment.role === "delivery") {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const base = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { encoding: "utf8" }).trim().split("\n")[0];
    const mergeCommit = execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit-tree", `${head}^{tree}`, "-p", base, "-m", "Synthetic squash delivery"], { encoding: "utf8" }).trim();
    execFileSync("git", ["update-ref", "refs/heads/synthetic-merge", mergeCommit]);
    await report({ kind: "delivery", headCommit: head, pullRequestUrl: "https://github.com/example/app/pull/1", mergeCommit, summary: "Synthetic merge report for goal lifecycle verification; no external GitHub operation." });
  } else if (assignment.role === "reviewer") {
    if (!Number.isInteger(progress.completed) || progress.completed < 1 || progress.draft)
      throw new Error("The reviewed implementation is incomplete");
    // The UI scenario deliberately omits inspection evidence. The host must
    // reject this approval even though the configured code check passed.
    await report({ kind: "review", verdict: "approved", summary: "Verified the progress data and configured check results" });
  } else throw new Error(`Unexpected fixture role: ${assignment.role}`);
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
