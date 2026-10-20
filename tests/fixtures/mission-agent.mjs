import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Plays the mission coordinator and each subteam role, deciding from the prompt the host built.
const [receipts] = process.argv.slice(3);
const assignment = JSON.parse(process.env.INFINITE_TEAM_ASSIGNMENT ?? "null");
if (!assignment || !process.env.INFINITE_HOOK_URL || !process.env.INFINITE_HOOK_TOKEN)
  throw new Error("A mission fixture needs its worker's report capability");
const prompt = process.argv.at(-1);
const receiptFile = join(receipts, `${assignment.memberId}.json`);
writeFileSync(receiptFile + ".tmp", JSON.stringify({ ...assignment, cwd: process.cwd(), prompt }), { mode: 0o600 });
renameSync(receiptFile + ".tmp", receiptFile);
process.stdin.resume();

async function report(value) {
  const mission = assignment.role === "mission-coordinator", binding = mission ? { missionId: assignment.runId } : { runId: assignment.runId };
  if (mission && JSON.parse(process.env.INFINITE_MISSION_ASSIGNMENT).missionId !== assignment.runId) throw new Error("The coordinator lacks its mission assignment");
  const response = await fetch(`${process.env.INFINITE_HOOK_URL}/${mission ? "mission-report" : "team-report"}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.INFINITE_HOOK_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: randomUUID(), ...binding, memberId: assignment.memberId, revision: assignment.revision, report: value }),
  });
  if (response.status !== 204) throw new Error(`Mission fixture report refused: ${response.status}`);
}
const until = async ready => { while (!ready()) await new Promise(resolve => setTimeout(resolve, 50)); };
const json = label => JSON.parse(prompt.split("\n").find(line => line.startsWith(label)).slice(label.length));
const hold = () => new Promise(() => {});

async function coordinator() {
  const state = json("Mission state (JSON): "), messages = json("Messages since your last attempt (JSON): ");
  const held = prompt.includes("HOLD-SUBTEAM"), refusal = messages.find(message => message.type === "refused")?.reason ?? "";
  const step = (id, repoProjectId, dependsOn) => ({ id, repoProjectId, title: id, objective: "HOLD-SUBTEAM", size: "solo", dependsOn });
  if (prompt.includes("INVALID-DISPATCH") && messages.some(message => message.type === "start")) {
    await report({ kind: "dispatch", summary: "Two subtasks that wait on each other", subtasks: [step("first", "api", ["second"]), step("second", "web", ["first"])] });
    return;
  }
  if (/cycle/.test(refusal)) {
    await report({ kind: "dispatch", summary: "A subtask outside the project", subtasks: [step("docs", "docs", [])] });
    return;
  }
  if (messages.some(message => message.type === "start") || /not part of/.test(refusal)) {
    await until(() => existsSync(join(receipts, "release-dispatch")));
    await report({ kind: "dispatch", summary: "Build the API first, then the web client that calls it", subtasks: held
      ? [{ id: "held", repoProjectId: "api", title: "Hold the repository", objective: "HOLD-SUBTEAM", size: "solo", dependsOn: [] }]
      : [
        { id: "api-change", repoProjectId: "api", title: "Add the endpoint", objective: "Write api.txt with the agreed response format", size: "solo", parallelism: 3, dependsOn: [] },
        { id: "web-change", repoProjectId: "web", title: "Call the endpoint", objective: "Write web.txt that uses the endpoint", size: "team", parallelism: 2, dependsOn: ["api-change"] },
      ] });
    return;
  }
  if (held) return hold();
  const decision = messages.find(message => message.type === "child-decision");
  if (decision?.subtaskId === "api-change") {
    await report({ kind: "question", question: `The API subteam asks: ${decision.question}`, options: decision.options, subtaskId: decision.subtaskId, childDecisionId: decision.decisionId });
    return;
  }
  if (decision?.subtaskId === "web-change") {
    await report({ kind: "answer-child", subtaskId: decision.subtaskId, decisionId: decision.decisionId, text: "Use the primary button; the objective settles it." });
    return;
  }
  const open = state.subtasks.filter(subtask => ["queued", "running"].includes(subtask.status)).length;
  await report({ kind: "result", summary: open ? "Reporting early to test the host's refusal" : "The API and the web client were each reviewed in their own repository." });
}

async function subteam() {
  const api = prompt.includes("Subtask api-change"), file = api ? "api.txt" : "web.txt";
  if (assignment.role === "project-manager") {
    if (prompt.includes("HOLD-SUBTEAM")) return hold();
    if (!api) await until(() => existsSync(join(receipts, "release-web-question")));
    if (!/(?:User|Mission coordinator) answered:/.test(prompt)) {
      await report({ kind: "question", question: api ? "Which response format should the endpoint use?" : "Should the button be primary?", options: api ? ["JSON", "Text"] : ["Primary", "Secondary"] });
      return;
    }
    await report({ kind: "plan", summary: `Write ${file}`, tasks: [{ id: "write", title: `Write ${file}`, instructions: `Create ${file}`, agentProfileId: "light", paths: [file], dependsOn: [] }] });
  } else if (assignment.role === "implementer") {
    writeFileSync(file, `${prompt.match(/(?:User|Mission coordinator) answered: (.*)/)?.[1] ?? "ready"}\n`);
    await report({ kind: "result", summary: `Wrote ${file}` });
  } else if (assignment.role === "reviewer") {
    await report({ kind: "review", verdict: "approved", summary: `Inspected ${file} and the passing check` });
  } else throw new Error(`Unexpected fixture role: ${assignment.role}`);
}

(assignment.role === "mission-coordinator" ? coordinator() : subteam())
  .catch(error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
