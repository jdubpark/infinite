import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { claimControl, startHost, waitFor } from "./helpers.js";
import { UnderstandingService } from "../packages/host/src/understanding.js";
import { writeSealed } from "../packages/host/src/vault.js";
import { createRemoteClient, type GeneratedCatalogPage, type WorkspaceUnderstanding } from "@infinite/remote";
import { MAX_RESPONSE_BYTES } from "@infinite/remote/protocol";
import { createGoalSchema, type ProductGoal } from "../packages/host/src/goal-types.js";
import { RepositoryBriefings } from "../packages/host/src/repository-briefings.js";

const attention = { idleAfterMs: 3000, hooks: { claude: true, codex: true } };

function initializeRepo(path: string) {
  execFileSync("git", ["init", "-q"], { cwd: path });
  execFileSync("git", ["-C", path, "config", "user.email", "fixture@example.invalid"]);
  execFileSync("git", ["-C", path, "config", "user.name", "Fixture"]);
  writeFileSync(join(path, "README.md"), "workspace understanding fixture\n");
  execFileSync("git", ["-C", path, "add", "README.md"]);
  execFileSync("git", ["-C", path, "commit", "-qm", "fixture"]);
}

function retainGoal(host: Awaited<ReturnType<typeof startHost>>, index: number, objective = "Recorded request") {
  const request = createGoalSchema.parse({ requestId: randomUUID(), projectId: "rehearsal", title: `Recorded goal ${index}`, objective, successCriteria: "Inspect the result" });
  const { requestId: id, ...input } = request;
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  const strong = { id: "fixture-strong", label: "Fixture reviewer", provider: "codex" as const, model: "fixture", tier: "strong" as const };
  const goal: ProductGoal = { ...input, id, revision: 1, status: "cancelled", createdAt: at, updatedAt: at, deadlineAt: at,
    lineup: { coordinator: strong, integrator: strong, reviewer: strong, implementers: [], escalations: [] }, cycles: [], memberCount: 0, steering: [], events: [], outcomes: [] };
  writeSealed(join(host.config.stateDir, "goals", `${id}.sealed`), readFileSync(host.config.keyFile), `goal:${id}`, { goal, fingerprint: "fixture", receipts: {} });
  return goal;
}

async function understandingPath(host: Awaited<ReturnType<typeof startHost>>) {
  const listed = await host.fetchApi("/project-groups", "viewer");
  const workspace = listed.body.groups.find((group: any) => group.repos.some((repo: any) => repo.checkouts.some((checkout: any) => checkout.projectId === "rehearsal")));
  assert.ok(workspace, "the enrolled checkout has a canonical workspace");
  return `/project-groups/${workspace.id}/understanding`;
}

test("catalog edits cross encrypted transport only for owners and preserve revision conflicts", { timeout: 40000 }, async () => {
  const host = await startHost({ config: { remote: { enabled: true } } });
  const owner = createRemoteClient({ url: host.origin, token: host.tokens.owner });
  const viewer = createRemoteClient({ url: host.origin, token: host.tokens.viewer });
  try {
    initializeRepo(host.config.projects[0].path);
    const path = "/project-groups/rehearsal/understanding";
    const before = await viewer.request<WorkspaceUnderstanding>(path);
    assert.equal(before.knowledge?.catalog.revision, 0);
    const request = { requestId: randomUUID(), revision: 0, action: "create", value: { name: "Service work", description: "Explicit project association", repositoryIds: ["rehearsal"] } };
    for (const role of ["viewer", "controller"] as const) {
      const denied = await host.fetchApi(`${path}/catalog/projects`, role, request);
      assert.equal(denied.status, 403);
      assert.equal((await host.fetchApi(`${path}/refresh`, role, {})).status, 403);
    }
    const created = await owner.request<{ revision: number; projects: { id: string }[] }>(`${path}/catalog/projects`, { body: request });
    assert.equal(created.revision, 1);
    assert.equal(created.projects[0].id, request.requestId);
    assert.deepEqual(await owner.request(`${path}/catalog/projects`, { body: request }), created);
    const conflict = await host.fetchApi(`${path}/catalog/projects`, "owner", { ...request, requestId: randomUUID() });
    assert.equal(conflict.status, 409);
    const after = await viewer.request<WorkspaceUnderstanding>(path);
    assert.equal(after.knowledge?.catalog.projects[0].name, "Service work");
    assert.equal(after.knowledge?.catalog.revision, 1);
    assert.deepEqual(await viewer.request(`${path}/components`), { components: [], coverage: after.knowledge?.coverage ?? [] });
    const refresh = await owner.request<{ state: string }>(`${path}/refresh`, { body: {} });
    assert.equal(refresh.state, "unavailable", "an unconfigured collector cannot start a writer");
    assert.equal((await viewer.request<WorkspaceUnderstanding>(path)).knowledge?.maintenance.jobsToday, 0);
  } finally { owner.close(); viewer?.close(); await host.stop(); }
});

test("unavailable brief storage leaves the host and Work readable and cannot acknowledge a later write", { timeout: 40000 }, async () => {
  const host = await startHost();
  try {
    initializeRepo(host.config.projects[0].path);
    await host.stopApi();
    const goal = retainGoal(host, 0);
    const storage = join(host.config.stateDir, "understanding", "artifacts");
    rmSync(storage, { recursive: true });
    writeFileSync(storage, "not a directory");
    await host.start();
    const value = await host.fetchApi(await understandingPath(host), "viewer");
    assert.equal(value.status, 200);
    assert.equal(value.body.work[0].sourceId, goal.id);
    assert.equal(value.body.repositories[0].state, "unavailable");
    assert.match(value.body.repositories[0].warnings.join(" "), /storage.*unavailable/i);
    await host.stopApi();
    host.config.repositoryBriefings = { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/jevcode-brief.mjs"), join(host.root, "calls.jsonl")], automatic: true, intervalMs: 100, cooldownMs: 0, timeoutMs: 10000 };
    host.config.attention = attention;
    writeFileSync(join(host.root, "config.json"), JSON.stringify(host.config));
    await host.start();
    const sessionId = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: sessionId, provider: "demo", projectId: "rehearsal", title: "Unwritable brief", prompt: "hook dialog" });
    const detail = await waitFor(() => host.fetchApi(`/sessions/${sessionId}`), result => result.body.attention?.state === "needs-you" && result.body.attention.prompt?.hash, 15000);
    const control = await claimControl(host, sessionId, "owner");
    await host.fetchApi(`/sessions/${sessionId}/answer`, "owner", { requestId: randomUUID(), promptId: detail.body.attention.prompt.id, option: 0 }, control.headers);
    await waitFor(() => host.fetchApi(`/sessions/${sessionId}/summary?status=1`, "viewer"), result => result.body.state === "failed", 15000);
    const failed = await host.fetchApi(await understandingPath(host), "viewer");
    assert.equal(failed.body.repositories[0].state, "failed");
    assert.match(failed.body.repositories[0].warnings.join("\n"), /^The latest brief attempt failed: \S/m);
    assert.deepEqual(failed.body.repositories[0].current, []);
    assert.equal(failed.body.work[0].sourceId, goal.id);
  } finally { await host.stop(); }
});

