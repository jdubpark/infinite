import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { EvidenceDeliveryLedger, InteractivePermissionDelivery, permissionDeliveryModule, type PermissionDeliveryLedger } from "../packages/host/src/permission-delivery.js";
import type { PermissionInteractiveTarget, PermissionOutcome, PermissionPipeline, PermissionRequest } from "../packages/host/src/permission-agent-types.js";
import { teamPermissionRequest, teamPermissionTarget, teamPermissionTask } from "../packages/host/src/team-permission-adapter.js";

type Live = Awaited<ReturnType<PermissionInteractiveTarget["check"]>>;

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "session-1:7:abcd",
    requester: { kind: "team-member", sessionId: "session-1", projectId: "project-1", taskId: "run-1", assignment: "run-1:implementer:a",
      role: "implementer", provider: "codex", sessionRoot: "/home/dev/projects/infinite", scratchRoots: [], task: { title: "Task", text: "Text" } },
    tool: "dialog",
    action: "npm test",
    prompt: { id: 7, kind: "permission", title: "Would you like to run the following command?", detail: "$ npm test", options: [
      { index: 0, label: "Yes, proceed", role: "accept" }, { index: 1, label: "No, and tell Codex what to do differently", role: "reject-with-feedback" },
    ], acceptsText: true, source: "screen", hash: "a".repeat(64), pinned: true },
    shape: { completeEvidence: true, oneShotAccept: true, oneShotReject: true, persistentOnly: false, trustPrompt: false },
    evidenceHash: "e".repeat(64),
    ...overrides,
  };
}

function fakePipeline(outcome: PermissionOutcome | (() => Promise<PermissionOutcome>), options: { served?: boolean; applicable?: boolean } = {}) {
  const calls = { decide: 0, options: [] as Array<Parameters<PermissionPipeline["decide"]>[1]>, deliveries: [] as Array<{ decisionId: string; kind: string }> };
  const pipeline: PermissionPipeline = {
    serves: () => options.served === false ? { served: false, reason: "not-covered" } : { served: true },
    classOf: () => undefined,
    decide: async (_request, decideOptions) => { calls.decide++; calls.options.push(decideOptions); return typeof outcome === "function" ? outcome() : outcome; },
    applicable: () => options.applicable !== false,
    recordDelivery: (decisionId, kind) => { calls.deliveries.push({ decisionId, kind }); },
    taskEnded: () => {},
  };
  return { pipeline, calls };
}

function fakeTarget(input: { live?: Live | (() => Live); answer?: "delivered" | "refused" | "uncertain"; request?: PermissionRequest; ledger?: PermissionDeliveryLedger } = {}) {
  const answers: Array<{ option: number; notice?: string; ledgerAtAnswer?: string }> = [];
  const target: PermissionInteractiveTarget = {
    request: input.request ?? request(),
    check: async () => typeof input.live === "function" ? input.live() : input.live ?? { ok: true, accept: 0, reject: 1 },
    answer: async (option, _decisionId, notice) => {
      answers.push({ option, ...(notice ? { notice } : {}), ...(input.ledger ? { ledgerAtAnswer: input.ledger.get(target.request.id)?.state } : {}) });
      return input.answer ?? "delivered";
    },
  };
  return { target, answers };
}

function memoryLedger(): PermissionDeliveryLedger & { rows: Map<string, { decisionId: string; state: string }> } {
  const rows = new Map<string, { decisionId: string; state: any }>();
  return { rows, get: id => rows.get(id), set: (id, entry) => { rows.set(id, { decisionId: entry.decisionId, state: entry.state }); } };
}

const allow = (strongTier = false): PermissionOutcome => ({ kind: "allow", decisionId: "decision-1", strongTier });
const reject: PermissionOutcome = { kind: "reject", decisionId: "decision-2", code: "unrelated", notice: "Permission request rejected (unrelated): the action does not serve the task. This decision is final for this request." };

test("a project the pipeline does not serve gets no decision and no delivery, and stays with the owner", async () => {
  const { pipeline, calls } = fakePipeline(allow(true), { served: false });
  const service = new InteractivePermissionDelivery({ pipeline: () => pipeline, ledger: memoryLedger() });
  const { target, answers } = fakeTarget();
  const handled = await service.handle(target);
  assert.equal(handled.handled, false);
  assert.equal(calls.decide, 0);
  assert.equal(answers.length, 0);
  assert.equal(service.holder("session-1", 7), "owner");
});

test("without a wired pipeline nothing is decided and every dialog is the owner's", async () => {
  const service = new InteractivePermissionDelivery({ pipeline: () => undefined, ledger: memoryLedger() });
  service.addSource({ claims: () => true });
  const { target, answers } = fakeTarget();
  assert.equal((await service.handle(target)).handled, false);
  assert.equal(answers.length, 0);
  assert.equal(service.holder("session-1", 7), "owner");
});

