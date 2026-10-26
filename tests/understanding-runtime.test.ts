import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UnderstandingRuntime, type RepoContext, type UnderstandingAdapter } from "../packages/host/src/understanding-runtime.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import { CatalogError, UnderstandingCatalog } from "../packages/host/src/understanding-catalog.js";
import { createUnderstandingAdapter } from "../packages/host/src/understanding-adapter.js";
import type { KnowledgeCatalog } from "@infinite/remote";
import type { ProjectGroup } from "../packages/host/src/project-group-types.js";
import type { Config } from "../packages/host/src/types.js";

const catalog = (): KnowledgeCatalog => ({ revision: 1, projects: [], features: [], plans: [], componentOverrides: [], policy: { enabled: false, synthesis: false, delivery: false, intervalMinutes: 60, dailyJobLimit: 5 }, coverage: [] });
const sampleContext = (root: string): RepoContext => {
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const hash = (path: string) => createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
  return { version: 1, repo: root, generatedAt: new Date().toISOString(), head, base: head,
  files: { "src/a.ts": { hash: hash("src/a.ts"), lines: 3 }, "src/b.ts": { hash: hash("src/b.ts"), lines: 5 } },
    components: [
      { id: "unstable-a", path: "src/a.ts", name: "A", files: 1, examples: ["src/a.ts"], entryPoints: [], incoming: 0, outgoing: 1, changed: 0 },
      { id: "unstable-b", path: "src/b.ts", name: "B", files: 1, examples: ["src/b.ts"], entryPoints: [], incoming: 1, outgoing: 0, changed: 0 },
    ], edges: [{ from: "unstable-a", to: "unstable-b", count: 1, examples: ["src/a.ts → src/b.ts"] }], limitations: ["Static imports cover JavaScript and TypeScript only."] };
};
function setup(t: test.TestContext, options: { adapter?: UnderstandingAdapter; processFixture?: boolean; multiRepo?: boolean; briefProcess?: boolean; fixtureMode?: string } = {}) {
  const base = mkdtempSync(join(tmpdir(), "understanding-runtime-")), root = join(base, "repo"), stateDir = join(base, "state");
  mkdirSync(join(root, "src"), { recursive: true }); mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n"); writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
  execFileSync("git", ["init", "-q", root]); execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", "."]); execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  const secondRoot = join(base, "repo-two");
  const repoRows: ProjectGroup["repos"] = [{ projectId: "repo", name: "Repository", path: root, checkouts: [{ projectId: "repo", name: "Repository", path: root, primary: true, teamReady: true }] }];
  if (options.multiRepo) {
    mkdirSync(join(secondRoot, "src"), { recursive: true }); writeFileSync(join(secondRoot, "src", "a.ts"), "export const a = 3;\n"); writeFileSync(join(secondRoot, "src", "b.ts"), "export const b = 4;\n");
    execFileSync("git", ["init", "-q", secondRoot]); execFileSync("git", ["-C", secondRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", "."]); execFileSync("git", ["-C", secondRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    repoRows.push({ projectId: "repo-two", name: "Repository Two", path: secondRoot, checkouts: [{ projectId: "repo-two", name: "Repository Two", path: secondRoot, primary: true, teamReady: true }] });
  }
  const group: ProjectGroup = { id: "workspace", name: "Workspace", kind: "owner", hidden: false, repos: repoRows, implicit: false, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const groups = { list: () => ({ groups: [group], suggestions: [] }), get: () => group };
  let currentCatalog = catalog();
  const config = { stateDir, projects: [{ id: "repo", name: "Repository", path: root }, ...(options.multiRepo ? [{ id: "repo-two", name: "Repository Two", path: secondRoot }] : [])], ...(options.processFixture || options.briefProcess ? { repositoryBriefings: { command: process.execPath, args: options.briefProcess ? [join(process.cwd(), "tests/fixtures/understanding-process.mjs"), options.fixtureMode ?? "ok"] : [join(process.cwd(), "tests/fixtures/jevcode-context.mjs")], automatic: false, intervalMs: 10000, cooldownMs: 0, timeoutMs: 10000 } } : {}) } as Config;
  const runtime = new UnderstandingRuntime({ config, key: Buffer.alloc(32, 7), groups, catalog: { read: () => currentCatalog }, ...(options.adapter ? { adapter: options.adapter } : options.briefProcess ? { adapter: createUnderstandingAdapter(config) } : {}) });
  t.after(async () => { await runtime.close(); rmSync(base, { recursive: true, force: true }); });
  return { runtime, root, secondRoot, stateDir, group, config, setCatalog(value: KnowledgeCatalog) { currentCatalog = value; } };
}
async function waitUntil(predicate: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (predicate()) return; await new Promise(resolvePromise => setTimeout(resolvePromise, 10)); }
  assert.fail("timed out waiting for Understanding maintenance");
}

test("fixture process publishes stable component maps, validated source edges, and survives restart", { timeout: 20000 }, async t => {
  const s = setup(t, { processFixture: true });
  const initial = s.runtime.read("workspace");
  assert.equal(initial.components.length, 0, "a read does not schedule source collection");
  const queued = s.runtime.refresh("workspace");
  assert.equal(queued.state, "queued");
  await waitUntil(() => s.runtime.read("workspace").components.length === 2);
  const first = s.runtime.read("workspace");
  assert.equal(first.relationships.length, 1);
  assert.equal(first.relationships[0].basis, "source");
  assert.equal(first.relationships[0].evidence[0].line, null);
  assert.match(first.components[0].id, /^cmp_[a-f0-9]{24}$/);
  assert.equal(s.runtime.read("workspace").maintenance.jobsToday, 1);
  await s.runtime.close();
  const resumed = new UnderstandingRuntime({ config: { stateDir: s.stateDir, projects: [{ id: "repo", name: "Repository", path: s.root }] } as Config, key: Buffer.alloc(32, 7), groups: { list: () => ({ groups: [s.group], suggestions: [] }), get: () => s.group }, catalog: { read: () => catalog() } });
  try {
    assert.equal(resumed.read("workspace").components[0].id, first.components[0].id);
    assert.equal(resumed.read("workspace").relationships.length, 1);
    assert.equal(resumed.read("workspace").maintenance.jobsToday, 1);
  } finally { await resumed.close(); }
});

test("stored contexts are served only for repositories whose binding still matches", { timeout: 20000 }, async t => {
  const s = setup(t, { processFixture: true });
  assert.deepEqual(s.runtime.readWithContexts("workspace").contexts, {}, "no context before a map is published");
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").components.length === 2);
  const accepted = s.runtime.readWithContexts("workspace");
  assert.equal(accepted.contexts.repo?.head, accepted.knowledge.components[0].current.sources[0]?.head ?? accepted.contexts.repo?.head);
  assert.ok(accepted.contexts.repo?.generatedAt, "an accepted repository exposes its stored context");
  // Replace the checkout with a different repository at the same path: the stored map and its context are rejected together.
  rmSync(join(s.root, ".git"), { recursive: true, force: true });
  execFileSync("git", ["init", "-q", s.root]);
  execFileSync("git", ["-C", s.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", "."]);
  execFileSync("git", ["-C", s.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "replaced"]);
  const rejected = s.runtime.readWithContexts("workspace");
  assert.equal(rejected.knowledge.components.length, 0, "a rebound checkout hides the stored map");
  assert.deepEqual(rejected.contexts, {}, "a rejected binding supplies no context provenance");
});

test("explicit refresh coalesces and rejects publication when the workspace binding moves during collection", { timeout: 20000 }, async t => {
  let release: (() => void) | undefined, calls = 0;
  const s = setup(t, { adapter: { context: async root => { calls++; const context = sampleContext(root); await new Promise<void>(resolvePromise => { release = resolvePromise; }); return context; } } });
  const first = s.runtime.refresh("workspace");
  const second = s.runtime.refresh("workspace");
  assert.equal(second.state, "queued");
  await waitUntil(() => Boolean(release));
  // Invalidate the source identity at the read boundary while the adapter is awaited.
  const moved = `${s.root}-moved`;
  (await import("node:fs")).renameSync(s.root, moved);
  release!();
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "failed");
  assert.equal(calls, 1);
  assert.equal(s.runtime.read("workspace").components.length, 0);
  assert.equal(first.state, "queued");
});

test("failed or invalid context capture retains the previous encrypted generation", { timeout: 20000 }, async t => {
  let fail = false, invalid = false;
  const s = setup(t, { adapter: { context: async root => { if (fail) throw new Error("fixture failure"); if (invalid) return { repo: root } as RepoContext; return sampleContext(root); } } });
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").components.length === 2);
  const before = s.runtime.read("workspace").components.map(component => component.id);
  fail = true;
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "failed");
  assert.deepEqual(s.runtime.read("workspace").components.map(component => component.id), before);
  fail = false; invalid = true;
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "failed");
  assert.deepEqual(s.runtime.read("workspace").components.map(component => component.id), before);
  assert.ok(readFileSync(join(s.stateDir, "understanding", "runtime.sealed"), "utf8").length > 0);
});

test("a failed job records a readable reason and clears it on the next success", { timeout: 20000 }, async t => {
  let fail = true;
  const s = setup(t, { adapter: { context: async root => { if (fail) throw new Error("engine exploded"); return sampleContext(root); } } });
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "failed");
  const failed = s.runtime.read("workspace").maintenance;
  assert.match(failed.message ?? "", /^Last attempt failed at \d{4}-.*: Repository Repository: engine exploded\.$/);
  assert.equal(failed.lastFailure?.reason, "Repository Repository: engine exploded");
  fail = false;
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").components.length === 2);
  assert.equal(s.runtime.read("workspace").maintenance.lastFailure, null);
});