test("encrypted Understanding bounds its response and turns over a full retained store", { timeout: 90000 }, async () => {
  const env: NodeJS.ProcessEnv = {};
  const host = await startHost({ env, config: { remote: { enabled: true } } });
  let remote: ReturnType<typeof createRemoteClient> | undefined;
  try {
    const project = host.config.projects[0]; initializeRepo(project.path);
    await host.stopApi();
    const root = realpathSync(project.path), info = statSync(root);
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const sessionId = randomUUID(), key = readFileSync(host.config.keyFile), artifacts = [];
    const binding = { projectId: project.id, sourceKind: "project", enrolledPath: root, root, sourceCwd: root,
      projectDevice: String(info.dev), projectInode: String(info.ino), rootDevice: String(info.dev), rootInode: String(info.ino), sourceCwdDevice: String(info.dev), sourceCwdInode: String(info.ino),
      repoIdentity: createHash("sha256").update(JSON.stringify(`root:${head}`)).digest("hex") };
    for (let index = 0; index < 11; index++) {
      const artifact = { id: randomUUID(), sourceProjectId: project.id, sessionId, sourceKind: "project", head, base: null, fingerprint: "b".repeat(40),
        generatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), retainedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), coverage: ["Fixture source excerpts"],
        brief: { summary: `Retained snapshot ${index}`, architecture: [{ text: "Complete source claim", citations: [{ source: "README.md", line: 1 }] }], changes: [], checks: [], review: [], guidance: [], unknowns: [] },
        evidence: Array.from({ length: 50 }, (_, line) => ({ source: "README.md", line: line + 1, text: "source excerpt ".repeat(750) })) };
      artifacts.push(artifact);
      writeSealed(join(host.config.stateDir, "understanding", "artifacts", `${artifact.id}.sealed`), key, "understanding-artifact", { binding, artifact });
    }
    const goals = Array.from({ length: 120 }, (_, index) => retainGoal(host, index, "Recorded objective. ".repeat(600)));
    assert.ok(Buffer.byteLength(JSON.stringify(artifacts)) > MAX_RESPONSE_BYTES, "individually valid retained artifacts exceed the encrypted response limit together");
    host.config.attention = attention;
    host.config.repositoryBriefings = { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/jevcode-brief.mjs"), join(host.root, "calls.jsonl"), "large"], automatic: true, intervalMs: 100, cooldownMs: 0, timeoutMs: 10000 };
    writeFileSync(join(host.root, "config.json"), JSON.stringify(host.config));
    env.INFINITE_FAIL_DIR_SYNC = join(host.config.stateDir, "understanding", "artifacts");
    env.INFINITE_FAIL_DIR_SYNC_COUNT = "3";
    env.INFINITE_FAIL_FILE_SYNC = "1";
    env.INFINITE_DENY_TEMP_CLEANUP = join(host.root, "deny-temp-cleanup");
    env.NODE_OPTIONS = `--import=${pathToFileURL(join(process.cwd(), "tests/fixtures/fail-understanding-dir-fsync.mjs")).href}`;
    await host.start();
    remote = createRemoteClient({ url: host.origin, token: host.tokens.viewer });
    const value = await remote.request<WorkspaceUnderstanding>(await understandingPath(host));
    assert.ok(Buffer.byteLength(JSON.stringify(value)) < MAX_RESPONSE_BYTES);
    assert.equal(value.repositories[0].current[0].id, artifacts.at(-1)!.id, "the latest source snapshot is prioritized");
    assert.equal(value.repositories[0].current[0].brief.architecture[0].text, "Complete source claim");
    assert.equal(value.work[0].sourceId, goals.at(-1)!.id, "the latest work remains useful");
    assert.equal(value.work.length, goals.length, "the single budget keeps every work record before spending on evidence");
    assert.equal(value.work[0].objective, goals.at(-1)!.objective, "an included request is never silently cut mid-text");
    assert.equal(value.repositories[0].current.length, artifacts.length, "older snapshots are kept without evidence before evidence is spent");
    const lines = [...value.coverage, ...value.repositories[0].coverage, ...value.repositories[0].current.flatMap(item => item.coverage)];
    assert.match(lines.join(" "), /Evidence excerpts: \d+ of 50 shown here; the rest are available on the detail pages\./);
    assert.doesNotMatch(lines.join(" "), /byte|omit/i);
    assert.equal(readdirSync(join(host.config.stateDir, "understanding", "artifacts")).filter(name => name.endsWith(".sealed")).length, artifacts.length, "response limits never prune stored generations");
    const again = await remote.request<WorkspaceUnderstanding>(await understandingPath(host));
    assert.deepEqual(again.work.map(item => item.id), value.work.map(item => item.id));
    assert.deepEqual(again.repositories, value.repositories);
    const attempt = async () => {
      const sessionId = randomUUID();
      await host.fetchApi("/sessions", "owner", { requestId: sessionId, provider: "demo", projectId: "rehearsal", title: "Next retained snapshot", prompt: "hook dialog" });
      const detail = await waitFor(() => host.fetchApi(`/sessions/${sessionId}`), result => result.body.attention?.state === "needs-you" && result.body.attention.prompt?.hash, 15000);
      const control = await claimControl(host, sessionId, "owner");
      await host.fetchApi(`/sessions/${sessionId}/answer`, "owner", { requestId: randomUUID(), promptId: detail.body.attention.prompt.id, option: 0 }, control.headers);
      const result = await waitFor(() => host.fetchApi(`/sessions/${sessionId}/summary?status=1`, "viewer"), result => ["ready", "failed"].includes(result.body.state), 15000);
      return { sessionId, state: result.body.state };
    };
    const directory = join(host.config.stateDir, "understanding", "artifacts");
    writeFileSync(env.INFINITE_DENY_TEMP_CLEANUP!, "deny");
    for (let index = 0; index < 2; index++) {
      assert.equal((await attempt()).state, "failed");
      assert.equal(readdirSync(directory).filter(name => name.endsWith(".tmp")).length, 1, "failed cleanup must stop the next publication before it writes another temporary file");
      assert.equal(readdirSync(directory).filter(name => name.endsWith(".sealed")).length, artifacts.length);
    }
    rmSync(env.INFINITE_DENY_TEMP_CLEANUP!);
    for (let index = 0; index < 2; index++) {
      assert.equal((await attempt()).state, "failed");
      const retained = await remote.request<WorkspaceUnderstanding>(await understandingPath(host));
      assert.ok(retained.repositories[0].current.some(item => item.id === artifacts.at(-1)!.id));
      assert.equal(readdirSync(directory).filter(name => name.endsWith(".tmp")).length, 0, "pre-rename failures remove only their own unfinished temporary artifact");
      assert.equal(readdirSync(directory).filter(name => name.endsWith(".sealed")).length, artifacts.length, "pre-rename failures preserve every acknowledged generation");
    }
    const unrelatedTemporary = `${randomUUID()}.sealed.${"a".repeat(16)}.tmp`;
    writeFileSync(join(directory, unrelatedTemporary), Buffer.alloc(2 * 1024 * 1024));
    assert.equal((await attempt()).state, "failed", "leftover temporary bytes count against publication headroom");
    assert.ok(readdirSync(directory).includes(unrelatedTemporary), "cleanup does not delete another publication's temporary prefix");
    assert.equal(readdirSync(directory).filter(name => name.endsWith(".sealed")).length, artifacts.length);
    rmSync(join(directory, unrelatedTemporary));
    remote.close();
    await host.stopApi();
    delete env.INFINITE_FAIL_FILE_SYNC;
    delete env.INFINITE_DENY_TEMP_CLEANUP;
    env.INFINITE_FAIL_DIR_SYNC_COUNT = "2";
    await host.start();
    remote = createRemoteClient({ url: host.origin, token: host.tokens.viewer });
    for (let index = 0; index < 2; index++) {
      assert.equal((await attempt()).state, "failed");
      const retained = await remote.request<WorkspaceUnderstanding>(await understandingPath(host));
      assert.ok(retained.repositories[0].current.some(item => item.id === artifacts.at(-1)!.id));
      assert.equal(readdirSync(directory).filter(name => name.endsWith(".sealed")).length, artifacts.length + 1, "retries reclaim only the prior unacknowledged publication, preserving one-generation headroom");
    }
    remote.close();
    await host.stopApi();
    delete env.INFINITE_FAIL_DIR_SYNC; delete env.INFINITE_FAIL_DIR_SYNC_COUNT; delete env.NODE_OPTIONS;
    await host.start();
    remote = createRemoteClient({ url: host.origin, token: host.tokens.viewer });
    const recovered = await remote.request<WorkspaceUnderstanding>(await understandingPath(host));
    assert.ok(recovered.repositories[0].current.some(item => item.id === artifacts.at(-1)!.id), "reopening publication headroom preserves prior acknowledged evidence");
    const refreshed = await attempt();
    assert.equal(refreshed.state, "ready", "a full store must admit the next valid generation before pruning superseded evidence");
    const afterRefresh = await remote.request<WorkspaceUnderstanding>(await understandingPath(host));
    assert.equal(afterRefresh.repositories[0].current[0].sessionId, refreshed.sessionId);
    assert.ok(afterRefresh.repositories[0].current.some(item => item.id === artifacts.at(-1)!.id), "the prior acknowledged snapshot remains retained");
    const files = readdirSync(directory).filter(name => name.endsWith(".sealed"));
    assert.ok(files.reduce((size, name) => size + statSync(join(directory, name)).size, 0) <= 8 * 1024 * 1024);
    assert.ok(!files.includes(`${artifacts[0].id}.sealed`), "successful publication evicts the oldest superseded generation");
  } finally { remote?.close(); await host.stop(); }
});

