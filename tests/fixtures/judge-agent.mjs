// A fake judge for a duel run. The eval profile runs it as the judge member. Its mode comes from `RECEIPTS/RUN.mode`, a JSON
// file the test writes before the run starts:
//   { "mode": "prefer-a" }         reports a judgement that prefers A
//   { "mode": "prefer-resolved" }  reports the label whose patch holds the line RESOLVED-MARKER
//   { "mode": "edit" }             changes the working copy, then reports a judgement
//   { "mode": "wrong-id" }         reports a judgement for another duel ID
//   { "mode": "late" }             waits past the run's judging window, then reports a judgement
//   { "mode": "question" }         reports a question
//   { "mode": "exit" }             exits without a report
//   { "mode": "permission" }       draws a dialog that the pipeline leaves to a person
//   { "mode": "hang" }             prints nothing and waits
// It copies the context file and every package file it reads into `RECEIPTS/RUN/read/`, so a test can inspect every byte it saw.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const receiptDir = process.argv[2];
const assignment = JSON.parse(process.env.INFINITE_TEAM_ASSIGNMENT ?? "null");
if (!receiptDir || !assignment || !process.env.INFINITE_HOOK_URL || !process.env.INFINITE_HOOK_TOKEN)
  throw new Error("The judge did not provide its reporting capability");

const runId = assignment.runId;
const readDir = join(receiptDir, runId, "read");
mkdirSync(readDir, { recursive: true });
/** Writes a receipt whole: to a temporary name first, then renamed into place, so a reader never sees half of one. */
function writeWhole(name, bytes) {
  const temporary = join(readDir, `.${name}.tmp`);
  writeFileSync(temporary, bytes, { mode: 0o600 });
  renameSync(temporary, join(readDir, name));
}

const contextFile = join(process.cwd(), ".git", "infinite-team-context.json");
const context = JSON.parse(readFileSync(contextFile, "utf8"));
writeWhole("context.json", readFileSync(contextFile));
const packageDir = join(process.cwd(), ".git", "infinite-judge");
const patches = {};
if (existsSync(packageDir)) {
  for (const name of readdirSync(packageDir)) {
    const bytes = readFileSync(join(packageDir, name));
    patches[name] = bytes.toString("utf8");
    writeWhole(`package.${name}`, bytes);
  }
}
writeWhole("started.json", JSON.stringify({ cwd: process.cwd() }));

const modeFile = join(receiptDir, `${runId}.mode`);
const { mode } = existsSync(modeFile) ? JSON.parse(readFileSync(modeFile, "utf8")) : { mode: "prefer-a" };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const forever = () => setInterval(() => {}, 1000);

async function report(value) {
  const response = await fetch(`${process.env.INFINITE_HOOK_URL}/team-report`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.INFINITE_HOOK_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: randomUUID(), runId, memberId: assignment.memberId, revision: assignment.revision, report: value }),
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
const scores = { correctness: 4, cleanliness: 3, extensibility: 3, docs: 2 };
const judgement = (preferred, duelId = context.duelId) => ({
  kind: "judgement", duelId, preferred, rubric: { a: scores, b: { ...scores, correctness: 2 } }, summary: "A judged preference for the fixture.",
});

if (mode === "prefer-a") {
  await report(judgement("A"));
} else if (mode === "prefer-resolved") {
  const holds = name => (patches[name] ?? "").split("\n").some(line => line === "RESOLVED-MARKER" || line === "+RESOLVED-MARKER");
  await report(judgement(holds("A.patch") ? "A" : holds("B.patch") ? "B" : "tie"));
} else if (mode === "edit") {
  writeFileSync("edited-by-judge.txt", "The judge changed its working copy\n");
  await report(judgement("A"));
} else if (mode === "wrong-id") {
  await report(judgement("A", randomUUID()));
} else if (mode === "late") {
  await sleep(1500);
  await report(judgement("A"));
} else if (mode === "question") {
  await report({ kind: "question", question: "Which patch should win?", options: ["A", "B"] });
} else if (mode === "exit") {
  process.exit(0);
} else if (mode === "permission") {
  console.log(["Bash command", "  rm -rf build", "", "Do you want to proceed?", "❯ 1. Yes", "  2. No"].join("\n"));
  await hook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf build" } });
  forever();
} else if (mode === "hang") {
  forever();
} else throw new Error(`Unknown judge mode ${mode}`);