for (const { configuredMs, expectedBudgets } of [
  // Each engine call leaves the 5 s re-check reserve; the mocked clock makes the capture take no time.
  { configuredMs: 180_000, expectedBudgets: [175_000, 55_000] },
  { configuredMs: 600_000, expectedBudgets: [595_000, 475_000] },
]) test(`workspace synthesis shares the ${configuredMs}ms deadline between component invocations and rotates repositories`, { timeout: 30000 }, async t => {
  const calls: string[][] = [];
  const budgets: number[] = [];
  let now = Date.now();
  let exhaustRemaining = false;
  t.mock.method(Date, "now", () => now);
  const adapter: UnderstandingAdapter = {
    context: async root => sampleContext(root),
    synthesize: async (input, options) => {
      calls.push(input.components.map(component => `${input.repositoryId}:${component.id}`));
      budgets.push(options.timeoutMs);
      if (exhaustRemaining) now += options.timeoutMs;
      else if (calls.length % 2 === 1) now += 120_000;
      const generatedAt = new Date().toISOString();
      return { components: input.components.map(component => ({ ...component, current: { ...component.current, state: "ready" as const, summary: "Synthesis fixture result.", generatedAt }, difference: { ...component.difference, snapshotId: component.current.snapshotId, generatedAt, planRevisions: component.planned.map(plan => ({ id: plan.id, revision: plan.revision })) } })), coverage: [] };
    },
  };
  const s = setup(t, { adapter, multiRepo: true, processFixture: true });
  s.config.repositoryBriefings!.timeoutMs = configuredMs;
  s.setCatalog({ ...catalog(), policy: { enabled: false, synthesis: true, delivery: false, intervalMinutes: 60, dailyJobLimit: 5 } });
  s.runtime.refresh("workspace");
  await new Promise<void>(resolvePromise => setImmediate(resolvePromise));
  assert.equal(s.runtime.read("workspace").maintenance.state, "idle");
  assert.equal(calls.flat().length, 2);
  assert.ok(calls.every(call => call.length === 1), "each component writer must receive its own timeout envelope");
  assert.deepEqual(budgets, expectedBudgets, "the second invocation receives only the remaining workspace budget");
  assert.equal(s.runtime.read("workspace").maintenance.jobsToday, 1);
  s.runtime.refresh("workspace");
  await new Promise<void>(resolvePromise => setImmediate(resolvePromise));
  assert.equal(s.runtime.read("workspace").maintenance.state, "idle");
  assert.equal(calls.flat().length, 4);
  assert.ok(calls.every(call => call.length === 1));
  assert.deepEqual(budgets, [...expectedBudgets, ...expectedBudgets]);
  assert.equal(s.runtime.read("workspace").maintenance.jobsToday, 2);
  assert.deepEqual(new Set(calls.flat().map(value => value.split(":")[0])), new Set(["repo", "repo-two"]));
  assert.equal(s.runtime.read("workspace").components.filter(component => component.current.state === "ready").length, 4);
  const published = s.runtime.read("workspace");
  writeFileSync(join(s.root, "src", "a.ts"), "export const a = 9;\n");
  exhaustRemaining = true;
  s.runtime.refresh("workspace");
  await new Promise<void>(resolvePromise => setImmediate(resolvePromise));
  const exhausted = s.runtime.read("workspace");
  assert.equal(exhausted.maintenance.state, "failed");
  assert.equal(exhausted.maintenance.jobsToday, 3);
  assert.equal(calls.length, 5, "the exhausted workspace deadline must refuse the next component callback");
  assert.match(exhausted.maintenance.message ?? "", /Repository Repository: synthesis unavailable: understanding-attempt-deadline/);
  const changed = exhausted.components.filter(component => component.repositoryIds.includes("repo"));
  assert.deepEqual(changed.map(component => component.current.state).sort(), ["mapped", "ready"], "the explained component publishes; the refused one keeps the new source map");
  assert.ok(changed.every(component => component.current.snapshotId !== published.components.find(item => item.id === component.id)!.current.snapshotId), "the new source map is published");
  assert.deepEqual(exhausted.components.filter(component => component.repositoryIds.includes("repo-two")), published.components.filter(component => component.repositoryIds.includes("repo-two")));
});