test("planned requests are complete across the overview excerpt and the planned page", { timeout: 60000 }, async () => {
  let viewer: ReturnType<typeof createRemoteClient> | undefined;
  const host = await startHost({ config: { remote: { enabled: true } } });
  try {
    initializeRepo(host.config.projects[0].path);
    await host.stopApi();
    for (let index = 0; index < 13; index++) retainGoal(host, index, "o".repeat(12_000));
    await host.start();
    viewer = createRemoteClient({ url: host.origin, token: host.tokens.viewer });
    const path = await understandingPath(host);
    const overview = await viewer.request<WorkspaceUnderstanding>(path);
    const repo = overview.repositories[0];
    assert.equal(repo.planned.length, 13);
    assert.ok(repo.planned.every(plan => plan.text.length === 600 && plan.excerpt === true));
    assert.equal(repo.coverage.length, 0);
    let cursor: string | undefined;
    const all: string[] = [];
    do {
      const page = await viewer.request<{ items: { workId: string; text: string }[]; next: string | null }>(`${path}/planned?repository=${repo.id}${cursor ? `&cursor=${cursor}` : ""}`);
      all.push(...page.items.map(item => item.text)); cursor = page.next ?? undefined;
    } while (cursor);
    assert.equal(all.length, 13);
    assert.ok(all.every(text => text.length === 12_000));
  } finally { viewer?.close(); await host.stop(); }
});

