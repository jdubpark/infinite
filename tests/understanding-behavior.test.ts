import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRemoteClient, RemoteError, type BehaviorDefinition, type BehaviorModel, type KnowledgeComponent } from "@infinite/remote";
import { BehaviorError, UnderstandingBehaviorService } from "../packages/host/src/understanding-behavior.js";
import { UnderstandingCatalog } from "../packages/host/src/understanding-catalog.js";
import { UnderstandingRuntime, type RepoContext } from "../packages/host/src/understanding-runtime.js";
import type { ProjectGroup } from "../packages/host/src/project-group-types.js";
import type { Config } from "../packages/host/src/types.js";
import { startHost, waitFor } from "./helpers.js";
import { httpRunner } from "./remote-fixture.js";

const key = Buffer.alloc(32, 7);
const evidence = [{ repositoryId: "repo", source: "src/a.ts", line: 1 }];

function model(predicate: BehaviorModel["properties"][number]["predicate"] = { op: "eq", left: { variable: "enabled" }, right: { value: true } }): BehaviorModel {
  return {
    initial: "idle",
    states: [{ id: "idle", label: "Idle" }],
    variables: [{ id: "enabled", domain: [true], initial: true }],
    transitions: [{ id: "stay", from: "idle", to: "idle", label: "Stay", actor: "user", event: "continue", guard: { op: "true" }, effects: {}, evidence: structuredClone(evidence) }],
    properties: [{ id: "enabled", title: "Enabled remains true", kind: "safety", states: [], predicate, requirement: "Keep the feature enabled.", basis: "accepted", evidence: structuredClone(evidence) }],
  };
}