test("a source fingerprint change during synthesis rejects the candidate generation", { timeout: 20000 }, async t => {
  const adapter: UnderstandingAdapter = {
    context: async root => sampleContext(root),
    synthesize: async input => {
      writeFileSync(join(input.root, "src", "a.ts"), "export const a = 9;\n");
      const generatedAt = new Date().toISOString();
      return { components: input.components.map(component => ({ ...component, current: { ...component.current, state: "ready" as const, summary: "Stale synthesis result.", generatedAt }, difference: { ...component.difference, snapshotId: component.current.snapshotId, generatedAt, planRevisions: component.planned.map(plan => ({ id: plan.id, revision: plan.revision })) } })), coverage: [] };
    },
  };
  const s = setup(t, { adapter });
  s.setCatalog({ ...catalog(), policy: { enabled: false, synthesis: true, delivery: false, intervalMinutes: 60, dailyJobLimit: 5 } });
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "failed");
  assert.equal(s.runtime.read("workspace").components.length, 0);
});

test("a plan edit during another repository's final observation rejects the whole publication", { timeout: 20000 }, async t => {
  let release: (() => void) | undefined;
  let synthesized = false;
  const adapter: UnderstandingAdapter = {
    context: async root => {
      if (synthesized && root === realpathSync(s.secondRoot))
        await new Promise<void>(resolvePromise => { release = resolvePromise; });
      const context = sampleContext(root);
      return { ...context, components: context.components.slice(0, 1), edges: [] };
    },
    synthesize: async input => {
      synthesized = true;
      const generatedAt = new Date().toISOString();
      return { components: input.components.map(component => ({ ...component,
        current: { ...component.current, state: "ready" as const, summary: "Explanation of the original plan.", generatedAt },
        difference: { ...component.difference, snapshotId: component.current.snapshotId, generatedAt,
          planRevisions: component.planned.map(plan => ({ id: plan.id, revision: plan.revision })) },
      })), coverage: [] };
    },
    delivery: async input => ({ repositoryId: input.repositoryId, state: "ready", observedAt: new Date().toISOString(), pullRequests: [], environments: [], coverage: [] }),
  };
  const s = setup(t, { adapter, multiRepo: true });
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "idle");
  const before = s.runtime.read("workspace").components.map(component => component.current);
  const component = s.runtime.read("workspace").components.find(item => item.repositoryIds.includes("repo"))!;
  const at = new Date().toISOString();
  const original: KnowledgeCatalog = { ...catalog(), plans: [{ id: "plan", revision: 1,
    componentId: component.id, repositoryIds: ["repo"], title: "Publication contract", text: "Original requirement",
    status: "accepted", sourceUrl: null, workId: null, archived: false, createdAt: at, updatedAt: at, history: [],
  }], policy: { ...catalog().policy, synthesis: true, delivery: true } };
  s.setCatalog(original);
  s.runtime.refresh("workspace");
  await waitUntil(() => Boolean(release));
  s.setCatalog({ ...original, revision: 2, plans: original.plans.map(plan => ({ ...plan, revision: 2, text: "Changed requirement" })) });
  release!();
  await waitUntil(() => !["queued", "running"].includes(s.runtime.read("workspace").maintenance.state));
  const after = s.runtime.read("workspace");
  assert.equal(after.maintenance.state, "failed", "a previously checked repository's plan can change during the later await");
  assert.deepEqual(after.components.map(item => item.current), before, "the prior generation remains published");
});

test("restart recovers an admitted running job without resetting its daily budget", { timeout: 20000 }, async t => {
  let release!: () => void;
  const adapter: UnderstandingAdapter = { context: async root => { await new Promise<void>(resolvePromise => { release = resolvePromise; }); return sampleContext(root); } };
  const s = setup(t, { adapter });
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "running" && Boolean(release));
  const restartDir = join(s.stateDir, "restart"); mkdirSync(restartDir, { recursive: true });
  cpSync(join(s.stateDir, "understanding"), join(restartDir, "understanding"), { recursive: true });
  const resumed = new UnderstandingRuntime({ config: { ...s.config, stateDir: restartDir } as Config, key: Buffer.alloc(32, 7), groups: { list: () => ({ groups: [s.group], suggestions: [] }), get: () => s.group }, catalog: { read: () => catalog() }, adapter: { context: async root => sampleContext(root) } });
  try {
    const recovered = resumed.read("workspace").maintenance;
    assert.equal(recovered.state, "failed");
    assert.equal(recovered.jobsToday, 1);
    assert.ok(Date.parse(recovered.nextAttemptAt!) > Date.now());
    resumed.refresh("workspace");
    await waitUntil(() => resumed.read("workspace").components.length === 2);
    assert.equal(resumed.read("workspace").maintenance.jobsToday, 2);
  } finally { release(); await resumed.close(); }
});