test("an allow is delivered through the one-shot accept after a durable intent, then its receipt", async () => {
  const ledger = memoryLedger();
  const { pipeline, calls } = fakePipeline(allow());
  const service = new InteractivePermissionDelivery({ pipeline: () => pipeline, ledger });
  const { target, answers } = fakeTarget({ ledger });
  const handled = await service.handle(target);
  assert.deepEqual(handled, { handled: true, result: "allowed", decisionId: "decision-1", delivery: "receipt" });
  assert.deepEqual(answers, [{ option: 0, ledgerAtAnswer: "intent" }]);
  assert.deepEqual(calls.deliveries.map(item => item.kind), ["intent", "receipt"]);
  assert.equal(ledger.rows.get(target.request.id)?.state, "receipt");
  assert.equal(service.holder("session-1", 7), "agent", "a delivered verdict is never pushed");
});

test("a request with the destructive flag is not delivered on a light verdict", async () => {
  const destructive = request({ destructive: { pattern: "rm -rf" } });
  const light = fakePipeline(allow(false));
  const lightService = new InteractivePermissionDelivery({ pipeline: () => light.pipeline, ledger: memoryLedger() });
  const refused = fakeTarget({ request: destructive });
  const handled = await lightService.handle(refused.target);
  assert.equal(handled.handled && handled.result, "undeliverable");
  assert.equal(refused.answers.length, 0);
  assert.equal(light.calls.deliveries.some(item => item.kind === "intent"), false);
  assert.equal(lightService.holder("session-1", 7), "owner");

  const strong = fakePipeline(allow(true));
  const strongService = new InteractivePermissionDelivery({ pipeline: () => strong.pipeline, ledger: memoryLedger() });
  const delivered = fakeTarget({ request: destructive });
  assert.equal((await strongService.handle(delivered.target)).handled, true);
  assert.deepEqual(delivered.answers.map(item => item.option), [0]);
});

test("a reject is delivered only through a recognised one-shot reject option, with the fixed notice", async () => {
  const { pipeline } = fakePipeline(reject);
  const service = new InteractivePermissionDelivery({ pipeline: () => pipeline, ledger: memoryLedger() });
  const delivered = fakeTarget();
  const handled = await service.handle(delivered.target);
  assert.equal(handled.handled && handled.result, "rejected");
  assert.deepEqual(delivered.answers, [{ option: 1, notice: reject.kind === "reject" ? reject.notice : "" }]);

  const noReject = fakeTarget({ live: { ok: true, accept: 0 }, request: request({ id: "session-1:8:beef", prompt: { ...request().prompt!, id: 8 } }) });
  const refused = await service.handle(noReject.target);
  assert.equal(refused.handled && refused.result, "undeliverable");
  assert.equal(noReject.answers.length, 0, "the accept option is never used for a reject");
  assert.equal(service.holder("session-1", 8), "owner");
  assert.equal(service.ownerClass("session-1", 8), undefined, "an undeliverable request is a host limit and names no class");
});

test("the target's evidence collection reaches the decision, and an owner halt leaves the request to be handed again", async () => {
  let outcome: PermissionOutcome = { kind: "held" };
  const { pipeline, calls } = fakePipeline(async () => outcome);
  let now = 1_000_000;
  const service = new InteractivePermissionDelivery({ pipeline: () => pipeline, ledger: memoryLedger(), now: () => now });
  const { target, answers } = fakeTarget();
  const collect = async () => ({ files: [], limitations: [], digest: "none" });
  target.collect = collect;
  const held = await service.handle(target);
  assert.deepEqual([held.handled, held.handled ? undefined : held.held], [false, true]);
  assert.equal(calls.options[0]?.collect, collect);
  assert.equal(answers.length, 0, "nothing is delivered under a halt");
  // After the release the same request is decided from that time's evidence.
  outcome = allow(true);
  now += 31_000;
  assert.equal((await service.handle(target)).handled, true);
  assert.equal(calls.decide, 2);
  assert.equal(answers.length, 1);
});

test("a request that changed or closed before delivery is stale: nothing is sent and nobody is pushed", async () => {
  let checks = 0;
  const { pipeline, calls } = fakePipeline(allow());
  const service = new InteractivePermissionDelivery({ pipeline: () => pipeline, ledger: memoryLedger() });
  const { target, answers } = fakeTarget({ live: () => ++checks === 1 ? { ok: true, accept: 0, reject: 1 } : { ok: false, stale: true, reason: "The prompt changed." } });
  const handled = await service.handle(target);
  assert.deepEqual(handled, { handled: true, result: "stale", decisionId: "decision-1" });
  assert.equal(answers.length, 0);
  assert.deepEqual(calls.deliveries.map(item => item.kind), ["stale"]);
  assert.equal(service.holder("session-1", 7), "agent");
});