test("the diagram and brief routes answer with 404 before any observation", { timeout: 40000 }, async () => {
  const host = await startHost();
  try {
    const path = await understandingPath(host);
    assert.equal((await host.fetchApi(`${path}/diagrams/components:rehearsal`, "viewer")).status, 404);
    assert.equal((await host.fetchApi(`${path}/brief?repository=rehearsal`, "viewer")).status, 404);
    assert.equal((await host.fetchApi(`${path}/work`, "viewer")).status, 200);
  } finally { await host.stop(); }
});

test("Understanding is a read-only scoped API and its source-bound brief survives API restart", { timeout: 60000 }, async () => {
  const temp = mkdtempSync("/tmp/inf-understanding-");
  const receipt = join(temp, "brief-calls.jsonl");
  const fixture = join(process.cwd(), "tests/fixtures/jevcode-brief.mjs");
  const env: NodeJS.ProcessEnv = {};
  const repository = join(temp, "rehearsal");
  mkdirSync(repository); initializeRepo(repository);
  const host = await startHost({ env, config: { attention, projects: [{ id: "rehearsal", name: "Rehearsal", path: repository }], repositoryBriefings: {
    command: process.execPath, args: [fixture, receipt], automatic: true, intervalMs: 100, cooldownMs: 0, timeoutMs: 10000,
  } } });
  try {
    const sessionId = randomUUID();
    assert.equal((await host.fetchApi("/sessions", "owner", { requestId: sessionId, provider: "demo", projectId: "rehearsal", title: "Brief source", prompt: "hook dialog" })).status, 201);
    const detail = await waitFor(() => host.fetchApi(`/sessions/${sessionId}`), result => result.body.attention?.state === "needs-you" && result.body.attention.prompt?.hash, 15000);
    const control = await claimControl(host, sessionId, "owner");
    await host.fetchApi(`/sessions/${sessionId}/answer`, "owner", { requestId: randomUUID(), promptId: detail.body.attention.prompt.id, option: 0 }, control.headers);
    await waitFor(() => host.fetchApi(`/sessions/${sessionId}/summary?status=1`, "viewer"), result => result.body.state === "ready", 20000);

    const groups = await host.fetchApi("/project-groups", "viewer");
    assert.equal(groups.status, 200);
    const group = groups.body.groups.find((value: any) => value.repos.some((repo: any) => repo.checkouts.some((checkout: any) => checkout.projectId === "rehearsal")));
    assert.ok(group, "the enrolled checkout belongs to a visible group");
    const path = `/project-groups/${group.id}/understanding`;
    assert.equal((await host.fetchApi(path, null)).status, 401);
    assert.equal((await host.fetchApi("/project-groups/missing/understanding", "viewer")).status, 404);
    const result = await host.fetchApi(path, "viewer");
    assert.equal(result.status, 200);
    assert.equal(result.body.schemaVersion, 1);
    const repo = result.body.repositories.find((value: any) => value.checkoutIds.includes("rehearsal"));
    assert.equal(repo.current.length, 1);
    assert.match(repo.current[0].brief.summary, /Fixture repository brief/);
    const artifactId = repo.current[0].id;
    const beforeReads = readFileSync(receipt, "utf8").trim().split("\n").length;
    for (let i = 0; i < 3; i++) assert.equal((await host.fetchApi(path, "viewer")).body.repositories[0].current[0].id, artifactId);
    assert.equal(readFileSync(receipt, "utf8").trim().split("\n").length, beforeReads, "read requests never schedule a model job");

    const nextSessionId = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: nextSessionId, provider: "demo", projectId: "rehearsal", title: "Second brief source", prompt: "hook dialog" });
    const nextDetail = await waitFor(() => host.fetchApi(`/sessions/${nextSessionId}`), result => result.body.attention?.state === "needs-you" && result.body.attention.prompt?.hash, 15000);
    const nextControl = await claimControl(host, nextSessionId, "owner");
    await host.fetchApi(`/sessions/${nextSessionId}/answer`, "owner", { requestId: randomUUID(), promptId: nextDetail.body.attention.prompt.id, option: 0 }, nextControl.headers);
    await waitFor(() => host.fetchApi(`/sessions/${nextSessionId}/summary?status=1`, "viewer"), result => result.body.state === "ready", 20000);
    const withTwo = await host.fetchApi(path, "viewer");
    const secondArtifact = withTwo.body.repositories[0].current.find((artifact: any) => artifact.sessionId === nextSessionId);
    assert.ok(secondArtifact, "a second source run creates its own retained generation");

    await host.stopApi();
    host.config.repositoryBriefings = { command: process.execPath, args: [fixture, receipt, "invalid"], automatic: true, intervalMs: 100, cooldownMs: 0, timeoutMs: 10000 };
    writeFileSync(join(host.root, "config.json"), JSON.stringify(host.config));
    await host.start();
    const invalidSessionId = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: invalidSessionId, provider: "demo", projectId: "rehearsal", title: "Invalid brief source", prompt: "hook dialog" });
    const invalidDetail = await waitFor(() => host.fetchApi(`/sessions/${invalidSessionId}`), result => result.body.attention?.state === "needs-you" && result.body.attention.prompt?.hash, 15000);
    const invalidControl = await claimControl(host, invalidSessionId, "owner");
    await host.fetchApi(`/sessions/${invalidSessionId}/answer`, "owner", { requestId: randomUUID(), promptId: invalidDetail.body.attention.prompt.id, option: 0 }, invalidControl.headers);
    await waitFor(() => host.fetchApi(`/sessions/${invalidSessionId}/summary?status=1`, "viewer"), result => result.body.state === "failed", 20000);
    const afterInvalid = await host.fetchApi(path, "viewer");
    assert.equal(afterInvalid.status, 200, JSON.stringify(afterInvalid.body));
    assert.equal(afterInvalid.body.repositories[0].state, "failed");
    assert.ok(afterInvalid.body.repositories[0].current.some((artifact: any) => artifact.id === artifactId), "invalid model output cannot replace prior valid generations");
    assert.ok(afterInvalid.body.repositories[0].current.some((artifact: any) => artifact.id === secondArtifact.id));

    host.config.repositoryBriefings = { command: process.execPath, args: [fixture, receipt], automatic: true, intervalMs: 100, cooldownMs: 0, timeoutMs: 10000 };
    writeFileSync(join(host.root, "config.json"), JSON.stringify(host.config));
    env.INFINITE_FAIL_DIR_SYNC = join(host.config.stateDir, "understanding", "artifacts");
    env.NODE_OPTIONS = `--import=${pathToFileURL(join(process.cwd(), "tests/fixtures/fail-understanding-dir-fsync.mjs")).href}`;
    await host.stopApi();
    await host.start();
    const uncertainSessionId = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: uncertainSessionId, provider: "demo", projectId: "rehearsal", title: "Uncertain write", prompt: "hook dialog" });
    const uncertainDetail = await waitFor(() => host.fetchApi(`/sessions/${uncertainSessionId}`), result => result.body.attention?.state === "needs-you" && result.body.attention.prompt?.hash, 15000);
    const uncertainControl = await claimControl(host, uncertainSessionId, "owner");
    await host.fetchApi(`/sessions/${uncertainSessionId}/answer`, "owner", { requestId: randomUUID(), promptId: uncertainDetail.body.attention.prompt.id, option: 0 }, uncertainControl.headers);
    await waitFor(() => host.fetchApi(`/sessions/${uncertainSessionId}/summary?status=1`, "viewer"), result => result.body.state === "failed", 20000);
    const afterUncertainWrite = await host.fetchApi(path, "viewer");
    assert.ok(afterUncertainWrite.body.repositories[0].current.some((artifact: any) => artifact.id === artifactId), "a post-rename directory sync failure cannot remove the last acknowledged artifact");

    delete env.NODE_OPTIONS;
    delete env.INFINITE_FAIL_DIR_SYNC;

    await host.stopApi();
    writeFileSync(join(host.config.stateDir, "understanding", "artifacts", `${secondArtifact.id}.sealed`), "damaged generation");
    await host.start();
    const afterRestart = await host.fetchApi(path, "viewer");
    assert.ok(afterRestart.body.repositories[0].current.some((artifact: any) => artifact.id === artifactId), "a corrupt generation cannot hide an older valid generation");
    assert.ok(afterRestart.body.repositories[0].current.every((artifact: any) => artifact.id !== secondArtifact.id));
    assert.match(afterRestart.body.repositories[0].warnings.join(" "), /corrupt/);

    const movedGroup = await host.fetchApi("/project-groups", "owner", { requestId: randomUUID(), name: "Moved workspace", repos: ["rehearsal"] });
    assert.equal(movedGroup.status, 200);
    const movedUnderstanding = await host.fetchApi(`/project-groups/${movedGroup.body.id}/understanding`, "viewer");
    assert.ok(movedUnderstanding.body.repositories[0].current.some((artifact: any) => artifact.id === artifactId));
    const oldWorkspace = await host.fetchApi(path, "viewer");
    assert.ok(oldWorkspace.status === 404 || oldWorkspace.body.repositories.every((repo: any) => repo.current.every((artifact: any) => artifact.id !== artifactId)), "moving membership removes the retained source from the previous workspace");
    for (const suffix of ["/catalog", "/components", "/components/missing"])
      assert.equal((await host.fetchApi(`${path}${suffix}`, "viewer")).status, 404, "stale workspace routes cannot follow a checkout into another workspace");
    assert.equal((await host.fetchApi(`${path}/refresh`, "owner", {})).status, 404);
    assert.equal((await host.fetchApi(`${path}/catalog/projects`, "owner", { requestId: randomUUID(), revision: 0, action: "create", value: { name: "Stale draft", description: "Must not create in the moved workspace", repositoryIds: ["rehearsal"] } })).status, 404);
    const renamedGroup = await host.fetchApi(`/project-groups/${movedGroup.body.id}`, "owner", { requestId: randomUUID(), revision: movedGroup.body.revision, name: "Renamed workspace" }, {}, "PUT");
    assert.equal(renamedGroup.status, 200);
    const renamedUnderstanding = await host.fetchApi(`/project-groups/${movedGroup.body.id}/understanding`, "viewer");
    assert.equal(renamedUnderstanding.body.workspace.name, "Renamed workspace");
    assert.ok(renamedUnderstanding.body.repositories[0].current.some((artifact: any) => artifact.id === artifactId), "renaming a workspace preserves its retained source evidence");

    // Replacing the enrolled directory at the same path must withhold its old artifact.
    const enrolledPath = host.config.projects[0].path;
    const movedPath = join(temp, "old-checkout");
    renameSync(enrolledPath, movedPath);
    mkdirSync(enrolledPath);
    initializeRepo(enrolledPath);
    await host.stopApi();
    await host.start();
    const currentGroups = await host.fetchApi("/project-groups", "viewer");
    const currentGroup = currentGroups.body.groups.find((value: any) => value.repos.some((repo: any) => repo.checkouts.some((checkout: any) => checkout.projectId === "rehearsal")));
    const replaced = await host.fetchApi(`/project-groups/${currentGroup.id}/understanding`, "viewer");
    assert.ok(replaced.body.repositories.every((value: any) => value.current.every((artifact: any) => artifact.id !== artifactId)));
  } finally {
    await host.stop();
    rmSync(temp, { recursive: true, force: true });
  }
});