function definition(component: KnowledgeComponent, options: { id?: string; planRevisions?: BehaviorDefinition["planRevisions"]; planned?: BehaviorModel | null; current?: BehaviorModel } = {}): BehaviorDefinition {
  return {
    schemaVersion: 1, id: options.id ?? "login-flow", title: "Login flow", componentId: component.id, repositoryId: "repo",
    sourceSnapshotId: component.current.snapshotId, planRevisions: options.planRevisions ?? [], requirementRevision: "requirement-1",
    assumptions: ["The local session store is available."], exclusions: ["Provider delivery is outside this model."],
    current: options.current ?? model(), planned: options.planned ?? null,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
  assert.fail("Timed out waiting for behavior verification.");
}

function createDigitLeadingSnapshot(root: string) {
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const source = readFileSync(join(root, "src", "a.ts"));
  for (let index = 0; index < 10_000; index++) {
    const metadata = Buffer.from(`source map fixture ${index}`);
    writeFileSync(join(root, "metadata.txt"), metadata);
    const files = [
      ["metadata.txt", { hash: createHash("sha256").update(metadata).digest("hex"), lines: 1 }],
      ["src/a.ts", { hash: createHash("sha256").update(source).digest("hex"), lines: source.toString("utf8").split(/\r?\n/).length }],
    ] as const;
    const snapshotId = createHash("sha256").update(JSON.stringify({ head, files })).digest("hex");
    if (/^[0-9]/.test(snapshotId)) return snapshotId;
  }
  assert.fail("Could not prepare a numeric-leading source fingerprint fixture.");
}

function sourceContext(root: string): RepoContext {
  const source = readFileSync(join(root, "src", "a.ts"));
  const metadata = readFileSync(join(root, "metadata.txt"));
  const text = source.toString("utf8");
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const sourceHash = createHash("sha256").update(source).digest("hex");
  return {
    version: 1, repo: root, generatedAt: new Date().toISOString(), head, base: head,
    files: { "metadata.txt": { hash: createHash("sha256").update(metadata).digest("hex"), lines: 1 }, "src/a.ts": { hash: sourceHash, lines: text.split(/\r?\n/).length } },
    components: [{ id: "component", path: "src", name: "Auth", files: 1, examples: ["src/a.ts"], entryPoints: [], incoming: 0, outgoing: 0, changed: 0 }],
    edges: [], limitations: [],
  };
}

async function setup(t: test.TestContext, options: { symlinkEvidence?: boolean; dailyLimit?: number } = {}) {
  const base = mkdtempSync(join(tmpdir(), "understanding-behavior-"));
  const root = join(base, "repo"), stateDir = join(base, "state");
  mkdirSync(join(root, "src"), { recursive: true }); mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const enabled = true;\n");
  if (options.symlinkEvidence) {
    writeFileSync(join(base, "outside.ts"), "export const outside = true;\n");
    symlinkSync(join(base, "outside.ts"), join(root, "src", "link.ts"));
  }
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", "."]);
  execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  const numericSnapshot = createDigitLeadingSnapshot(root);
  const now = new Date().toISOString();
  let group: ProjectGroup = {
    id: "workspace", name: "Workspace", kind: "owner", hidden: false, implicit: false, revision: 1, createdAt: now, updatedAt: now,
    repos: [{ projectId: "repo", name: "Repository", path: root, checkouts: [{ projectId: "repo", name: "Repository", path: root, primary: true, teamReady: true }] }],
  };
  const groups = { list: () => ({ groups: group.repos.length ? [group] : [], suggestions: [] }), get: (id: string) => {
    if (id !== group.id) throw new Error("workspace unavailable");
    return group;
  } };
  const config = { stateDir, projects: [{ id: "repo", name: "Repository", path: root }] } as Config;
  const catalog = new UnderstandingCatalog({ config, key, groups });
  const runtime = new UnderstandingRuntime({ config, key, groups, catalog, adapter: { context: async sourceRoot => sourceContext(sourceRoot) } });
  runtime.refresh("workspace");
  await waitUntil(() => runtime.read("workspace").components.length === 1);
  assert.equal(runtime.read("workspace").components[0]!.current.snapshotId, numericSnapshot);
  const service = new UnderstandingBehaviorService({ config, key, groups, catalog, runtime });
  t.after(async () => { await service.close(); await runtime.close(); rmSync(base, { recursive: true, force: true }); });
  const component = runtime.read("workspace").components[0]!;
  const mutateContext = () => ({ work: [], components: runtime.read("workspace").components });
  if (options.dailyLimit) catalog.mutate("workspace", "policy", undefined, {
    requestId: randomUUID(), revision: 0, action: "update",
    value: { enabled: false, synthesis: false, delivery: false, intervalMinutes: 60, dailyJobLimit: options.dailyLimit },
  }, mutateContext());
  return { base, root, stateDir, config, groups, catalog, runtime, service, component, mutateContext, numericSnapshot,
    replaceGroup(next: ProjectGroup) { group = next; } };
}

async function waitForFinished(service: UnderstandingBehaviorService, id: string) {
  await waitUntil(() => service.get("workspace", id).runs.at(-1)?.state === "finished");
  return service.get("workspace", id);
}

test("service persists exact mutations, runs the finite checker, separates current and planned receipts, and allows a new run after edits", { timeout: 30000 }, async t => {
  const s = await setup(t);
  const input = definition(s.component, { planned: model({ op: "false" }) });
  const requestId = randomUUID();
  const saved = s.service.save("workspace", { requestId, revision: 0, definition: input });
  assert.equal(saved.revision, 1);
  assert.match(saved.definition.sourceSnapshotId, /^[0-9]/, "the real runtime-issued source snapshot begins with a digit");
  assert.equal(saved.status, "unchecked");
  assert.deepEqual(s.service.save("workspace", { requestId, revision: 0, definition: input }), saved, "an exact replay returns the retained behavior without incrementing its revision");
  assert.throws(() => s.service.save("workspace", { requestId, revision: 0, definition: { ...input, title: "Different" } }), (error: unknown) => error instanceof BehaviorError && error.statusCode === 409);

  const first = s.service.run("workspace", input.id, { requestId: randomUUID(), revision: 1 });
  assert.equal(first.runs.at(-1)?.state, "running");
  const completed = await waitForFinished(s.service, input.id);
  const receipt = completed.runs.at(-1)!;
  assert.equal(receipt.current?.status, "passed");
  assert.equal(receipt.planned?.status, "counterexample");
  assert.deepEqual(receipt.current?.limits, { maxStates: 10_000, maxTransitions: 100_000, timeoutMs: 2_000, maxTraceSteps: 128 });
  assert.equal(completed.status, "passed", "only the actual current-model check determines aggregate status");
  assert.equal(receipt.current?.exploredStates, 1);
  assert.equal(s.service.suite("workspace", input.id).files.some(file => file.path === "verification/Current.tla"), true);
  assert.equal(s.service.suite("workspace", input.id).files.some(file => file.path === "verification/Planned.tla"), true);

  const edited = { ...input, title: "Login flow revision two", requirementRevision: "requirement-2" };
  const revised = s.service.save("workspace", { requestId: randomUUID(), revision: 1, definition: edited });
  assert.equal(revised.revision, 2);
  assert.equal(revised.status, "stale", "the previous receipt remains visible as belonging to the prior definition revision");
  assert.equal(revised.freshness, "current", "historical receipt validity does not disable a new run on current source and plans");
  assert.throws(() => s.service.run("workspace", input.id, { requestId: randomUUID(), revision: 1 }), (error: unknown) => error instanceof BehaviorError && error.statusCode === 409);
  const next = s.service.run("workspace", input.id, { requestId: randomUUID(), revision: 2 });
  assert.equal(next.runs.at(-1)?.state, "running");
  assert.equal((await waitForFinished(s.service, input.id)).status, "passed");

  for (let index = 0; index < 8; index++) {
    s.service.run("workspace", input.id, { requestId: randomUUID(), revision: 2 });
    await waitUntil(() => s.service.get("workspace", input.id).runs.at(-1)?.state === "finished");
  }
  assert.equal(s.service.get("workspace", input.id).runs.length, 8, "the latest run receipts stay bounded without permanently blocking future checks");
});

test("oversized checker output and mutations preserve readable state and terminal admission receipts", { timeout: 30000 }, async t => {
  const s = await setup(t);
  const input = definition(s.component);
  s.service.save("workspace", { requestId: randomUUID(), revision: 0, definition: input });
  s.service.run("workspace", input.id, { requestId: randomUUID(), revision: 1 });
  const previous = (await waitForFinished(s.service, input.id)).runs[0]!;
  const largeModel: BehaviorModel = {
    initial: "step0",
    states: Array.from({ length: 64 }, (_, index) => ({ id: `step${index}`, label: `Step ${index}` })),
    variables: Array.from({ length: 32 }, (_, index) => ({ id: `value${index}`, domain: ["x".repeat(256)], initial: "x".repeat(256) })),
    transitions: Array.from({ length: 63 }, (_, index) => ({ ...model().transitions[0]!, id: `advance${index}`, from: `step${index}`, to: `step${index + 1}` })),
    properties: Array.from({ length: 8 }, (_, index) => ({ ...model({ op: "false" }).properties[0]!, id: `failure${index}`, states: ["step63"] })),
  };
  const large = definition(s.component, { current: largeModel });
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 96 * 1024, "the model fits the HTTP request bound despite repeated counterexample values");
  s.service.save("workspace", { requestId: randomUUID(), revision: 1, definition: large });
  const requestId = randomUUID();
  const admitted = s.service.run("workspace", input.id, { requestId, revision: 2 }).runs.at(-1)!;
  const completed = await waitForFinished(s.service, input.id);
  const limited = completed.runs.at(-1)!;
  assert.equal(completed.status, "error");
  assert.equal(limited.id, admitted.id);
  assert.equal(limited.current, null);
  assert.equal(limited.planned, null);
  assert.match(limited.message ?? "", /storage limit/i);
  assert.deepEqual(completed.runs[0], previous, "capacity exhaustion does not discard earlier results");
  assert.deepEqual(s.service.run("workspace", input.id, { requestId, revision: 2 }).runs, completed.runs, "retrying the UUID preserves the consumed admission");

  s.service.save("workspace", { requestId: randomUUID(), revision: 2, definition: input });
  s.service.run("workspace", input.id, { requestId: randomUUID(), revision: 3 });
  assert.equal((await waitForFinished(s.service, input.id)).status, "passed", "a smaller explicit run remains available without restarting");
  await s.service.close();
  const resumed = new UnderstandingBehaviorService({ config: s.config, key, groups: s.groups, catalog: s.catalog, runtime: s.runtime });
  t.after(() => resumed.close());
  assert.equal(resumed.get("workspace", input.id).status, "passed");
  assert.deepEqual(resumed.get("workspace", input.id).runs[1], limited, "the terminal capacity result survives restart");

  const domain = Array.from({ length: 128 }, (_, index) => `${String(index).padStart(3, "0")}${"x".repeat(253)}`);
  const oversizedModel = { ...model({ op: "true" }), variables: Array.from({ length: 64 }, (_, index) => ({ id: `value${index}`, domain, initial: domain[0]! })) };
  const oversized = definition(s.component, { id: "oversized", current: oversizedModel, planned: oversizedModel });
  assert.throws(() => resumed.save("workspace", { requestId: randomUUID(), revision: 0, definition: oversized }),
    (error: unknown) => error instanceof BehaviorError && error.statusCode === 409);
  assert.equal(resumed.list("workspace").behaviors.length, 1, "a rejected mutation leaves prior state readable and unchanged");
});