test("a person holding input control keeps the request: no decision runs and the owner is told as today", async () => {
  const { pipeline, calls } = fakePipeline(allow());
  const service = new InteractivePermissionDelivery({ pipeline: () => pipeline, ledger: memoryLedger() });
  const { target, answers } = fakeTarget({ live: { ok: false, stale: false, reason: "A person holds input control of the session." } });
  const handled = await service.handle(target);
  assert.equal(handled.handled, false);
  assert.equal(calls.decide, 0);
  assert.equal(answers.length, 0);
  assert.equal(service.holder("session-1", 7), "owner");
});

test("a decision whose authority was retired before delivery sends nothing", async () => {
  const { pipeline } = fakePipeline(allow(), { applicable: false });
  const service = new InteractivePermissionDelivery({ pipeline: () => pipeline, ledger: memoryLedger() });
  const { target, answers } = fakeTarget();
  assert.equal((await service.handle(target)).handled, false);
  assert.equal(answers.length, 0);
});

test("an owner act that retires the authority fences an answer in flight before the act is acknowledged", async () => {
  let applicable = true;
  const { pipeline } = fakePipeline(allow());
  pipeline.applicable = () => applicable;
  const service = new InteractivePermissionDelivery({ pipeline: () => pipeline, ledger: memoryLedger() });
  // The answer is with the session: it ends only when the fence stops it.
  let current: (() => boolean) | undefined, stop!: (result: "refused") => void, fences = 0;
  const { target } = fakeTarget();
  const started = new Promise<void>(resolve => {
    target.answer = (_option, _decisionId, _notice, live) => { current = live; resolve(); return new Promise(done => { stop = done; }); };
  });
  target.fence = async () => { fences++; stop("refused"); return true; };
  const handled = service.handle(target);
  await started;
  assert.equal(current!(), true, "the target reads the decision's authority again under its lease");
  assert.equal(await service.fenceRetired(), true);
  assert.equal(fences, 0, "a delivery whose authority still applies is left alone");

  applicable = false; // The owner's revoke is recorded.
  assert.equal(current!(), false, "after the revoke the target sends no key");
  assert.equal(await service.fenceRetired(), true);
  assert.equal(fences, 1, "the answer in flight is fenced at its session");
  const result = await handled;
  assert.deepEqual([result.handled, result.handled && result.result, result.handled && result.delivery], [true, "undeliverable", "refusal"]);
  assert.equal(await service.fenceRetired(), true, "nothing is in flight afterwards");

  // A target that cannot fence its delivery makes the fence unconfirmed, and the owner is told so.
  const blind = fakeTarget({ request: request({ id: "session-2:8:abcd" }) });
  let release!: (result: "uncertain") => void;
  const blindStarted = new Promise<void>(resolve => { blind.target.answer = () => { resolve(); return new Promise(done => { release = done; }); }; });
  applicable = true;
  const second = service.handle(blind.target);
  await blindStarted;
  applicable = false;
  assert.equal(await service.fenceRetired(), false);
  release("uncertain");
  await second;
});

test("an owner verdict leaves the dialog pending and makes it the owner's", async () => {
  const { pipeline } = fakePipeline({ kind: "owner", decisionId: "decision-3", interruptClass: "credentials" });
  const service = new InteractivePermissionDelivery({ pipeline: () => pipeline, ledger: memoryLedger() });
  const { target, answers } = fakeTarget();
  assert.deepEqual(await service.handle(target), { handled: true, result: "owner", decisionId: "decision-3", interruptClass: "credentials" });
  assert.equal(answers.length, 0);
  assert.equal(service.holder("session-1", 7), "owner");
  assert.equal(service.ownerClass("session-1", 7), "credentials", "the owner push names the class");
  // The same pending request is not decided again on the next scheduler pass.
  await service.handle(target);
  assert.equal(answers.length, 0);
});

test("the holder is undecided while an adapter claims a dialog and the agent's while it decides", async () => {
  let release!: (outcome: PermissionOutcome) => void;
  const { pipeline } = fakePipeline(() => new Promise<PermissionOutcome>(resolve => { release = resolve; }));
  const service = new InteractivePermissionDelivery({ pipeline: () => pipeline, ledger: memoryLedger() });
  service.addSource({ claims: (sessionId, promptId) => sessionId === "session-1" && promptId === 7 });
  assert.equal(service.holder("session-1", 7), "undecided");
  assert.equal(service.holder("session-2", 7), "owner");
  const { target } = fakeTarget();
  const pending = service.handle(target);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.holder("session-1", 7), "agent");
  assert.equal(service.handle(target), pending, "a second pass joins the running decision");
  release({ kind: "owner", decisionId: "decision-4", interruptClass: "money" });
  await pending;
  assert.equal(service.holder("session-1", 7), "owner");
});