test("corrupt encrypted state stays unavailable and is never replaced by a fresh budget", async t => {
  const s = setup(t);
  await s.runtime.close();
  const path = join(s.stateDir, "understanding", "runtime.sealed");
  mkdirSync(join(s.stateDir, "understanding"), { recursive: true });
  writeFileSync(path, "corrupt sealed state");
  const before = readFileSync(path, "utf8");
  const resumed = new UnderstandingRuntime({ config: s.config, key: Buffer.alloc(32, 7), groups: { list: () => ({ groups: [s.group], suggestions: [] }), get: () => s.group }, catalog: { read: () => catalog() }, adapter: { context: async root => sampleContext(root) } });
  try {
    assert.equal(resumed.read("workspace").maintenance.state, "unavailable");
    assert.equal(resumed.refresh("workspace").state, "unavailable");
    assert.equal(readFileSync(path, "utf8"), before);
  } finally { await resumed.close(); }
});

test("failed source revalidation does not mutate the prior generation synthesis watermark", { timeout: 30000 }, async t => {
  let mutate = false;
  const calls: string[][] = [];
  const adapter: UnderstandingAdapter = {
    context: async root => sampleContext(root),
    synthesize: async input => {
      calls.push(input.components.map(component => component.id));
      if (mutate) { mutate = false; writeFileSync(join(input.root, "src", "a.ts"), "export const a = 77;\n"); }
      const generatedAt = new Date().toISOString();
      return { components: input.components.map(component => ({ ...component, current: { ...component.current, state: "ready" as const, summary: "Synthesis fixture result.", generatedAt }, difference: { ...component.difference, snapshotId: component.current.snapshotId, generatedAt, planRevisions: component.planned.map(plan => ({ id: plan.id, revision: plan.revision })) } })), coverage: [] };
    },
  };
  const s = setup(t, { adapter });
  s.setCatalog({ ...catalog(), policy: { enabled: false, synthesis: true, delivery: false, intervalMinutes: 60, dailyJobLimit: 5 } });
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").components.length === 2 && s.runtime.read("workspace").maintenance.state === "idle");
  assert.equal(calls.flat().length, 2);
  writeFileSync(join(s.root, "src", "a.ts"), "export const a = 55;\n");
  mutate = true;
  s.runtime.refresh("workspace");
  await waitUntil(() => !["queued", "running"].includes(s.runtime.read("workspace").maintenance.state));
  assert.equal(s.runtime.read("workspace").maintenance.state, "failed");
  const countAfterRejected = calls.length;
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "idle" && calls.length > countAfterRejected);
  assert.ok(calls.length > countAfterRejected, "the changed source must be synthesized after the rejected generation");
});

test("failed partial capture never synthesizes a retained stale repository observation", { timeout: 30000 }, async t => {
  let fail = false, calls = 0;
  const adapter: UnderstandingAdapter = {
    context: async root => { if (fail) throw new Error("offline fixture"); return sampleContext(root); },
    synthesize: async input => {
      calls++;
      const generatedAt = new Date().toISOString();
      return { components: input.components.map(component => ({ ...component, current: { ...component.current, state: "ready" as const, summary: "Synthesis fixture result.", generatedAt }, difference: { ...component.difference, snapshotId: component.current.snapshotId, generatedAt, planRevisions: component.planned.map(plan => ({ id: plan.id, revision: plan.revision })) } })), coverage: [] };
    },
  };
  const s = setup(t, { adapter });
  s.setCatalog({ ...catalog(), policy: { enabled: false, synthesis: true, delivery: false, intervalMinutes: 60, dailyJobLimit: 5 } });
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "idle" && calls > 0);
  const previousCalls = calls;
  fail = true;
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "failed");
  assert.equal(calls, previousCalls);
});

test("synthesis rejects difference claims that cite a foreign repository and retains the last good map", { timeout: 30000 }, async t => {
  let invalid = false;
  const adapter: UnderstandingAdapter = {
    context: async root => sampleContext(root),
    synthesize: async input => {
      const generatedAt = new Date().toISOString();
      return { components: input.components.map(component => ({ ...component, current: { ...component.current, state: "ready" as const, summary: "Synthesis fixture result.", generatedAt }, difference: { ...component.difference, snapshotId: component.current.snapshotId, generatedAt, planRevisions: component.planned.map(plan => ({ id: plan.id, revision: plan.revision })), claims: invalid ? [{ text: "Unsupported difference claim.", basis: "source" as const, evidence: [{ repositoryId: "foreign-repository", source: "src/a.ts", line: 1 }] }] : [] } })), coverage: [] };
    },
  };
  const s = setup(t, { adapter });
  s.setCatalog({ ...catalog(), policy: { enabled: false, synthesis: true, delivery: false, intervalMinutes: 60, dailyJobLimit: 5 } });
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "idle" && s.runtime.read("workspace").components.length === 2);
  assert.equal(s.runtime.read("workspace").components.filter(component => component.current.state === "ready").length, 2);
  writeFileSync(join(s.root, "src", "a.ts"), "export const a = 66;\n");
  invalid = true;
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "failed");
  assert.equal(s.runtime.read("workspace").components.filter(component => component.current.state === "ready").length, 2);
  assert.ok(s.runtime.read("workspace").components.every(component => component.difference.claims.length === 0));
});

test("folded sibling worktrees are identity-checked without requiring path nesting", { timeout: 20000 }, async t => {
  const s = setup(t, { adapter: { context: async root => sampleContext(root) } });
  const sibling = join(s.stateDir, "sibling-checkout");
  execFileSync("git", ["-C", s.root, "worktree", "add", "--detach", sibling, "HEAD"], { stdio: "ignore" });
  s.config.projects.push({ id: "repo-sibling", name: "Sibling checkout", path: sibling });
  s.group.repos[0].checkouts.push({ projectId: "repo-sibling", name: "Sibling checkout", path: sibling, primary: false, teamReady: true });
  s.runtime.refresh("workspace");
  await waitUntil(() => !["queued", "running"].includes(s.runtime.read("workspace").maintenance.state));
  const result = s.runtime.read("workspace");
  assert.equal(result.components.length, 2, JSON.stringify({ maintenance: result.maintenance, coverage: result.coverage }));
  assert.equal(s.runtime.read("workspace").maintenance.state, "idle");
});