test("restart preserves interrupted admission and allows only a new explicit request within the daily budget", { timeout: 30000 }, async t => {
  const s = await setup(t, { dailyLimit: 2 });
  const input = definition(s.component);
  s.service.save("workspace", { requestId: randomUUID(), revision: 0, definition: input });
  const admitted = s.service.run("workspace", input.id, { requestId: randomUUID(), revision: 1 });
  assert.equal(admitted.runs.at(-1)?.state, "running");
  await s.service.close();
  const resumed = new UnderstandingBehaviorService({ config: s.config, key, groups: s.groups, catalog: s.catalog, runtime: s.runtime });
  const interrupted = resumed.get("workspace", input.id);
  assert.equal(interrupted.runs.at(-1)?.state, "interrupted");
  assert.equal(interrupted.status, "stale");
  assert.equal(interrupted.freshness, "current", "interruption stales the result while current source and plan bindings remain eligible");
  assert.ok(interrupted.coverage.some(value => value.includes("admission remains consumed")));
  const replay = resumed.run("workspace", input.id, { requestId: randomUUID(), revision: 1 });
  assert.equal(replay.runs.at(-1)?.state, "running", "a fresh UUID requests a new bounded check after restart");
  const finished = await waitForFinished(resumed, input.id);
  assert.equal(finished.status, "passed");
  assert.throws(() => resumed.run("workspace", input.id, { requestId: randomUUID(), revision: 1 }), (error: unknown) => error instanceof BehaviorError && error.statusCode === 429);
  await resumed.close();
});