test("an enrolled checkout replaced while its model is running cannot publish a retained brief", { timeout: 60000 }, async () => {
  const temp = mkdtempSync("/tmp/inf-understanding-rebind-");
  const receipt = join(temp, "started.txt"), release = join(temp, "release.txt");
  const fixture = join(process.cwd(), "tests/fixtures/understanding-delayed-brief.mjs");
  const host = await startHost({ config: { attention, repositoryBriefings: {
    command: process.execPath, args: [fixture, receipt, release], automatic: true, intervalMs: 100, cooldownMs: 0, timeoutMs: 20000,
  } } });
  try {
    initializeRepo(host.config.projects[0].path);
    const sessionId = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: sessionId, provider: "demo", projectId: "rehearsal", title: "Rebound source", prompt: "hook dialog" });
    const detail = await waitFor(() => host.fetchApi(`/sessions/${sessionId}`), result => result.body.attention?.state === "needs-you" && result.body.attention.prompt?.hash, 15000);
    const control = await claimControl(host, sessionId, "owner");
    await host.fetchApi(`/sessions/${sessionId}/answer`, "owner", { requestId: randomUUID(), promptId: detail.body.attention.prompt.id, option: 0 }, control.headers);
    await waitFor(async () => { try { return readFileSync(receipt, "utf8"); } catch { return ""; } }, value => value.includes("started"), 15000);
    const group = (await host.fetchApi("/project-groups", "viewer")).body.groups.find((value: any) => value.repos.some((repo: any) => repo.checkouts.some((checkout: any) => checkout.projectId === "rehearsal")));
    const active = await host.fetchApi(`/project-groups/${group.id}/understanding`, "viewer");
    assert.equal(active.body.repositories[0].state, "updating", "the read model exposes in-flight briefing status without asking the runtime to do more work");
    const original = host.config.projects[0].path, moved = join(temp, "previous-checkout");
    renameSync(original, moved);
    mkdirSync(original);
    initializeRepo(original);
    writeFileSync(release, "continue\n");
    const status = await waitFor(() => host.fetchApi(`/sessions/${sessionId}/summary?status=1`, "viewer"), result => result.body.state === "failed", 20000);
    assert.equal(status.body.state, "failed");
    const understanding = await host.fetchApi(`/project-groups/${group.id}/understanding`, "viewer");
    assert.ok(understanding.body.repositories.every((repo: any) => repo.current.length === 0), "the in-flight output is withheld after source identity changes");
  } finally {
    writeFileSync(release, "continue\n");
    await host.stop();
    rmSync(temp, { recursive: true, force: true });
  }
});