test("accepted catalog text boundaries publish and survive runtime restart without losing owner intent", { timeout: 20000 }, async t => {
  const s = setup(t, { adapter: { context: async root => sampleContext(root) } });
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "idle");
  const component = s.runtime.read("workspace").components[0];
  const groups = { list: () => ({ groups: [s.group], suggestions: [] }), get: () => s.group };
  const ownerCatalog = new UnderstandingCatalog({ config: s.config, key: Buffer.alloc(32, 7), groups });
  const workId = "w".repeat(200), text = "p".repeat(12000), description = "d".repeat(4000);
  const context = { components: [component], work: [{ id: workId, sourceId: "work", kind: "goal" as const, title: "Owner work", objective: null, reportedSummary: null, status: "active", column: "working" as const, updatedAt: new Date().toISOString(), scope: "complete" as const, repositoryIds: ["repo"], briefIds: [], links: [] }] };
  ownerCatalog.mutate("workspace", "plans", undefined, { requestId: randomUUID(), revision: 0, action: "create", value: { componentId: component.id, repositoryIds: ["repo"], title: "Plan", text, status: "accepted", sourceUrl: null, workId } }, context);
  const accepted = ownerCatalog.mutate("workspace", "components", component.id, { requestId: randomUUID(), revision: 1, action: "update", value: { repositoryIds: ["repo"], name: "Owner component", description, redirectTo: null, pinned: true } }, context);
  s.setCatalog(accepted);
  s.runtime.refresh("workspace");
  await waitUntil(() => !["queued", "running"].includes(s.runtime.read("workspace").maintenance.state));
  assert.equal(s.runtime.read("workspace").maintenance.state, "idle");
  await s.runtime.close();
  const resumed = new UnderstandingRuntime({ config: s.config, key: Buffer.alloc(32, 7), groups, catalog: ownerCatalog, adapter: { context: async root => sampleContext(root) } });
  try {
    const result = resumed.read("workspace");
    assert.equal(result.maintenance.state, "idle");
    assert.equal(result.maintenance.jobsToday, 2);
    assert.equal(result.components[0]?.description, description);
    assert.equal(result.components[0]?.planned[0]?.text, text);
    assert.equal(result.components[0]?.planned[0]?.workId, workId);
  } finally { await resumed.close(); }
});

test("accepted brief comparison boundaries publish and survive restart through the real synthesis adapter", { timeout: 20000 }, async t => {
  const briefAdapter = createUnderstandingAdapter({ projects: [], repositoryBriefings: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/understanding-brief.mjs"), "boundaries"], automatic: false, intervalMs: 1000, cooldownMs: 0, timeoutMs: 10000 } } as Config);
  const s = setup(t, { adapter: { ...briefAdapter, context: async root => {
    const context = sampleContext(root);
    return { ...context, files: { "src/a.ts": { hash: createHash("sha1").update(readFileSync(join(root, "src/a.ts"))).digest("hex"), lines: 1 } }, components: context.components.slice(0, 1), edges: [] };
  } } });
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "idle");
  const component = s.runtime.read("workspace").components[0];
  const at = new Date().toISOString();
  const currentCatalog: KnowledgeCatalog = { ...catalog(), plans: [{ id: "plan", revision: 1, componentId: component.id, repositoryIds: ["repo"], title: "Owner plan", text: "Keep the export", status: "accepted", sourceUrl: null, workId: null, archived: false, createdAt: at, updatedAt: at, history: [] }], policy: { ...catalog().policy, synthesis: true } };
  s.setCatalog(currentCatalog);
  s.runtime.refresh("workspace");
  await waitUntil(() => !["queued", "running"].includes(s.runtime.read("workspace").maintenance.state));
  assert.equal(s.runtime.read("workspace").maintenance.state, "idle");
  const published = s.runtime.read("workspace").components[0];
  assert.equal(published.current.state, "ready");
  assert.equal(published.difference.summary.length, 5000);
  assert.equal(published.difference.claims.at(-1)?.text, `${"a".repeat(150)}: ${"w".repeat(900)} Review question: ${"q".repeat(900)}`);
  await s.runtime.close();
  const resumed = new UnderstandingRuntime({ config: s.config, key: Buffer.alloc(32, 7), groups: { list: () => ({ groups: [s.group], suggestions: [] }), get: () => s.group }, catalog: { read: () => currentCatalog } });
  try { assert.deepEqual(resumed.read("workspace").components, [published]); }
  finally { await resumed.close(); }
});

test("accepted provider title and environment boundaries publish and survive restart", { timeout: 20000 }, async t => {
  const s = setup(t);
  await s.runtime.close();
  execFileSync("git", ["-C", s.root, "remote", "add", "origin", "https://github.com/example/repo.git"]);
  s.config.projects[0].source = { mode: "github", repository: "example/repo" };
  const bin = join(s.stateDir, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const head = ${JSON.stringify(sampleContext(s.root).head)};
const url = "https://example.invalid/" + "u".repeat(2024);
if (process.argv[2] === "pr") process.stdout.write(JSON.stringify([{ number: 1, title: "t".repeat(2000), url: "https://github.com/example/repo/pull/1", state: "OPEN", headRefOid: head, mergeCommit: null, statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: url }] }]));
else if (process.argv.at(-1).includes("statuses")) process.stdout.write(JSON.stringify([{ state: "success", environment: "e".repeat(200), created_at: new Date().toISOString(), target_url: url }]));
else process.stdout.write(JSON.stringify([{ id: 1, environment: "e".repeat(200), sha: head, created_at: new Date().toISOString() }]));
`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${previousPath ? `:${previousPath}` : ""}`;
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
  const groups = { list: () => ({ groups: [s.group], suggestions: [] }), get: () => s.group };
  const currentCatalog = { ...catalog(), policy: { ...catalog().policy, delivery: true } };
  const options = { config: s.config, key: Buffer.alloc(32, 7), groups, catalog: { read: () => currentCatalog } };
  const runtime = new UnderstandingRuntime({ ...options, adapter: { ...createUnderstandingAdapter(s.config), context: async root => sampleContext(root) } });
  try {
    runtime.refresh("workspace");
    await waitUntil(() => !["queued", "running"].includes(runtime.read("workspace").maintenance.state));
    const result = runtime.read("workspace");
    assert.equal(result.maintenance.state, "idle");
    assert.equal(result.delivery[0]?.pullRequests[0]?.title, "t".repeat(2000));
    assert.equal(result.delivery[0]?.environments[0]?.environment, "e".repeat(200));
    assert.equal(result.delivery[0]?.environments[0]?.url?.length, 2048);
    await runtime.close();
    const resumed = new UnderstandingRuntime(options);
    try { assert.deepEqual(resumed.read("workspace").delivery, result.delivery); }
    finally { await resumed.close(); }
  } finally { await runtime.close(); }
});

