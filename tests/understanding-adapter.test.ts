import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createUnderstandingAdapter } from "../packages/host/src/understanding-adapter.js";
import type { KnowledgeComponent, KnowledgePlan } from "@infinite/remote";
import type { RepoContext } from "../packages/host/src/understanding-runtime.js";
import type { Config } from "../packages/host/src/types.js";

function setup(t: test.TestContext, fixtureMode = "valid") {
  const base = mkdtempSync(join(tmpdir(), "understanding-adapter-")), root = join(base, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), "export const value = 1;\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", "."]);
  execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const context: RepoContext = { version: 1, repo: root, generatedAt: new Date().toISOString(), head, base: null,
    files: { "src/a.ts": { hash: createHash("sha1").update("export const value = 1;\n").digest("hex"), lines: 1 } },
    components: [{ id: "source-component", path: "src", name: "Source", files: 1, examples: ["src/a.ts"], entryPoints: [], incoming: 0, outgoing: 0, changed: 0 }], edges: [], limitations: [] };
  const component: KnowledgeComponent = {
    id: "component-id", name: "Source", description: "Mapped source", repositoryIds: ["repo"], paths: [{ repositoryId: "repo", path: "src" }],
    files: [{ repositoryId: "repo", path: "src/a.ts", hash: context.files["src/a.ts"].hash, lines: 1 }], pinned: false, retired: false, redirectTo: null,
    current: { state: "mapped", snapshotId: head, sources: [{ repositoryId: "repo", head, fingerprint: "b".repeat(64), observedAt: new Date().toISOString(), kind: "checkout" }], summary: "Mapped summary", claims: [], brief: null, generatedAt: null },
    planned: [], difference: { state: "unverified", summary: "No plan alignment has been verified.", claims: [], planRevisions: [], snapshotId: null, generatedAt: null }, featureIds: [], history: [], coverage: [],
  };
  const plan: KnowledgePlan = { id: "plan-id", revision: 4, componentId: component.id, repositoryIds: ["repo"], title: "Keep public export", text: "Preserve the exported value", status: "accepted", sourceUrl: null, workId: null, archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history: [] };
  const config = { projects: [], repositoryBriefings: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/understanding-brief.mjs"), fixtureMode], runner: "deepseek", model: "fixture/model", automatic: false, intervalMs: 1000, cooldownMs: 0, timeoutMs: 10000 } } as Config;
  return { root, context, component, plan, adapter: createUnderstandingAdapter(config) };
}

const options = (): { signal: AbortSignal; timeoutMs: number; maxBytes: number } => ({ signal: new AbortController().signal, timeoutMs: 10000, maxBytes: 1024 * 1024 });

test("component brief preserves the mapped source and records a cited plan difference for exact plan revision", async t => {
  const s = setup(t);
  const result = await s.adapter.synthesize!({ workspaceId: "workspace", root: s.root, repositoryId: "repo", context: s.context, components: [s.component], plans: [s.plan] }, options());
  const output = result.components[0];
  assert.equal(output.current.state, "ready");
  assert.equal(output.current.summary, "A source grounded component summary.");
  assert.deepEqual(output.paths, s.component.paths);
  assert.deepEqual(output.files, s.component.files);
  assert.deepEqual(output.current.sources, s.component.current.sources);
  assert.equal(output.difference.state, "review-needed");
  assert.deepEqual(output.difference.planRevisions, [{ id: "plan-id", revision: 4 }]);
  assert.equal(output.difference.claims[0]?.evidence[0]?.line, 1);
  assert.ok(result.coverage.includes("configured writer options reached the process boundary"));
});

test("unsupported citation is omitted while independently supported source claims remain", async t => {
  const s = setup(t, "bad-citation");
  const result = await s.adapter.synthesize!({ workspaceId: "workspace", root: s.root, repositoryId: "repo", context: s.context, components: [s.component], plans: [] }, options());
  assert.equal(result.components[0].current.state, "ready");
  assert.deepEqual(result.components[0].current.claims, []);
  assert.equal(result.components[0].current.brief?.changes.length, 1);
  assert.ok(result.coverage.some(text => /Omitted .*source reference/.test(text)));
});

test("brief for a different source fingerprint leaves the prior component untouched", async t => {
  const s = setup(t, "bad-fingerprint");
  const result = await s.adapter.synthesize!({ workspaceId: "workspace", root: s.root, repositoryId: "repo", context: s.context, components: [s.component], plans: [] }, options());
  assert.deepEqual(result.components[0], s.component);
  assert.match(result.coverage[0] ?? "", /valid source evidence/);
});