test("run admission is single-flight and exact request IDs cannot be reused for different operations", { timeout: 30000 }, async t => {
  const s = await setup(t);
  const first = definition(s.component, { id: "first-flow" }), second = definition(s.component, { id: "second-flow" });
  s.service.save("workspace", { requestId: randomUUID(), revision: 0, definition: first });
  s.service.save("workspace", { requestId: randomUUID(), revision: 0, definition: second });
  const requestId = randomUUID();
  s.service.run("workspace", first.id, { requestId, revision: 1 });
  assert.throws(() => s.service.run("workspace", second.id, { requestId: randomUUID(), revision: 1 }), (error: unknown) => error instanceof BehaviorError && error.statusCode === 409);
  const replay = s.service.run("workspace", first.id, { requestId, revision: 1 });
  assert.equal(replay.runs.at(-1)?.state, "running", "replaying the same admitted request does not consume another slot");
  assert.throws(() => s.service.save("workspace", { requestId, revision: 0, definition: first }), (error: unknown) => error instanceof BehaviorError && error.statusCode === 409);
  const completed = await waitForFinished(s.service, first.id);
  assert.equal(s.service.run("workspace", first.id, { requestId, revision: 1 }).runs.at(-1)?.id, completed.runs.at(-1)?.id,
    "a completed request replay returns its receipt and does not start another checker run");
  s.service.run("workspace", second.id, { requestId: randomUUID(), revision: 1 });
  writeFileSync(join(s.root, "src", "a.ts"), "export const enabled = false;\n");
  await waitUntil(() => s.service.get("workspace", second.id).runs.at(-1)?.state === "interrupted");
  const refused = s.service.get("workspace", second.id);
  assert.equal(refused.runs.at(-1)?.current, null, "the checker is not invoked after the source changes between admission and worker start");
  assert.equal(refused.freshness, "stale");
});