test("runtime workspace routes reject checkout aliases without allocating maintenance state", async t => {
  const s = setup(t, { adapter: { context: async root => sampleContext(root) } });
  const missing = (error: unknown) => error instanceof CatalogError && error.statusCode === 404;
  assert.throws(() => s.runtime.read("repo"), missing);
  assert.throws(() => s.runtime.refresh("repo"), missing);
  assert.equal(s.runtime.read("workspace").maintenance.jobsToday, 0);
});

test("accepted context path boundaries retain generated coverage and relationship evidence after restart", async t => {
  const from = `${"p/".repeat(510)}a.ts`, to = `${"p/".repeat(510)}b.ts`;
  const s = setup(t, { adapter: { context: async root => {
    const context = sampleContext(root);
    return { ...context, files: { [from]: context.files["src/a.ts"], [to]: context.files["src/b.ts"] },
      components: context.components.map((component, index) => ({ ...component, path: index ? to : from, examples: [index ? to : from] })),
      edges: [{ from: "unstable-a", to: "unstable-b", count: 1, examples: [`${from} → ${to}`] }] };
  } } });
  s.runtime.refresh("workspace");
  await waitUntil(() => !["queued", "running"].includes(s.runtime.read("workspace").maintenance.state));
  const published = s.runtime.read("workspace");
  assert.equal(published.maintenance.state, "idle");
  assert.equal(published.components.length, 2);
  assert.ok(published.components[0].coverage.some(message => message.includes(from)));
  assert.deepEqual(published.relationships[0]?.evidence.map(item => item.source), [from, to]);
  await s.runtime.close();
  const resumed = new UnderstandingRuntime({ config: s.config, key: Buffer.alloc(32, 7), groups: { list: () => ({ groups: [s.group], suggestions: [] }), get: () => s.group }, catalog: { read: () => catalog() }, adapter: { context: async root => sampleContext(root) } });
  try { assert.deepEqual(resumed.read("workspace"), published); }
  finally { await resumed.close(); }
});

test("retiring a component preserves bounded evidence through repeated refresh and restart", async t => {
  let retired = false;
  const adapter: UnderstandingAdapter = {
    context: async root => { const value = sampleContext(root); if (retired) { value.components = []; value.edges = []; } return value; },
    synthesize: async input => {
      const generatedAt = new Date().toISOString();
      return { components: input.components.map(component => ({ ...component,
        current: { ...component.current, state: "ready" as const, generatedAt },
        difference: { ...component.difference, snapshotId: component.current.snapshotId, generatedAt },
        coverage: Array.from({ length: 100 }, (_, index) => `Source coverage ${index}`),
      })), coverage: [] };
    },
  };
  const s = setup(t, { adapter });
  s.setCatalog({ ...catalog(), policy: { ...catalog().policy, synthesis: true } });
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "idle");
  assert.equal(s.runtime.read("workspace").components[0].coverage.length, 100);
  retired = true;
  for (let index = 0; index < 2; index++) {
    s.runtime.refresh("workspace");
    await waitUntil(() => !["queued", "running"].includes(s.runtime.read("workspace").maintenance.state));
    assert.equal(s.runtime.read("workspace").maintenance.state, "idle");
  }
  const result = s.runtime.read("workspace");
  assert.ok(result.components.every(component => component.retired && component.coverage.length <= 100 && component.coverage.some(message => /no longer appears/.test(message))));
  await s.runtime.close();
  const resumed = new UnderstandingRuntime({ config: s.config, key: Buffer.alloc(32, 7), groups: { list: () => ({ groups: [s.group], suggestions: [] }), get: () => s.group }, catalog: { read: catalog } });
  try { assert.deepEqual(resumed.read("workspace").components.map(component => component.coverage), result.components.map(component => component.coverage)); }
  finally { await resumed.close(); }
});

test("maintenance publishes a repository brief with parsed diagrams, a component map, and a changes watermark", { timeout: 30000 }, async t => {
  const s = setup(t, { briefProcess: true });
  s.setCatalog({ ...catalog(), policy: { ...catalog().policy, enabled: true, synthesis: true } });
  s.runtime.refresh("workspace");
  await waitUntil(() => (s.runtime.read("workspace").briefs?.length ?? 0) === 1);
  const first = s.runtime.read("workspace");
  assert.equal(first.briefs![0].state, "ready");
  assert.equal(first.briefs![0].base, null);
  assert.equal(first.briefs![0].diagrams[0].nodes.map(n => n.componentId).filter(Boolean).length, 0, "fixture node ids are not component ids");
  assert.equal(first.diagrams![0].kind, "components");
  assert.equal(first.diagrams![0].nodes.length, 2);
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "idle");
  const head = execFileSync("git", ["-C", s.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const commit = (value: number) => {
    writeFileSync(join(s.root, "src", "a.ts"), `export const a = ${value};\n`);
    execFileSync("git", ["-C", s.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qam", "change"]);
  };
  // A failed brief must not advance the watermark: the next brief spans the skipped range.
  commit(10);
  process.env.UNDERSTANDING_FIXTURE_BRIEF_FAIL = "1";
  t.after(() => { delete process.env.UNDERSTANDING_FIXTURE_BRIEF_FAIL; });
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "failed");
  assert.equal(s.runtime.read("workspace").briefs![0].state, "stale");
  commit(11);
  delete process.env.UNDERSTANDING_FIXTURE_BRIEF_FAIL;
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").briefs?.[0]?.base === head);
  assert.equal(s.runtime.read("workspace").briefs![0].state, "ready");
  assert.match(s.runtime.read("workspace").briefs![0].brief.changes[0].text, /^Changed since/);
});

test("a failing brief step keeps the source map and records the brief reason", { timeout: 30000 }, async t => {
  const s = setup(t, { briefProcess: true, fixtureMode: "brief-fail" });
  s.setCatalog({ ...catalog(), policy: { ...catalog().policy, enabled: true, synthesis: true } });
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "failed");
  const read = s.runtime.read("workspace");
  assert.equal(read.components.length, 2);
  assert.equal(read.briefs?.length ?? 0, 0);
  assert.equal(read.diagrams![0].kind, "components");
  assert.match(read.maintenance.message ?? "", /brief unavailable: exit 1/);
});

test("a brief that runs out of time keeps the source map and component diagram, and a later refresh publishes the brief", { timeout: 30000 }, async t => {
  const s = setup(t, { briefProcess: true });
  s.config.repositoryBriefings!.timeoutMs = 4000;
  s.setCatalog({ ...catalog(), policy: { ...catalog().policy, enabled: true, synthesis: true } });
  process.env.UNDERSTANDING_FIXTURE_BRIEF_SLEEP_MS = "20000";
  t.after(() => { delete process.env.UNDERSTANDING_FIXTURE_BRIEF_SLEEP_MS; });
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "failed", 15000);
  const failed = s.runtime.read("workspace");
  assert.equal(failed.components.length, 2);
  assert.ok(failed.diagrams?.some(diagram => diagram.id === "components:repo" && diagram.kind === "components"));
  assert.equal(failed.briefs?.length ?? 0, 0);
  assert.match(failed.maintenance.message ?? "", /Repository Repository: brief unavailable: understanding-timeout/);
  delete process.env.UNDERSTANDING_FIXTURE_BRIEF_SLEEP_MS;
  s.runtime.refresh("workspace");
  await waitUntil(() => (s.runtime.read("workspace").briefs?.length ?? 0) === 1, 15000);
  assert.equal(s.runtime.read("workspace").briefs![0].state, "ready");
});