test("GitHub permission denial is reported as unavailable without leaking process output", async t => {
  const s = setup(t);
  const bin = join(s.root, "fake-bin");
  mkdirSync(bin);
  const gh = join(bin, "gh");
  writeFileSync(gh, "#!/bin/sh\nprintf '%s\\n' 'private provider response' >&2\nexit 1\n", { mode: 0o755 });
  execFileSync("git", ["-C", s.root, "remote", "add", "origin", "https://github.com/example/repo.git"]);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${previousPath ? `:${previousPath}` : ""}`;
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
  const config = { projects: [{ id: "repo", name: "Repository", path: s.root, source: { mode: "github", repository: "example/repo" } }] } as Config;
  const adapter = createUnderstandingAdapter(config);
  const result = await adapter.delivery!({ workspaceId: "workspace", root: s.root, repositoryId: "repo", head: s.context.head }, options());
  assert.equal(result.state, "unavailable");
  assert.equal(result.pullRequests.length, 0);
  assert.ok(result.coverage.some(text => /permission may be missing/.test(text)));
  assert.ok(!JSON.stringify(result).includes("private provider response"));
});

test("deployment permission denial retains pull requests and reports each provider head and status", async t => {
  const s = setup(t);
  const bin = join(s.root, "fake-bin");
  mkdirSync(bin);
  const gh = join(bin, "gh");
  writeFileSync(gh, `#!/usr/bin/env node\nif (process.argv[2] === "pr") { process.stdout.write(JSON.stringify([{ number: 7, title: "Read-only observation", url: "https://github.com/example/repo/pull/7", state: "OPEN", headRefOid: "${"c".repeat(40)}", mergeCommit: null, statusCheckRollup: [{ __typename: "StatusContext", context: "ci/build", state: "SUCCESS", targetUrl: "https://github.com/example/repo/actions" }] }])); } else { process.stderr.write("deployment permission denied"); process.exit(1); }\n`, { mode: 0o755 });
  execFileSync("git", ["-C", s.root, "remote", "add", "origin", "https://github.com/example/repo.git"]);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${previousPath ? `:${previousPath}` : ""}`;
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
  const config = { projects: [{ id: "repo", name: "Repository", path: s.root, source: { mode: "github", repository: "example/repo" } }] } as Config;
  const adapter = createUnderstandingAdapter(config);
  const result = await adapter.delivery!({ workspaceId: "workspace", root: s.root, repositoryId: "repo", head: s.context.head }, options());
  assert.equal(result.state, "ready");
  assert.equal(result.pullRequests[0]?.head, "c".repeat(40));
  assert.deepEqual(result.pullRequests[0]?.checks[0], { name: "ci/build", status: "SUCCESS", conclusion: null, url: "https://github.com/example/repo/actions" });
  assert.equal(result.environments.length, 0);
  assert.ok(result.coverage.some(text => /deployments permission may be missing/.test(text)));
  assert.ok(!JSON.stringify(result).includes("deployment permission denied"));
});

test("read-only GitHub observations accept both classic checks and deployment statuses without claiming a live probe", async t => {
  const s = setup(t);
  const bin = join(s.root, "fake-bin");
  mkdirSync(bin);
  const gh = join(bin, "gh");
  writeFileSync(gh, `#!/usr/bin/env node
const endpoint = process.argv.at(-1);
if (process.argv[2] === "pr") {
  process.stdout.write(JSON.stringify([{ number: 8, title: "Provider observation", url: "https://github.com/example/repo/pull/8", state: "MERGED", headRefOid: "${"d".repeat(40)}", mergeCommit: { oid: "${"e".repeat(40)}" }, statusCheckRollup: [{ __typename: "StatusContext", context: "legacy/ci", state: "SUCCESS", targetUrl: "https://github.com/example/repo/checks" }, { __typename: "CheckRun", name: "modern-ci", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/example/repo/actions" }] }]));
} else if (endpoint.endsWith("/deployments?per_page=10")) {
  process.stdout.write(JSON.stringify([{ id: 11, environment: "staging", sha: "${"a".repeat(40)}", created_at: "2026-10-20T10:00:00Z" }, { id: 12, environment: "staging", sha: "${"b".repeat(40)}", created_at: "2026-10-21T10:00:00Z" }]));
} else {
  const latest = endpoint.includes("/12/");
  process.stdout.write(JSON.stringify([{ state: latest ? "inactive" : "success", environment: "staging", created_at: latest ? "2026-10-21T10:01:00Z" : "2026-10-21T12:00:00Z", target_url: "https://example.invalid/deployments/" }]));
}
`, { mode: 0o755 });
  execFileSync("git", ["-C", s.root, "remote", "add", "origin", "https://github.com/example/repo.git"]);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${previousPath ? `:${previousPath}` : ""}`;
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
  const config = { projects: [{ id: "repo", name: "Repository", path: s.root, source: { mode: "github", repository: "example/repo" } }] } as Config;
  const result = await createUnderstandingAdapter(config).delivery!({ workspaceId: "workspace", root: s.root, repositoryId: "repo", head: s.context.head }, options());
  assert.equal(result.state, "ready");
  assert.equal(result.pullRequests[0]?.head, "d".repeat(40));
  assert.deepEqual(result.pullRequests[0]?.checks.map(check => check.name), ["legacy/ci", "modern-ci"]);
  assert.equal(result.environments[0]?.revision, "b".repeat(40));
  assert.equal(result.environments[0]?.status, "inactive");
  assert.notEqual(result.environments[0]?.observedAt, "2026-10-21T10:01:00Z");
  assert.ok(result.coverage.some(text => /no live probe was performed/.test(text)));
});
