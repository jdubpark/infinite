// A fake implementer for a replay trial. The eval profile runs it as the trial's member. Its mode comes from
// `RECEIPTS/RUN.mode`, a JSON file the test writes before the trial starts, so one profile serves every ending:
//   { "mode": "reference", "dir": DIR }  copies DIR's files into the workspace, then reports a result
//   { "mode": "empty" }                  reports a result without changing anything
//   { "mode": "outside" }                edits a file outside the task's paths, then reports a result
//   { "mode": "question" | "blocked" | "escalate" }  reports that kind
//   { "mode": "silent" }                 exits without a report
//   { "mode": "stall" }                  prints nothing and waits
//   { "mode": "permission" }             draws a dialog that the pipeline leaves to a person
//   { "mode": "limit" }                  prints a usage-limit notice and reports the limit to the host
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const receiptDir = process.argv[2];
const assignment = JSON.parse(process.env.INFINITE_TEAM_ASSIGNMENT ?? "null");
if (!receiptDir || !assignment || !process.env.INFINITE_HOOK_URL || !process.env.INFINITE_HOOK_TOKEN)
  throw new Error("The trial member did not provide its reporting capability");
writeFileSync(join(receiptDir, `${assignment.runId}.${assignment.memberId}.started.json`), JSON.stringify({ cwd: process.cwd() }), { mode: 0o600 });

const modeFile = join(receiptDir, `${assignment.runId}.mode`);
const { mode, dir } = existsSync(modeFile) ? JSON.parse(readFileSync(modeFile, "utf8")) : { mode: "empty" };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const forever = () => setInterval(() => {}, 1000);

async function report(value) {
  const response = await fetch(`${process.env.INFINITE_HOOK_URL}/team-report`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.INFINITE_HOOK_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: randomUUID(), runId: assignment.runId, memberId: assignment.memberId,
      revision: assignment.revision, report: value }),
  });
  if (!response.ok) throw new Error(`Team report was refused with status ${response.status}`);
}
async function hook(body) {
  await fetch(`${process.env.INFINITE_HOOK_URL}/claude`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.INFINITE_HOOK_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

const result = { kind: "result", summary: "The trial member finished its assignment." };
if (mode === "reference") {
  cpSync(dir, process.cwd(), { recursive: true, filter: source => !source.endsWith(".git") });
  await report(result);
} else if (mode === "empty") {
  await report({ kind: "result", summary: "Nothing needed a change." });
} else if (mode === "outside") {
  writeFileSync("outside.txt", "Changed outside the assigned paths\n");
  await report(result);
} else if (mode === "question") {
  await report({ kind: "question", question: "Which label should the change use?", options: ["Detailed", "Compact"] });
} else if (mode === "blocked") {
  await report({ kind: "blocked", summary: "The required tool is unavailable." });
} else if (mode === "escalate") {
  await report({ kind: "escalate", agentProfileId: "trial-stronger", reason: "The task needs a stronger member." });
} else if (mode === "silent") {
  process.exit(0);
} else if (mode === "stall") {
  forever();
} else if (mode === "permission") {
  console.log(["Bash command", "  rm -rf build", "", "Do you want to proceed?", "❯ 1. Yes", "  2. No"].join("\n"));
  await hook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf build" } });
  forever();
} else if (mode === "limit") {
  console.log("You've hit your session limit · resets 3:45pm");
  await sleep(300);
  await hook({ hook_event_name: "StopFailure", error: "rate_limit" });
  forever();
} else throw new Error(`Unknown trial mode ${mode}`);