const quickBrief: NonNullable<UnderstandingAdapter["brief"]> = async input => ({ head: input.context.head, base: null, generatedAt: new Date().toISOString(),
  brief: { summary: "Fast brief.", architecture: [], changes: [], checks: [], review: [], guidance: [], unknowns: [] }, diagrams: [], evidence: [], coverage: [] });
const untilAborted = <T>(options: { signal: AbortSignal }) => new Promise<T>((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));

test("a stored brief and the source map publish when synthesis runs past the deadline", { timeout: 30000 }, async t => {
  const s = setup(t, { processFixture: true, adapter: { context: async root => sampleContext(root), brief: quickBrief, synthesize: (_input, options) => untilAborted(options) } });
  s.config.repositoryBriefings!.timeoutMs = 2000;
  s.setCatalog({ ...catalog(), policy: { ...catalog().policy, enabled: true, synthesis: true } });
  s.runtime.refresh("workspace");
  await waitUntil(() => !["queued", "running"].includes(s.runtime.read("workspace").maintenance.state), 10000);
  const read = s.runtime.read("workspace");
  assert.equal(read.maintenance.state, "failed");
  assert.match(read.maintenance.message ?? "", /Repository Repository: synthesis unavailable: understanding-timeout/);
  assert.deepEqual(read.briefs?.map(brief => brief.brief.summary), ["Fast brief."]);
  assert.equal(read.components.length, 2);
  assert.ok(read.diagrams?.some(diagram => diagram.id === "components:repo"));
});

test("a re-check that runs out of time publishes the source map without the unconfirmed brief", { timeout: 30000 }, async t => {
  let captures = 0;
  const s = setup(t, { processFixture: true, adapter: { context: async (root, options) => ++captures === 2 ? untilAborted(options) : sampleContext(root), brief: quickBrief } });
  s.config.repositoryBriefings!.timeoutMs = 2000;
  s.setCatalog({ ...catalog(), policy: { ...catalog().policy, enabled: true, synthesis: true } });
  s.runtime.refresh("workspace");
  await waitUntil(() => !["queued", "running"].includes(s.runtime.read("workspace").maintenance.state), 10000);
  const read = s.runtime.read("workspace");
  assert.equal(captures, 2);
  assert.equal(read.maintenance.state, "failed");
  assert.match(read.maintenance.message ?? "", /Repository Repository: source re-check unavailable: understanding-timeout/);
  assert.equal(read.briefs?.length ?? 0, 0);
  assert.equal(read.components.length, 2);
});

test("sealed state from before the repository brief, with a legacy previousHead key, still loads", { timeout: 20000 }, async t => {
  const s = setup(t, { processFixture: true });
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").components.length === 2);
  await s.runtime.close();
  const file = join(s.stateDir, "understanding", "runtime.sealed"), key = Buffer.alloc(32, 7);
  const state = unseal<{ workspaces: Record<string, { repositories: Record<string, Record<string, unknown>> }> }>(key, "understanding-runtime", readFileSync(file, "utf8"));
  for (const repository of Object.values(state.workspaces.workspace.repositories)) {
    for (const field of ["brief", "briefFingerprint", "briefFailure", "componentDiagram"]) delete repository[field];
    repository.previousHead = "a".repeat(40);
  }
  writeSealed(file, key, "understanding-runtime", state);
  const resumed = new UnderstandingRuntime({ config: s.config, key, groups: { list: () => ({ groups: [s.group], suggestions: [] }), get: () => s.group }, catalog: { read: () => catalog() } });
  try {
    const read = resumed.read("workspace");
    assert.equal(read.components.length, 2);
    assert.notEqual(read.maintenance.state, "unavailable");
    assert.deepEqual(read.briefs, []);
  } finally { await resumed.close(); }
});

test("sourceChanged queues a refresh only for enabled workspaces that contain the checkout", { timeout: 20000 }, async t => {
  const s = setup(t, { adapter: { context: async root => sampleContext(root) } });
  s.runtime.sourceChanged("repo");
  assert.equal(s.runtime.read("workspace").maintenance.state, "disabled");
  s.setCatalog({ ...catalog(), policy: { ...catalog().policy, enabled: true } });
  s.runtime.sourceChanged("other-project");
  assert.notEqual(s.runtime.read("workspace").maintenance.state, "queued");
  s.runtime.sourceChanged("repo");
  await waitUntil(() => s.runtime.read("workspace").components.length === 2);
});

test("a change that lands while a job runs queues one more refresh after it", { timeout: 20000 }, async t => {
  let release: (() => void) | undefined, calls = 0;
  const s = setup(t, { adapter: { context: async root => { calls++; const context = sampleContext(root); await new Promise<void>(resolvePromise => { release = resolvePromise; }); return context; } } });
  s.setCatalog({ ...catalog(), policy: { ...catalog().policy, enabled: true } });
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "running" && Boolean(release));
  s.runtime.sourceChanged("repo");
  const first = release!; release = undefined; first();
  await waitUntil(() => calls === 2 && Boolean(release));
  release!();
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "idle");
  assert.equal(calls, 2);
  assert.equal(s.runtime.read("workspace").maintenance.jobsToday, 2);
});