test("source edits, complete plan-set changes, membership removal, and checkout rebinding invalidate the saved scope", { timeout: 30000 }, async t => {
  const s = await setup(t);
  const input = definition(s.component);
  s.service.save("workspace", { requestId: randomUUID(), revision: 0, definition: input });
  const planId = randomUUID();
  s.catalog.mutate("workspace", "plans", undefined, { requestId: planId, revision: s.catalog.read("workspace").revision, action: "create",
    value: { componentId: input.componentId, repositoryIds: ["repo"], title: "Plan", text: "Plan the transition.", status: "proposed", sourceUrl: null, workId: null } }, s.mutateContext());
  assert.equal(s.service.get("workspace", input.id).freshness, "stale", "an added active plan invalidates an incomplete plan revision set");
  assert.throws(() => s.service.run("workspace", input.id, { requestId: randomUUID(), revision: 1 }), (error: unknown) => error instanceof BehaviorError && error.statusCode === 409,
    "a plan-set change alone blocks a new checker admission");

  writeFileSync(join(s.root, "src", "a.ts"), "export const enabled = false;\n");
  assert.equal(s.service.get("workspace", input.id).freshness, "stale", "dirty covered-file edits are checked against disk hashes");
  assert.throws(() => s.service.run("workspace", input.id, { requestId: randomUUID(), revision: 1 }), (error: unknown) => error instanceof BehaviorError && error.statusCode === 409);
  const plan = s.catalog.read("workspace").plans[0]!;
  const rebound = { ...input, planRevisions: [{ id: plan.id, revision: plan.revision }] };
  assert.throws(() => s.service.save("workspace", { requestId: randomUUID(), revision: 1, definition: rebound }), (error: unknown) => error instanceof BehaviorError && error.statusCode === 409, "dirty source files cannot be rebound by resaving the stale map");

  // Refresh a new source observation after the covered file edit, then bind the complete plan set.
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").components[0]?.current.snapshotId !== input.sourceSnapshotId);
  const currentComponent = s.runtime.read("workspace").components[0]!;
  const refreshed = definition(currentComponent, { planRevisions: [{ id: plan.id, revision: plan.revision }] });
  const saved = s.service.save("workspace", { requestId: randomUUID(), revision: 1, definition: refreshed });
  assert.equal(saved.revision, 2);
  s.service.run("workspace", refreshed.id, { requestId: randomUUID(), revision: 2 });
  await waitForFinished(s.service, refreshed.id);

  const removed = structuredClone((s as any).groups.get("workspace")) as ProjectGroup;
  removed.repos = [];
  s.replaceGroup(removed);
  assert.equal(s.service.get("workspace", refreshed.id).freshness, "stale", "workspace membership is rechecked on every read");
});