test("work scope uses pinned membership, folds alternate checkouts, and omits managed child runs", () => {
  const temp = mkdtempSync("/tmp/inf-understanding-work-");
  try {
    const group: any = { id: "workspace", name: "Workspace", kind: "owner", hidden: false, implicit: false, revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", repos: [
      { projectId: "primary", name: "Primary", path: "/workspace/primary", checkouts: [{ projectId: "primary", name: "Primary", path: "/workspace/primary", primary: true, teamReady: true }, { projectId: "alternate", name: "Alternate", path: "/workspace/alternate", primary: false, teamReady: true }] },
      { projectId: "other", name: "Other", path: "/workspace/other", checkouts: [{ projectId: "other", name: "Other", path: "/workspace/other", primary: true, teamReady: true }] },
    ] };
    const calls = { trackerLists: 0 };
    const mission = (id: string, repoProjectIds: string[], status = "cancelled") => ({ id, repoProjectIds, title: `Mission ${id}`, objective: "original request", result: { summary: "recorded outcome" }, status, updatedAt: "2026-10-21T00:00:00.000Z" });
    const missions = { understandingRecords: () => [mission("split", ["alternate", "other", "outside"]), mission("folded", ["alternate"])], understandingOwnsSession: () => false };
    const child = { id: "child", projectId: "primary", title: "Duplicate child", objective: "must be omitted", status: "merged", updatedAt: "2026-10-21T00:00:00.000Z", missionId: "split" };
    const teams = { understandingRecords: () => [child], understandingOwnsSession: () => false, list() { calls.trackerLists++; throw new Error("side-effecting team view was called"); } };
    const service = new UnderstandingService({ config: { stateDir: join(temp, "state"), projects: [] } as never, key: Buffer.alloc(32), manager: {} as never,
      groups: { list: () => ({ groups: [group], suggestions: [] }), get: () => group }, missions: missions as never, teams: teams as never, goals: { understandingRecords: () => [] } as never });
    const value = service.get("workspace");
    const split = value.work.find(item => item.sourceId === "split")!, folded = value.work.find(item => item.sourceId === "folded")!;
    assert.equal(split.scope, "partial");
    assert.deepEqual(split.repositoryIds, ["primary", "other"]);
    assert.equal(split.title, "Cross-workspace work item");
    assert.equal(split.objective, null);
    assert.equal(split.reportedSummary, null);
    assert.deepEqual(folded.repositoryIds, ["primary"]);
    assert.equal(folded.scope, "complete");
    assert.equal(folded.status, "cancelled");
    assert.ok(!value.work.some(item => item.sourceId === "child"));
    assert.equal(calls.trackerLists, 0);
    assert.ok(value.coverage.some(item => /briefs.*not linked.*work items/i.test(item)));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

function teamFixture(temp: string) {
  const repo = join(temp, "repo"); mkdirSync(repo); initializeRepo(repo);
  const project = { id: "repo", name: "Repo", path: repo };
  const root = realpathSync(repo), stat = statSync(root), runId = randomUUID(), memberId = randomUUID();
  const identity = `root:${execFileSync("git", ["-C", repo, "rev-list", "--max-parents=0", "HEAD"], { encoding: "utf8" }).trim()}`;
  const key = Buffer.alloc(32, 1), stateDir = join(temp, "state"), artifactDir = join(stateDir, "understanding", "artifacts");
  mkdirSync(artifactDir, { recursive: true });
  const member = join(temp, "member"); mkdirSync(member);
  const memberReal = realpathSync(member), memberStat = statSync(memberReal);
  const binding = { projectId: "repo", sourceKind: "team", enrolledPath: root, root: memberReal, sourceCwd: memberReal, projectDevice: String(stat.dev), projectInode: String(stat.ino),
    rootDevice: String(memberStat.dev), rootInode: String(memberStat.ino), sourceCwdDevice: String(memberStat.dev), sourceCwdInode: String(memberStat.ino),
    repoIdentity: createHash("sha256").update(JSON.stringify(identity)).digest("hex"), runId, memberId };
  const seal = (summary: string, extra: { head?: string | null; binding?: object } = {}) => {
    const id = randomUUID(), sessionId = randomUUID();
    const artifact = { id, sourceProjectId: "repo", sessionId, sourceKind: "team", head: "head" in extra ? extra.head : "a".repeat(40), base: null, fingerprint: "b".repeat(40), generatedAt: "2026-10-21T00:00:00.000Z", retainedAt: "2026-10-21T00:00:00.000Z", coverage: [], brief: { summary, architecture: [], changes: [], checks: [], review: [], guidance: [], unknowns: [] }, evidence: [] };
    writeSealed(join(artifactDir, `${id}.sealed`), key, "understanding-artifact", { binding: { ...binding, ...extra.binding }, artifact });
    return sessionId;
  };
  const group: any = { id: "repo", name: "Repo", kind: "implicit", hidden: false, implicit: true, revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", repos: [{ projectId: "repo", name: "Repo", path: root, key: identity, checkouts: [{ projectId: "repo", name: "Repo", path: root, primary: true, teamReady: true }] }] };
  const service = (manager: object, runs: object[] = []) => new UnderstandingService({ config: { stateDir, projects: [project] } as never, key, manager: manager as never,
    groups: { list: () => ({ groups: [group], suggestions: [] }), get: () => group }, missions: { understandingRecords: () => [], understandingOwnsSession: () => false } as never,
    teams: { understandingRecords: () => runs, understandingOwnsSession: () => false } as never, goals: { understandingRecords: () => [] } as never });
  return { member, seal, service, artifactDir, key, binding };
}

test("team briefs stay visible after their session and member workspace are removed, unless the repository binding changed", () => {
  const temp = mkdtempSync("/tmp/inf-understanding-team-cleanup-");
  try {
    const fixture = teamFixture(temp);
    fixture.seal("Kept after cleanup");
    fixture.seal("No recorded head", { head: null });
    fixture.seal("Other repository", { binding: { repoIdentity: "f".repeat(64) } });
    fixture.seal("Other checkout", { binding: { projectInode: "1" } });
    rmSync(fixture.member, { recursive: true, force: true });
    const service = fixture.service({ meta: () => { throw new Error("unknown session"); } });
    assert.deepEqual(service.get("repo").repositories[0]!.current.map(item => item.brief.summary), ["Kept after cleanup"]);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("a team brief whose session is still available keeps the ownership check after cleanup", () => {
  const temp = mkdtempSync("/tmp/inf-understanding-team-owned-");
  try {
    const fixture = teamFixture(temp);
    const sessionId = fixture.seal("Needs ownership");
    rmSync(fixture.member, { recursive: true, force: true });
    const session = { id: sessionId, projectId: "repo", cwd: fixture.member, team: { runId: fixture.binding.runId, memberId: fixture.binding.memberId, revision: 1, role: "implementer" } };
    const service = fixture.service({ meta: () => ({ session }) }, [{ id: fixture.binding.runId, members: [{ memberId: fixture.binding.memberId, sessionId, cwd: fixture.member }] }]);
    assert.deepEqual(service.get("repo").repositories[0]!.current, [], "the host does not own this session as part of the run");
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("retention keeps the newest sixteen generations per repository instead of a global cap", () => {
  const temp = mkdtempSync("/tmp/inf-understanding-retention-");
  try {
    const key = Buffer.alloc(32, 1), stateDir = join(temp, "state"), artifactDir = join(stateDir, "understanding", "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    const binding = (projectId: string) => ({ projectId, sourceKind: "project", enrolledPath: temp, root: temp, sourceCwd: temp, projectDevice: "1", projectInode: "1", rootDevice: "1", rootInode: "1", sourceCwdDevice: "1", sourceCwdInode: "1", repoIdentity: "c".repeat(64) });
    const seal = (projectId: string, index: number) => {
      const id = randomUUID(), at = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      const artifact = { id, sourceProjectId: projectId, sessionId: randomUUID(), sourceKind: "project", head: "a".repeat(40), base: null, fingerprint: "b".repeat(40), generatedAt: at, retainedAt: at, coverage: [], brief: { summary: `${projectId} ${index}`, architecture: [], changes: [], checks: [], review: [], guidance: [], unknowns: [] }, evidence: [] };
      writeSealed(join(artifactDir, `${id}.sealed`), key, "understanding-artifact", { binding: binding(projectId), artifact });
    };
    for (let index = 0; index < 20; index++) seal("repo-a", index);
    for (let index = 0; index < 5; index++) seal("repo-b", index);
    const service = new UnderstandingService({ config: { stateDir, projects: [] } as never, key, manager: {} as never, groups: {} as never, missions: {} as never, teams: {} as never, goals: {} as never });
    const kept = (service as any).state.generations.map((entry: any) => entry.artifact.brief.summary as string);
    assert.equal(kept.filter((summary: string) => summary.startsWith("repo-a ")).length, 16);
    assert.ok(!kept.includes("repo-a 3") && kept.includes("repo-a 4"), "the oldest generations of the busy repository are the ones dropped");
    assert.equal(kept.filter((summary: string) => summary.startsWith("repo-b ")).length, 5);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("retained team sources require ownership, bounded validation, and exclude mission coordinators", async t => {
  const temp = mkdtempSync("/tmp/inf-understanding-team-binding-");
  try {
    const repo = join(temp, "repo"); mkdirSync(repo); initializeRepo(repo);
    const project = { id: "repo", name: "Repo", path: repo };
    const root = realpathSync(repo), stat = statSync(root), sessionId = randomUUID(), runId = randomUUID(), memberId = randomUUID(), artifactId = randomUUID();
    const key = Buffer.alloc(32, 1), stateDir = join(temp, "state"), artifactDir = join(stateDir, "understanding", "artifacts");
    const artifact = { id: artifactId, sourceProjectId: "repo", sessionId, sourceKind: "team", head: "a".repeat(40), base: null, fingerprint: "b".repeat(40), generatedAt: "2026-10-21T00:00:00.000Z", retainedAt: "2026-10-21T00:00:00.000Z", coverage: [], brief: { summary: "Must be withheld", architecture: [], changes: [], checks: [], review: [], guidance: [], unknowns: [] }, evidence: [] };
    const binding = { projectId: "repo", sourceKind: "team", enrolledPath: root, root, sourceCwd: root, projectDevice: String(stat.dev), projectInode: String(stat.ino), rootDevice: String(stat.dev), rootInode: String(stat.ino), sourceCwdDevice: String(stat.dev), sourceCwdInode: String(stat.ino), repoIdentity: createHash("sha256").update(JSON.stringify(`root:${execFileSync("git", ["-C", repo, "rev-list", "--max-parents=0", "HEAD"], { encoding: "utf8" }).trim()}`)).digest("hex"), runId, memberId };
    mkdirSync(artifactDir, { recursive: true });
    writeSealed(join(artifactDir, `${artifactId}.sealed`), key, "understanding-artifact", { binding, artifact });
    for (let index = 1; index < 20; index++) {
      const id = randomUUID();
      writeSealed(join(artifactDir, `${id}.sealed`), key, "understanding-artifact", { binding, artifact: { ...artifact, id } });
    }
    const group: any = { id: "repo", name: "Repo", kind: "implicit", hidden: false, implicit: true, revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", repos: [{ projectId: "repo", name: "Repo", path: root, key: `root:${execFileSync("git", ["-C", repo, "rev-list", "--max-parents=0", "HEAD"], { encoding: "utf8" }).trim()}`, checkouts: [{ projectId: "repo", name: "Repo", path: root, primary: true, teamReady: true }] }] };
    const session: any = { id: sessionId, projectId: "repo", cwd: root, team: { runId, memberId, revision: 1, role: "implementer" } };
    let owns = false, groupReads = 0, memberCwd = root;
    const manager = { meta: () => ({ session }), state: async () => ({ seq: 1, capabilities: { transcript: 1 } }),
      events: () => ({ events: [{ seq: 1, type: "message", at: artifact.generatedAt, data: { id: "message", role: "user", text: "Inspect both pinned repositories" } }], cursor: 1, more: false }) };
    const briefings = new RepositoryBriefings({ command: process.execPath, args: [join(process.cwd(), "tests/fixtures/jevcode-brief.mjs"), join(temp, "calls.jsonl")], automatic: false, intervalMs: 100, cooldownMs: 0, timeoutMs: 10000 }, manager as never, [project]);
    const service = new UnderstandingService({ config: { stateDir, projects: [project] } as never, key, manager: manager as never, briefings,
      groups: { list: () => ({ groups: [group], suggestions: [] }), get: () => { groupReads++; return group; } }, missions: { understandingRecords: () => [], understandingOwnsSession: () => true } as never,
      teams: { understandingRecords: () => [{ id: runId, members: [{ memberId, sessionId, cwd: memberCwd }] }], understandingOwnsSession: () => owns } as never, goals: { understandingRecords: () => [] } as never });
    assert.deepEqual(service.get("repo").repositories[0]!.current, []);
    owns = true;
    await t.test("repeated generations share validation only within the current read", () => {
      groupReads = 0;
      const trace = join(temp, "git-trace.jsonl"), previousTrace = process.env.GIT_TRACE2_EVENT;
      process.env.GIT_TRACE2_EVENT = trace;
      let value: WorkspaceUnderstanding;
      try { value = service.get("repo"); }
      finally { if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = previousTrace; }
      assert.equal(value.repositories[0].current.length, 16);
      assert.equal(groupReads, 1, "retained generations use one workspace membership snapshot");
      assert.ok(readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(event => event.event === "start").length <= 2, "Git subprocess work depends on checkout count, not generation count");
      execFileSync("git", ["-C", repo, "config", "remote.origin.url", "https://example.invalid/rebound.git"]);
      assert.deepEqual(service.get("repo").repositories[0].current, [], "a later read must notice changed Git identity");
      execFileSync("git", ["-C", repo, "config", "--unset", "remote.origin.url"]);
      assert.equal(service.get("repo").repositories[0].current.length, 16);
    });
    await t.test("a generated team snapshot is withheld after ownership or cwd changes", async () => {
      const summary = await briefings.summarize(session, "0");
      assert.equal(summary.engine, "jevcode");
      assert.ok(service.get("repo").repositories[0].current.some(item => item.brief.summary === "Fixture repository brief." && item.sourceKind === "team"));
      owns = false;
      assert.equal(service.get("repo").repositories[0].current.length, 0);
      owns = true;
      memberCwd = join(temp, "moved-member"); mkdirSync(memberCwd);
      assert.equal(service.get("repo").repositories[0].current.length, 0, "a recorded member rebind revokes the old source");
      session.cwd = memberCwd;
      assert.equal(service.get("repo").repositories[0].current.length, 0, "moving both live and recorded cwd cannot reuse the old artifact binding");
      memberCwd = root; session.cwd = root;
      assert.equal(service.get("repo").repositories[0].current.length, 16);
    });
    session.team.role = "mission-coordinator";
    await t.test("previously retained mission-coordinator content is withheld", () => {
      assert.equal(service.get("repo").repositories[0].current.length, 0, "single-repository bindings cannot authorize multi-repository mission context");
    });
    await t.test("the runtime refuses to retain a new mission-coordinator brief", async () => {
      session.id = randomUUID();
      await assert.rejects(briefings.summarize(session, "0"));
      assert.equal(readdirSync(artifactDir).filter(file => file.endsWith(".sealed")).length, 16);
    });
    await briefings.close();
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("generated plans and projects derive from recorded work without touching the catalog", { timeout: 40000 }, async () => {
  let viewer: ReturnType<typeof createRemoteClient> | undefined;
  const host = await startHost({ config: { remote: { enabled: true } } });
  try {
    initializeRepo(host.config.projects[0].path);
    await host.stopApi();
    retainGoal(host, 1, "Build the thing");
    await host.start();
    viewer = createRemoteClient({ url: host.origin, token: host.tokens.viewer });
    const path = await understandingPath(host);
    const page = await viewer.request<GeneratedCatalogPage>(`${path}/generated`);
    assert.equal(page.plans.length, 1);
    assert.equal(page.plans[0].basis, "work");
    assert.equal(page.plans[0].objective, "Build the thing");
    assert.equal(page.plans[0].status, "cancelled");
    assert.deepEqual(page.projects.map(project => project.planIds), [[page.plans[0].id]]);
    assert.equal((await viewer.request<WorkspaceUnderstanding>(path)).knowledge?.catalog.revision, 0);
  } finally { viewer?.close(); await host.stop(); }
});
