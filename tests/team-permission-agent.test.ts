import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Prompt } from "@infinite/attention";
import { claimControl, waitFor } from "./helpers.js";
import { fixture, limitLineup } from "./team-fixture.js";
import type { TeamLineup, TeamView } from "../packages/host/src/team-types.js";
import type { PermissionOutcome, PermissionPipeline, PermissionRequest } from "../packages/host/src/permission-agent-types.js";
import { InteractivePermissionDelivery, type DeliveryLedgerState, type PermissionDeliveryLedger } from "../packages/host/src/permission-delivery.js";
import { requesterNotice } from "../packages/host/src/permission-policy.js";
import { teamPrompt } from "../packages/host/src/team-prompts.js";

const lineup: TeamLineup = {
  ...limitLineup,
  coordinator: { ...limitLineup.coordinator, id: "claude-coordinator", label: "Claude coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
};

function memoryLedger(): PermissionDeliveryLedger {
  const rows = new Map<string, { decisionId: string; state: DeliveryLedgerState }>();
  return { get: id => rows.get(id), set: (id, entry) => { rows.set(id, { decisionId: entry.decisionId, state: entry.state }); } };
}

/** A pipeline fake: the team adapter and delivery are real, only the decision is scripted. */
function fakePipeline(outcome: (request: PermissionRequest) => PermissionOutcome, served = true) {
  const calls = { decide: [] as PermissionRequest[], deliveries: [] as { decisionId: string; kind: string }[], ended: [] as string[] };
  const pipeline: PermissionPipeline = {
    serves: () => served ? { served: true } : { served: false, reason: "not-covered" },
    classOf: () => undefined,
    decide: async request => { calls.decide.push(structuredClone(request)); return outcome(request); },
    applicable: () => true,
    recordDelivery: (decisionId, kind) => { calls.deliveries.push({ decisionId, kind }); },
    taskEnded: taskId => { calls.ended.push(taskId); },
  };
  return { pipeline, calls };
}

/**
 * Starts a run whose project has no coordinator review, waits until member a shows its permission dialog, then
 * moves the run to a direct TeamService that has the permission agent wired. Member a's dialog moves its marker
 * with the arrow keys and records the option and text it received.
 */
async function servedRun(outcome: (request: PermissionRequest) => PermissionOutcome, options: { served?: boolean; holdControl?: boolean } = {}) {
  const f = await fixture("permissions-off-navigate", lineup);
  const created = await f.host.fetchApi("/teams", "owner", f.create());
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
  const runId = created.body.id as string;
  const waiting = await waitFor(async () => {
    const run = await f.get(runId);
    const target = run.members.find(member => member.taskId === "a");
    const session = target ? await f.host.fetchApi(`/sessions/${target.sessionId}`) : undefined;
    return { run, target, session };
  }, value => value.session?.body.attention?.state === "needs-you" && value.session.body.attention.prompt?.kind === "permission", 60000);
  assert.equal(waiting.run.permissionAgentDecisions, undefined, "without a pipeline the dialog stays with the owner");
  const target = waiting.target!, prompt = waiting.session!.body.attention.prompt as Prompt;
  if (options.holdControl) await claimControl(f.host, target.sessionId, "controller");
  const service = await f.openTeamService({ start: false });
  const { pipeline, calls } = fakePipeline(outcome, options.served ?? true);
  const delivery = new InteractivePermissionDelivery({ pipeline: () => pipeline, ledger: memoryLedger() });
  service.usePermissionAgent({ pipeline, delivery });
  service.start();
  const answer = () => JSON.parse(readFileSync(join(f.receipts, `${runId}.agent-answer.json`), "utf8")) as { option: number; text: string };
  return { f, runId, target, prompt, service, delivery, calls, answer };
}

const HOST_DECISION_FIELDS = ["at", "decisionId", "delivery", "memberId", "promptId", "requestId", "result", "role", "sessionId", "taskId", "code", "interruptClass"];

test("a served member's dialog is decided by the permission agent and answered once with its one-shot accept", { timeout: 180000 }, async () => {
  const decisionId = randomUUID();
  const run = await servedRun(() => ({ kind: "allow", decisionId, strongTier: false }));
  try {
    const decided = await waitFor(() => run.service.get(run.runId), view => view.permissionAgentDecisions?.some(item => item.result === "allowed") === true, 45000);
    assert.equal(run.calls.decide.length, 1, "one decision for one dialog");
    const request = run.calls.decide[0]!;
    assert.equal(request.requester.kind, "team-member");
    assert.equal(request.requester.projectId, "rehearsal");
    assert.equal(request.requester.taskId, run.runId, "the task is the run, across members and revisions");
    assert.equal(request.requester.assignment, `team:${run.runId}:${run.target.role}:task:a`);
    assert.equal(request.requester.sessionRoot, realpathSync(run.target.cwd), "the session root is the member's own clone");
    assert.equal(request.prompt?.id, run.prompt.id);
    assert.equal(request.shape.oneShotAccept, true);
    assert.equal(request.shape.oneShotReject, true);
    assert.ok(request.evidence?.digest, "the request carries the bounded workspace evidence");
    assert.deepEqual(run.calls.deliveries.map(item => item.kind), ["intent", "receipt"], "the intent is recorded before the key, then the receipt");
    assert.deepEqual(run.answer(), { option: 0, text: "" }, "the dialog received its one-shot accept and no text");
    const recorded = decided.permissionAgentDecisions!.find(item => item.result === "allowed")!;
    assert.equal(recorded.decisionId, decisionId);
    assert.equal(recorded.delivery, "receipt");
    for (const key of Object.keys(recorded)) assert.ok(HOST_DECISION_FIELDS.includes(key), `run status holds host fields only: ${key}`);
    assert.ok(decided.events.some(event => event.text === `The permission agent allowed a provider request (member ${recorded.memberId}, ${recorded.role}).`));
    const settled = await waitFor(() => run.service.get(run.runId), view => ["ready-for-review", "blocked"].includes(view.status), 120000);
    assert.equal(settled.status, "ready-for-review", JSON.stringify({ reason: settled.reason, events: settled.events.slice(-5) }));
    assert.equal(run.calls.decide.length, 1, "a delivered dialog is never decided again");
    assert.deepEqual(run.calls.ended, [run.runId], "the pipeline hears once that the run ended");
  } finally { await run.f.close(); }
});

test("a reject reaches the member only through its one-shot reject option, and run status shows the code", { timeout: 180000 }, async () => {
  const decisionId = randomUUID();
  const run = await servedRun(() => ({ kind: "reject", decisionId, code: "unrelated", notice: requesterNotice("unrelated") }));
  try {
    const decided = await waitFor(() => run.service.get(run.runId), view => view.permissionAgentDecisions?.some(item => item.result === "rejected") === true, 45000);
    const recorded = decided.permissionAgentDecisions!.find(item => item.result === "rejected")!;
    assert.equal(recorded.code, "unrelated");
    assert.equal(recorded.delivery, "receipt");
    assert.deepEqual(run.answer(), { option: 2, text: requesterNotice("unrelated") },
      "the reject went through the one-shot reject option, followed by the host's fixed notice and nothing else");
    for (const key of Object.keys(recorded)) assert.ok(HOST_DECISION_FIELDS.includes(key), `run status holds host fields only: ${key}`);
    assert.ok(decided.events.some(event => event.text === `The permission agent rejected a provider request (member ${recorded.memberId}, ${recorded.role}, code unrelated).`));
    const member = decided.members.find(item => item.memberId === recorded.memberId)!;
    assert.equal(member.permissionBlocked, undefined, "an ordinary reject does not block the member");
    assert.equal(run.calls.decide.length, 1);
  } finally { await run.f.close(); }
});

test("a locked assignment is shown as blocked on a permission through the member's host status", { timeout: 180000 }, async () => {
  const run = await servedRun(() => ({ kind: "reject", decisionId: randomUUID(), code: "locked", notice: requesterNotice("locked") }));
  try {
    const decided = await waitFor(() => run.service.get(run.runId), view => view.members.some(member => member.permissionBlocked?.code === "locked"), 45000);
    const member = decided.members.find(item => item.permissionBlocked)!;
    assert.equal(member.taskId, "a");
    assert.ok(decided.events.some(event => event.text.startsWith(`Member ${member.memberId} (${member.role}) is blocked on a permission:`)));
  } finally { await run.f.close(); }
});

test("a dialog of a project the permission agent does not serve is never handed to it", { timeout: 180000 }, async () => {
  const run = await servedRun(() => { throw new Error("an unserved project is never decided"); }, { served: false });
  try {
    await new Promise(resolve => setTimeout(resolve, 3000));
    assert.equal(run.calls.decide.length, 0);
    assert.equal(run.delivery.holder(run.target.sessionId, run.prompt.id), "owner");
    assert.equal(run.service.promptOwner(run.target.sessionId, run.prompt), "user", "the owner keeps the dialog, with today's notification");
    const view: TeamView = run.service.get(run.runId);
    assert.equal(view.permissionAgentDecisions, undefined);
  } finally { await run.f.close(); }
});

test("a person holding input control keeps the dialog: nothing is decided or sent", { timeout: 180000 }, async () => {
  const run = await servedRun(() => { throw new Error("a dialog under a person's control is never decided"); }, { holdControl: true });
  try {
    await new Promise(resolve => setTimeout(resolve, 3000));
    assert.equal(run.calls.decide.length, 0);
    assert.equal(run.calls.deliveries.length, 0);
    assert.equal(run.delivery.holder(run.target.sessionId, run.prompt.id), "owner", "the notifier treats it as the person's, as today");
  } finally { await run.f.close(); }
});

test("a coordinator review under way when the permission agent starts to serve the run never answers the dialog", { timeout: 180000 }, async () => {
  // The run starts on a host without the permission agent, so the coordinator review takes the member's dialog.
  const f = await fixture("permissions-revoke", lineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const runId = created.body.id as string;
    await waitFor(() => f.get(runId), run => run.permissionDecisions?.some(decision => decision.status === "reviewing") === true &&
      existsSync(join(f.receipts, `${runId}.judge-ready`)), 60000);
    // The permission agent becomes ready and serves the project while that review still runs.
    const service = await f.openTeamService({ start: false });
    const { pipeline, calls } = fakePipeline(() => ({ kind: "owner", decisionId: randomUUID(), interruptClass: "credentials" }));
    service.usePermissionAgent({ pipeline, delivery: new InteractivePermissionDelivery({ pipeline: () => pipeline, ledger: memoryLedger() }) });
    service.start();
    writeFileSync(join(f.receipts, `${runId}.judge-release`), "release", { mode: 0o600 });
    const settled = await waitFor(() => service.get(runId),
      view => view.permissionDecisions?.every(decision => !["pending", "reviewing", "approved", "answering"].includes(decision.status)) === true, 60000);
    const decision = settled.permissionDecisions![0]!;
    assert.equal(decision.status, "stale", JSON.stringify(decision));
    assert.equal(decision.receipt, undefined, "the coordinator's approval sent no key");
    assert.equal(settled.permissionsRevokedAt, undefined, "the owner revoked nothing; the authority moved to the permission agent");
    assert.ok(settled.events.some(event => event.text === "The permission agent now decides this run's provider requests; its coordinator reviews were retired."));
    // The dialog is still open, and it is the permission agent that decides it next.
    await waitFor(async () => calls.decide.length, count => count > 0, 60000);
    assert.equal(service.get(runId).permissionDecisions!.length, 1, "no further coordinator review starts for a served run");
  } finally { await f.close(); }
});

test("a coordinator answer already inside the manager when the permission agent starts to serve the run is refused under the lease", { timeout: 180000 }, async () => {
  const f = await fixture("permissions-revoke", lineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const runId = created.body.id as string;
    await waitFor(() => f.get(runId), run => run.permissionDecisions?.some(decision => decision.status === "reviewing") === true &&
      existsSync(join(f.receipts, `${runId}.judge-ready`)), 60000);
    // The coordinator's approved answer is held as it enters the manager, after the team service's own checks passed.
    let entered = false, release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const service = await f.openTeamService({
      start: false,
      manager: manager => {
        const answer = manager.answerTeamPermission.bind(manager);
        manager.answerTeamPermission = async (...args) => { entered = true; await held; return answer(...args); };
      },
    });
    // The permission agent is wired but does not serve the project yet, so the coordinator review decides.
    let served = false;
    const { pipeline, calls } = fakePipeline(() => ({ kind: "owner", decisionId: randomUUID(), interruptClass: "credentials" }));
    pipeline.serves = () => served ? { served: true } : { served: false, reason: "not-covered" };
    service.usePermissionAgent({ pipeline, delivery: new InteractivePermissionDelivery({ pipeline: () => pipeline, ledger: memoryLedger() }) });
    service.start();
    writeFileSync(join(f.receipts, `${runId}.judge-release`), "release", { mode: 0o600 });
    await waitFor(async () => entered, value => value, 60000);
    assert.equal(service.get(runId).permissionDecisions![0]!.status, "answering");
    // The agent starts to serve the run while the answer is in the manager. The scheduler cannot reach a run whose
    // answer operation is pending, so only the manager's read under its lease stands between the approval and the key.
    served = true;
    await new Promise(resolve => setTimeout(resolve, 3000));
    release();
    const settled = await waitFor(() => service.get(runId),
      view => view.permissionDecisions?.every(decision => !["pending", "reviewing", "approved", "answering"].includes(decision.status)) === true, 60000);
    const decision = settled.permissionDecisions![0]!;
    assert.notEqual(decision.status, "answered", JSON.stringify(decision));
    assert.equal(decision.receipt, undefined, "the coordinator's approval sent no key");
    // The dialog is still open, and it is the permission agent that decides it next.
    await waitFor(async () => calls.decide.length, count => count > 0, 60000);
  } finally { await f.close(); }
});

test("an owner act that makes the permission agent serve a run retires its coordinator reviews at once, without the scheduler", { timeout: 180000 }, async () => {
  const f = await fixture("permissions-revoke", lineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const runId = created.body.id as string;
    await waitFor(() => f.get(runId), run => run.permissionDecisions?.some(decision => decision.status === "reviewing") === true &&
      existsSync(join(f.receipts, `${runId}.judge-ready`)), 60000);
    // The service is not started, so no scheduler pass runs: only the authority change can retire the review.
    const service = await f.openTeamService({ start: false });
    let served = false;
    const { pipeline } = fakePipeline(() => ({ kind: "owner", decisionId: randomUUID(), interruptClass: "credentials" }));
    pipeline.serves = () => served ? { served: true } : { served: false, reason: "not-covered" };
    service.usePermissionAgent({ pipeline, delivery: new InteractivePermissionDelivery({ pipeline: () => pipeline, ledger: memoryLedger() }) });
    await service.permissionAuthorityChanged();
    assert.equal(service.get(runId).permissionDecisions![0]!.status, "reviewing", "a run the agent does not serve keeps its review");
    served = true;
    await service.permissionAuthorityChanged();
    const view = service.get(runId);
    assert.equal(view.permissionDecisions![0]!.status, "stale", JSON.stringify(view.permissionDecisions));
    assert.ok(view.events.some(event => event.text === "The permission agent now decides this run's provider requests; its coordinator reviews were retired."));
  } finally { await f.close(); }
});

test("member instructions say a reject is final and its effect must not be reached another way", () => {
  const run = { id: randomUUID(), projectId: "rehearsal", provider: "claude", title: "t", objective: "o", revision: 1, status: "implementing",
    members: [], tasks: [], decisions: [], checks: [], steering: [], events: [], baseCommit: "a".repeat(40), workspace: "/home/dev/projects/infinite",
    branch: "team/x", parallelism: 1, round: 0, createdAt: "2026-11-14T00:00:00.000Z", updatedAt: "2026-11-14T00:00:00.000Z" } as never;
  for (const role of ["project-manager", "implementer", "integrator", "reviewer", "delivery"] as const)
    assert.match(teamPrompt(run, role, role === "implementer" ? { id: "a", title: "A", instructions: "Do a.", paths: ["a.txt"], dependsOn: [], revision: 1, status: "pending" } as never : undefined),
      /A rejected permission request is final for that request\. Do not reach the same effect with another tool, command, or route\./, role);
});