test("a delivery whose result is unknown is not repeated after a restart, and goes to the owner while the dialog is open", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-permission-delivery-"));
  const path = evidenceDatabasePath(join(root, "state")), key = randomBytes(32);
  const open = () => { const store = new EvidenceStore({ databasePath: path, vaultKey: key }); store.register(permissionDeliveryModule); return store; };
  try {
    const first = open();
    const before = fakePipeline(allow());
    const crashed = new InteractivePermissionDelivery({ pipeline: () => before.pipeline, ledger: new EvidenceDeliveryLedger(first) });
    const lost = fakeTarget({ answer: "uncertain" });
    const handled = await crashed.handle(lost.target);
    assert.deepEqual(handled, { handled: true, result: "undeliverable", decisionId: "decision-1", delivery: "uncertain" });
    assert.equal(lost.answers.length, 1);
    first.close();

    const second = open();
    const after = fakePipeline(allow());
    const restarted = new InteractivePermissionDelivery({ pipeline: () => after.pipeline, ledger: new EvidenceDeliveryLedger(second) });
    const again = fakeTarget();
    const replayed = await restarted.handle(again.target);
    assert.equal(again.answers.length, 0, "no key is sent again");
    assert.equal(after.calls.decide, 0, "no new decision is taken for the same request");
    assert.equal(replayed.handled && replayed.result, "undeliverable");
    assert.equal(restarted.holder("session-1", 7), "owner");
    second.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an intent that could not be recorded sends nothing", async () => {
  const ledger = memoryLedger();
  ledger.set = () => { throw new Error("The evidence store is unavailable."); };
  const { pipeline } = fakePipeline(allow());
  const service = new InteractivePermissionDelivery({ pipeline: () => pipeline, ledger });
  const { target, answers } = fakeTarget();
  const handled = await service.handle(target);
  assert.equal(handled.handled && handled.result, "undeliverable");
  assert.equal(answers.length, 0);
});

test("a team member's source file that the review read must be unchanged at delivery", async () => {
  const root = "/home/dev/projects/infinite";
  const prompt = request().prompt!;
  const workspace = { changedPaths: [], evidence: { files: [], limitations: [], digest: "workspace" } };
  const built = teamPermissionRequest({
    run: { id: "run-1", projectId: "project-1", provider: "codex", title: "Run", objective: "Objective" } as never,
    member: { sessionId: "session-1", memberId: "member-1", role: "implementer", revision: 1 } as never,
    prompt, sessionRoot: root, workspace, acceptedChecks: null,
  });
  let content = "first";
  const target = teamPermissionTarget(built, {
    manager: { meta: () => { throw new Error("not reached"); }, state: async () => { throw new Error("not reached"); }, answerAgentPermission: async () => { throw new Error("not reached"); } } as never,
    assignment: { runId: "run-1", memberId: "member-1", revision: 1, role: "implementer" },
    runCheck: () => undefined,
    sessionRoot: () => root,
    workspace: async () => workspace,
    collect: async paths => ({ files: paths.map(path => ({ path, sha256: content, content })), limitations: [], digest: content }),
  });
  assert.equal((await target.collect!(["scripts/release.sh"])).files[0].content, "first");
  content = "second";
  const live = await target.check();
  assert.deepEqual([live.ok, live.ok ? undefined : live.stale, live.ok ? undefined : live.reason], [false, true, "A source file that the review read changed."]);
});

test("a team member's task that changed while the request was decided leaves the dialog with the owner", async () => {
  const root = "/home/dev/projects/infinite";
  const workspace = { changedPaths: [], evidence: { files: [], limitations: [], digest: "workspace" } };
  const run = { id: "run-1", projectId: "project-1", provider: "codex", title: "Run", objective: "Objective" };
  const built = teamPermissionRequest({
    run: run as never, member: { sessionId: "session-1", memberId: "member-1", role: "implementer", revision: 1 } as never,
    prompt: request().prompt!, sessionRoot: root, workspace, acceptedChecks: null,
  });
  let objective = "Objective";
  let reached = 0;
  const target = teamPermissionTarget(built, {
    manager: { meta: () => { reached++; throw new Error("stop here"); }, state: async () => { throw new Error("not reached"); }, answerAgentPermission: async () => { throw new Error("not reached"); } } as never,
    assignment: { runId: "run-1", memberId: "member-1", revision: 1, role: "implementer" },
    runCheck: () => undefined,
    sessionRoot: () => root,
    workspace: async () => workspace,
    task: () => teamPermissionTask({ ...run, objective }, undefined),
  });
  // The same task passes this check and reaches the session checks.
  await target.check();
  assert.equal(reached, 1);
  objective = "Objective, and never touch the release branch";
  assert.deepEqual(await target.check(), { ok: false, stale: false, reason: "The member's task changed after the request was read." });
  assert.equal(reached, 1);
});