test("a host without a summary writer reads as unavailable and says why", async t => {
  const s = setup(t);
  const read = s.runtime.read("workspace");
  assert.equal(read.maintenance.state, "unavailable");
  assert.equal(read.maintenance.message, "No summary writer is configured on this host.");
  assert.equal(s.runtime.refresh("workspace").message, "No summary writer is configured on this host.");
});

/** Moves the clock past one 15-minute interval and runs one scheduler pass, as the host timer does. */
function ticker(t: test.TestContext, runtime: UnderstandingRuntime) {
  let offset = 0;
  const realNow = Date.now.bind(Date);
  t.mock.method(Date, "now", () => realNow() + offset);
  return () => { offset += 16 * 60_000; (runtime as unknown as { reconcile(): void }).reconcile(); };
}
const commit = (root: string, value: number) => {
  writeFileSync(join(root, "src", "a.ts"), `export const a = ${value};\n`);
  execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qam", "change"]);
};

test("interval ticks admit a job only after a repository moves; an explicit refresh always admits", { timeout: 30000 }, async t => {
  const s = setup(t, { adapter: { context: async root => sampleContext(root) } });
  s.setCatalog({ ...catalog(), policy: { ...catalog().policy, enabled: true, intervalMinutes: 15, dailyJobLimit: 24 } });
  const tick = ticker(t, s.runtime);
  const settled = (jobs: number) => () => { const value = s.runtime.read("workspace").maintenance; return value.state === "idle" && value.jobsToday === jobs; };
  tick();
  await waitUntil(settled(1));
  for (let index = 0; index < 8; index++) tick();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  assert.equal(s.runtime.read("workspace").maintenance.jobsToday, 1, "ticks over unchanged repositories admit no job");
  commit(s.root, 5);
  tick();
  await waitUntil(settled(2));
  tick();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  assert.equal(s.runtime.read("workspace").maintenance.jobsToday, 2);
  assert.equal(s.runtime.refresh("workspace").state, "queued", "an explicit refresh admits without a source change");
  await waitUntil(settled(3));
});

test("a spent daily budget is recorded once and later ticks leave the store alone", { timeout: 30000 }, async t => {
  const s = setup(t, { adapter: { context: async root => sampleContext(root) } });
  s.setCatalog({ ...catalog(), policy: { ...catalog().policy, enabled: true, intervalMinutes: 15, dailyJobLimit: 1 } });
  const tick = ticker(t, s.runtime);
  tick();
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "idle" && s.runtime.read("workspace").maintenance.jobsToday === 1);
  commit(s.root, 6);
  tick();
  assert.equal(s.runtime.read("workspace").maintenance.state, "budget-limited");
  const file = join(s.stateDir, "understanding", "runtime.sealed"), sealed = readFileSync(file, "utf8");
  tick(); tick();
  assert.equal(readFileSync(file, "utf8"), sealed, "budget-limited ticks do not rewrite the encrypted store");
  assert.equal(s.runtime.read("workspace").maintenance.state, "budget-limited");
});

test("an engine that exits with an error line on stderr reports that line as the reason", { timeout: 30000 }, async t => {
  for (const { mode, reason } of [
    { mode: "brief-stderr", reason: "Repository Repository: brief unavailable: exit 1 · fixture writer: model quota exhausted" },
    { mode: "context-stderr", reason: "Repository Repository: context-process-failed · fixture context: repository index is locked" },
  ]) await t.test(mode, async t => {
    const s = setup(t, { briefProcess: true, fixtureMode: mode });
    s.setCatalog({ ...catalog(), policy: { ...catalog().policy, enabled: true, synthesis: true } });
    s.runtime.refresh("workspace");
    await waitUntil(() => s.runtime.read("workspace").maintenance.state === "failed", 10000);
    assert.ok(s.runtime.read("workspace").maintenance.lastFailure?.reason.includes(reason), s.runtime.read("workspace").maintenance.lastFailure?.reason);
  });
});

test("a source map with more components than the stored diagram holds still publishes and says how much it drew", { timeout: 60000 }, async t => {
  const s = setup(t, { adapter: { context: async root => {
    const base = sampleContext(root), hash = base.files["src/a.ts"].hash;
    const files: RepoContext["files"] = {}, components: RepoContext["components"] = [];
    for (let i = 0; i < 2001; i++) {
      files[`pkg${i}/index.ts`] = { hash, lines: 1 };
      components.push({ id: `c${i}`, path: `pkg${i}`, name: `C${i}`, files: 1, examples: [], entryPoints: [], incoming: 0, outgoing: 0, changed: 0 });
    }
    return { ...base, files, components, edges: [] };
  } } });
  s.runtime.refresh("workspace");
  await waitUntil(() => !["queued", "running"].includes(s.runtime.read("workspace").maintenance.state), 30000);
  const read = s.runtime.read("workspace");
  assert.equal(read.maintenance.state, "idle", read.maintenance.message ?? "");
  assert.equal(read.components.length, 2001);
  assert.equal(read.diagrams?.find(diagram => diagram.id === "components:repo")?.nodes.length, 2000);
  assert.ok(read.coverage.includes("Component map: 2000 of 2001 components drawn; the rest are listed under Components."));
});

test("a GitHub-tracked checkout without a remote binds by its source record; a mismatch reads as a plain sentence", { timeout: 20000 }, async t => {
  const s = setup(t, { adapter: { context: async root => sampleContext(root) } });
  s.setCatalog({ ...catalog(), policy: { enabled: true, synthesis: false, delivery: false, intervalMinutes: 60, dailyJobLimit: 5 } });
  s.group.repos[0].key = "remote:github.com/example/repo";
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "failed");
  const failed = s.runtime.read("workspace").maintenance;
  assert.equal(failed.lastFailure?.reason, "A checkout no longer matches the repository it was enrolled as");
  assert.match(failed.message ?? "", /^Last attempt failed at \d{4}-.*: A checkout no longer matches the repository it was enrolled as\.$/);
  s.config.projects[0].source = { mode: "github", repository: "example/repo", baseBranch: "main" };
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").components.length === 2);
  assert.equal(s.runtime.read("workspace").maintenance.state, "idle");
});