test("repository replacement and malformed or out-of-scope evidence fail closed", { timeout: 30000 }, async t => {
  const s = await setup(t);
  const baseDefinition = definition(s.component);
  const invalids = [
    { ...baseDefinition, current: { ...baseDefinition.current, transitions: [{ ...baseDefinition.current.transitions[0]!, evidence: [{ repositoryId: "other", source: "src/a.ts", line: 1 }] }] } },
    { ...baseDefinition, current: { ...baseDefinition.current, transitions: [{ ...baseDefinition.current.transitions[0]!, evidence: [{ repositoryId: "repo", source: "../outside.ts", line: 1 }] }] } },
    { ...baseDefinition, current: { ...baseDefinition.current, properties: [{ ...baseDefinition.current.properties[0]!, evidence: [{ repositoryId: "repo", source: "src/a.ts", line: 99 }] }] } },
  ];
  for (const invalid of invalids) assert.throws(() => s.service.save("workspace", { requestId: randomUUID(), revision: 0, definition: invalid }), (error: unknown) => error instanceof BehaviorError && (error.statusCode === 400 || error.statusCode === 409));

  const accepted = s.service.save("workspace", { requestId: randomUUID(), revision: 0, definition: baseDefinition });
  const moved = `${s.root}-old`;
  renameSync(s.root, moved);
  mkdirSync(join(s.root, "src"), { recursive: true });
  writeFileSync(join(s.root, "src", "a.ts"), "export const enabled = true;\n");
  execFileSync("git", ["init", "-q", s.root]);
  execFileSync("git", ["-C", s.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", "."]);
  execFileSync("git", ["-C", s.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "replacement"]);
  assert.equal(s.service.get("workspace", accepted.id).freshness, "stale", "same-path replacement changes the root inode binding");
  assert.throws(() => s.service.run("workspace", accepted.id, { requestId: randomUUID(), revision: 1 }), (error: unknown) => error instanceof BehaviorError && error.statusCode === 409);
});

test("symlinked covered files and corrupt encrypted behavior state are unavailable", { timeout: 30000 }, async t => {
  const s = await setup(t, { symlinkEvidence: true });
  const symlinkContext: RepoContext = {
    ...sourceContext(s.root),
    files: { "src/link.ts": { hash: createHash("sha256").update(readFileSync(join(s.base, "outside.ts"))).digest("hex"), lines: 1 } },
    components: [{ id: "component", path: "src", name: "Auth", files: 1, examples: ["src/link.ts"], entryPoints: [], incoming: 0, outgoing: 0, changed: 0 }],
  };
  // Build an observation whose captured component file is a symlink, then let the service inspect it.
  const runtime = new UnderstandingRuntime({ config: s.config, key, groups: s.groups, catalog: s.catalog, adapter: { context: async () => symlinkContext } });
  runtime.refresh("workspace");
  await waitUntil(() => runtime.read("workspace").components[0]?.files[0]?.path === "src/link.ts");
  const symlinkComponent = runtime.read("workspace").components[0]!;
  const symlinkService = new UnderstandingBehaviorService({ config: s.config, key, groups: s.groups, catalog: s.catalog, runtime });
  assert.throws(() => symlinkService.save("workspace", { requestId: randomUUID(), revision: 0, definition: definition(symlinkComponent, { id: "linked-flow" }) }),
    (error: unknown) => error instanceof BehaviorError && error.statusCode === 409);
  await symlinkService.close();
  await runtime.close();

  const path = join(s.stateDir, "understanding", "behaviors", "workspace.sealed");
  mkdirSync(join(s.stateDir, "understanding", "behaviors"), { recursive: true });
  writeFileSync(path, "corrupt");
  const corrupt = new UnderstandingBehaviorService({ config: s.config, key, groups: s.groups, catalog: s.catalog, runtime: s.runtime });
  assert.throws(() => corrupt.list("workspace"), (error: unknown) => error instanceof BehaviorError && error.statusCode === 503 && !error.message.includes(s.root));
  await corrupt.close();
});

test("HTTP routes enforce owner-only mutations, read roles, component attachment, and exact relay paths", { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "understanding-behavior-api-"));
  const repository = join(root, "repo"); mkdirSync(join(repository, "src"), { recursive: true });
  writeFileSync(join(repository, "src", "a.ts"), "export const enabled = true;\n");
  execFileSync("git", ["init", "-q", repository]);
  execFileSync("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", "."]);
  execFileSync("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  const numericSnapshot = createDigitLeadingSnapshot(repository);
  const script = [
    'const{execFileSync}=require("node:child_process"),{readFileSync}=require("node:fs"),{createHash}=require("node:crypto");',
    'const root=process.argv[process.argv.indexOf("--repo")+1],head=execFileSync("git",["-C",root,"rev-parse","HEAD"],{encoding:"utf8"}).trim(),bytes=readFileSync(root+"/src/a.ts"),text=bytes.toString("utf8");',
    'const metadata=readFileSync(root+"/metadata.txt");',
    'process.stdout.write(JSON.stringify({version:1,repo:root,generatedAt:new Date().toISOString(),head,base:head,files:{"metadata.txt":{hash:createHash("sha256").update(metadata).digest("hex"),lines:1},"src/a.ts":{hash:createHash("sha256").update(bytes).digest("hex"),lines:text.split(/\\r?\\n/).length}},components:[{id:"component",path:"src",name:"Auth",files:1,examples:["src/a.ts"],entryPoints:[],incoming:0,outgoing:0,changed:0}],edges:[],limitations:[]}));',
  ].join("\n");
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  t.after(async () => { await host?.stop(); rmSync(root, { recursive: true, force: true }); });
  host = await startHost({ config: { projects: [{ id: "repo", name: "Repository", path: repository }], repositoryBriefings: {
    command: process.execPath, args: ["-e", script], automatic: false, intervalMs: 60_000, cooldownMs: 0, timeoutMs: 10_000,
  } } });
  const workspace = (await host.fetchApi("/project-groups/repo", "viewer")).body;
  const basePath = `/project-groups/${workspace.id}/understanding`;
  assert.equal((await host.fetchApi(`${basePath}/refresh`, "owner", {})).status, 202);
  await waitFor(async () => host!.fetchApi(`${basePath}/components`, "viewer"), value => value.body.components.length === 1);
  const component = (await host.fetchApi(`${basePath}/components/${(await host.fetchApi(`${basePath}/components`, "viewer")).body.components[0].id}`, "viewer")).body.component;
  assert.equal(component.current.snapshotId, numericSnapshot);
  const input = definition(component);
  const path = `${basePath}/behaviors`;
  const ownerRead = await host.fetchApi(`${basePath}/behaviors`, "owner");
  const jobsBeforeRead = (await host.fetchApi(basePath, "viewer")).body.knowledge.maintenance.jobsToday;
  for (const role of ["viewer", "controller"] as const) {
    assert.equal((await host.fetchApi(path, role)).status, 200);
    assert.equal((await host.fetchApi(`${path}/${input.id}/suite`, role)).status, 404);
    assert.equal((await host.fetchApi(path, role, { requestId: randomUUID(), revision: 0, definition: input })).status, 403);
    assert.equal((await host.fetchApi(`${path}/${input.id}/run`, role, { requestId: randomUUID(), revision: 1 })).status, 403);
  }
  assert.equal((await host.fetchApi(`${basePath}/components/${component.id}`, "viewer")).body.behaviors.length, 0);
  assert.equal((await host.fetchApi(basePath, "viewer")).body.knowledge.maintenance.jobsToday, jobsBeforeRead, "read endpoints do not admit a source or checker job");
  const saved = await host.fetchApi(path, "owner", { requestId: randomUUID(), revision: 0, definition: input });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await host.fetchApi(`${path}/${input.id}`, "viewer")).status, 200);
  assert.equal((await host.fetchApi(`${path}/${input.id}/suite`, "controller")).body.files.some((file: { path: string }) => file.path === "verification/Current.tla"), true);
  assert.equal((await host.fetchApi(`${basePath}/components/${component.id}`, "viewer")).body.behaviors[0].id, input.id);
  const run = await host.fetchApi(`${path}/${input.id}/run`, "owner", { requestId: randomUUID(), revision: 1 });
  assert.equal(run.status, 202);
  await waitFor(async () => host!.fetchApi(`${path}/${input.id}`, "viewer"), value => value.body.runs.at(-1)?.state === "finished");
  assert.equal((await host.fetchApi(`${path}/${input.id}`, "viewer")).body.runs.at(-1).current.status, "passed");
  assert.equal(ownerRead.body.coverage.some((value: string) => value.includes("model")), true);

  const relay = await httpRunner();
  const remote = createRemoteClient({ url: relay.url, token: relay.token });
  try {
    const rootPath = `/project-groups/${workspace.id}/understanding/behaviors`;
    for (const [route, options] of [
      [rootPath, {}], [`${rootPath}/${input.id}`, {}], [`${rootPath}/${input.id}/suite`, {}],
      [rootPath, { method: "POST", body: { requestId: randomUUID(), revision: 0, definition: input } }],
      [`${rootPath}/${input.id}/run`, { method: "POST", body: { requestId: randomUUID(), revision: 1 } }],
    ] as const) await remote.request(route, options);
    for (const [route, method] of [
      [`${rootPath}/${input.id}/run`, "GET"], [`${rootPath}/${input.id}/suite`, "POST"], [`${rootPath}/unexpected/extra`, "GET"],
    ] as const) await assert.rejects(remote.request(route, { method }), (error: unknown) => error instanceof RemoteError && error.status === 403, `${method} ${route} must be denied by the relay allowlist`);
  } finally { remote.close(); relay.close(); }
});
