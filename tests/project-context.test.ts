import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Manager } from "../packages/host/src/manager.js";
import { ProjectContexts } from "../packages/host/src/project-context.js";
import { intakeConfigSchema } from "../packages/host/src/intake-types.js";
import { createIntakeAudienceGuard } from "../packages/host/src/intake-audience.js";
import type { ProjectGroup } from "../packages/host/src/project-group-types.js";
import { writeSealed } from "../packages/host/src/vault.js";
import type { Project } from "../packages/host/src/types.js";
import { startHost } from "./helpers.js";

test("project context and links bind to the verified company and repository once per operation", async t => {
  const root = mkdtempSync(join(tmpdir(), "project-context-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const alphaPath = join(root, "alpha"), betaPath = join(root, "beta"), gammaPath = join(root, "gamma"), outsidePath = join(root, "outside"), localRepoPath = join(root, "local-repo");
  for (const path of [alphaPath, betaPath, gammaPath, outsidePath, localRepoPath]) mkdirSync(path);
  const key = randomBytes(32);
  const projects: Project[] = [
    { id: "alpha", name: "Alpha", path: alphaPath, source: { mode: "github" as const, repository: "example/alpha", baseBranch: "main" } },
    { id: "beta", name: "Beta", path: betaPath, source: { mode: "github" as const, repository: "example/beta", baseBranch: "main" } },
    { id: "gamma", name: "Gamma", path: gammaPath, source: { mode: "github" as const, repository: "example/gamma", baseBranch: "main" } },
    { id: "outside", name: "Outside", path: outsidePath },
    { id: "local-repo", name: "Local repo", path: localRepoPath, source: { mode: "github" as const, repository: "example/local-a", baseBranch: "main" } },
  ];
  const repositories = new Map([[alphaPath, "example/alpha"], [betaPath, "example/beta"], [gammaPath, "example/gamma"]]);
  const repoKey = (repository: string) => `remote:github.com/${repository}`;
  const repoRows = projects.slice(0, 3).map(project => ({
    projectId: project.id, name: project.name, path: project.path, key: repoKey(project.source!.repository),
    checkouts: [{ projectId: project.id, name: project.name, path: project.path, primary: true, teamReady: true }],
  }));
  const group: ProjectGroup = { id: "workspace", name: "Workspace", kind: "owner", hidden: false, repos: repoRows, implicit: false, revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  const intake = intakeConfigSchema.parse({
    linear: { teamIds: [randomUUID()], creatorId: randomUUID(), label: "work" },
    mission: { groupId: "workspace" },
    slack: {
      teamId: "T000", ownerUserId: "U000", appTokenFile: join(root, "app"), botTokenFile: join(root, "bot"),
      organizationScope: { workspaces: projects.slice(0, 3).map(project => ({ projectId: project.id, path: project.path, repository: project.source!.repository })) },
    },
  });
  const config = { stateDir: join(root, "state"), projects, intake };
  const calls = new Map<string, number>();
  const guard = createIntakeAudienceGuard({
    config,
    groups: { get: () => group },
    realpath: path => path,
    git: (cwd, args) => {
      calls.set(cwd, (calls.get(cwd) ?? 0) + 1);
      const command = args.join(" ");
      if (command === "rev-parse --show-toplevel") return cwd;
      if (command === "rev-parse --verify HEAD") return "a".repeat(40);
      if (command === "remote -v") return `origin https://github.com/${repositories.get(cwd)}.git (fetch)\norigin https://github.com/${repositories.get(cwd)}.git (push)`;
      return undefined;
    },
  });
  const contexts = new ProjectContexts(config, key, () => guard.workspaceBindings());

  contexts.setContext("alpha", "alpha private marker", 0);
  contexts.setContext("beta", "beta private marker", 0);
  contexts.setContext("gamma", "gamma private marker", 0);
  contexts.setContext("outside", "outside local marker", 0);
  const listing = new Manager({
    port: 0, origin: "http://127.0.0.1", keyFile: join(root, "key"), stateDir: config.stateDir, runDir: join(root, "run"),
    environment: "local", enableDemo: false, maxSessions: 8, agents: {}, tokens: [], projects,
  }, key);
  await listing.list();
  const reopened = new ProjectContexts(config, key, guard.workspaceBindings);
  assert.equal(reopened.context("alpha").text, "alpha private marker", "a read-only manager cannot revoke the serving host's context enrollment");
  contexts.setContext("local-repo", "owner repository context", 0);
  contexts.setLinks("alpha", { expectedVersion: 0, links: [
    { projectId: "beta", relationship: "Uses the API" }, { projectId: "gamma", relationship: "Uses the events" },
  ] });
  calls.clear();
  const snapshot = contexts.snapshot("alpha");
  assert.match(snapshot.text, /alpha private marker/);
  assert.match(snapshot.text, /beta private marker/);
  assert.match(snapshot.text, /gamma private marker/);
  assert.equal(calls.get(alphaPath), 3, "the authoritative verifier scans each enrolled checkout once for the operation");
  assert.equal(calls.get(betaPath), 3, "linked context reads reuse the operation's verified bindings");
  assert.equal(calls.get(gammaPath), 3);

  const beta = projects[1]!;
  beta.source!.repository = "example/replacement-beta";
  repositories.set(betaPath, beta.source!.repository);
  repoRows[1]!.key = repoKey(beta.source!.repository);
  intake.slack!.organizationScope!.workspaces!.find(pin => pin.projectId === "beta")!.repository = beta.source!.repository;
  calls.clear();
  const staleLink = contexts.listLinks("alpha");
  assert.equal(staleLink.binding, undefined, "a target-only replacement does not stale the source project binding");
  assert.deepEqual(staleLink.links, [{ projectId: "gamma", relationship: "Uses the events" }], "independent valid links stay available");
  assert.equal(calls.get(alphaPath), 3);
  assert.equal(calls.get(betaPath), 3);
  assert.equal(calls.get(gammaPath), 3);
  const filteredSnapshot = contexts.snapshot("alpha");
  assert.match(filteredSnapshot.text, /alpha private marker/);
  assert.match(filteredSnapshot.text, /gamma private marker/);
  assert.doesNotMatch(filteredSnapshot.text, /beta private marker|Uses the API/);

  const alpha = projects[0]!;
  alpha.source!.repository = "example/replacement-alpha";
  repositories.set(alphaPath, alpha.source!.repository);
  repoRows[0]!.key = repoKey(alpha.source!.repository);
  intake.slack!.organizationScope!.workspaces!.find(pin => pin.projectId === "alpha")!.repository = alpha.source!.repository;
  const staleContext = contexts.context("alpha");
  assert.equal(staleContext.text, "", "same project ID and canonical path do not preserve text across repository identities");
  assert.equal("binding" in staleContext ? staleContext.binding : undefined, "review-required");
  assert.equal(contexts.setContext("alpha", "reviewed replacement context", staleContext.version).version, 2);

  calls.clear();
  assert.equal(contexts.context("local-repo").text, "owner repository context");
  assert.equal(calls.size, 0, "an unchanged Slack company keeps unpinned reads free of Git scans");
  intake.slack!.teamId = "T999";
  assert.equal(contexts.context("alpha").text, "", "a different company cannot read the prior binding");
  assert.equal(contexts.context("outside").text, "", "a different Slack company cannot read even an unpinned project's prior context");
  assert.equal(contexts.setContext("outside", "reviewed team context", 1).version, 2, "an owner can explicitly save for the current company");
  calls.clear();
  assert.equal(contexts.context("local-repo").text, "", "team replacement revokes unpinned repository notes");
  contexts.setContext("local-repo", "reviewed local repository context", 1);
  const localRepository = contexts.context("local-repo");
  assert.equal(localRepository.text, "reviewed local repository context");
  assert.equal(calls.size, 0, "an unpinned project does not trigger whole-workspace Git verification");
  projects[4]!.source!.repository = "example/local-b";
  const reenrolled = contexts.context("local-repo");
  assert.equal(reenrolled.text, "", "owner re-enrollment to a different configured repository revokes same-path context");
  assert.equal("binding" in reenrolled ? reenrolled.binding : undefined, "review-required");
  assert.equal(calls.size, 0, "unscoped owner repository identity uses config without Git scans");
  intake.slack!.organizationScope!.workspaces = intake.slack!.organizationScope!.workspaces!.filter(pin => pin.projectId !== "alpha");
  assert.equal(contexts.context("alpha").text, "", "removing the pin cannot turn a scoped record into local context");
  intake.slack!.organizationScope!.workspaces.push({ projectId: "alpha", path: alphaPath, repository: alpha.source!.repository });
  const repinned = contexts.context("alpha");
  assert.equal(repinned.text, "", "removing and restoring the exact pin still requires explicit review");
  assert.equal("binding" in repinned ? repinned.binding : undefined, "review-required");
  calls.clear();
  assert.equal(contexts.context("outside").text, "reviewed team context", "an unchanged Slack company retains explicitly reviewed unpinned context");
  assert.equal(calls.size, 0, "an unchanged Slack company keeps unpinned reads free of Git scans");
  intake.slack = undefined;
  assert.equal(contexts.context("alpha").text, "", "disabling Slack cannot revive the former scoped binding");
  assert.equal(contexts.context("outside").text, "", "disabling Slack revokes the former company's unpinned context");
  assert.equal(contexts.setContext("outside", "reviewed Slack-free context", 2).version, 3);
  intake.slack = intakeConfigSchema.parse({
    linear: { teamIds: [randomUUID()], creatorId: randomUUID(), label: "work" }, mission: { groupId: "workspace" },
    slack: { teamId: "T999", ownerUserId: "U000", appTokenFile: join(root, "app"), botTokenFile: join(root, "bot"),
      organizationScope: { workspaces: projects.slice(1, 3).map(project => ({ projectId: project.id, path: project.path, repository: project.source!.repository })) } },
  }).slack;
  assert.equal(contexts.context("outside").text, "", "re-enabling the same Slack company does not restore pre-removal context");
  const tokenFile = intake.slack!.appTokenFile;
  intake.slack!.appTokenFile = "";
  const incomplete = contexts.context("outside");
  assert.equal(incomplete.text, "", "an incomplete Slack app cannot use local context");
  assert.equal("binding" in incomplete ? incomplete.binding : undefined, "review-required");
  assert.throws(() => contexts.setContext("outside", "unverified save", incomplete.version), /enrollment could not be verified/);
  intake.slack!.appTokenFile = tokenFile;
  intake.slack = undefined;

  const ownerAlpha = { id: "owner-alpha", name: "Owner Alpha", path: join(root, "owner-alpha"), source: { mode: "github" as const, repository: "example/owner-alpha", baseBranch: "main" }, team: { checks: [], establishChecks: true as const, delivery: { mode: "pr" as const, repository: "example/owner-delivery", baseBranch: "main" } } };
  const ownerBeta = { id: "owner-beta", name: "Owner Beta", path: join(root, "owner-beta"), source: { mode: "github" as const, repository: "example/owner-beta", baseBranch: "main" } };
  mkdirSync(ownerAlpha.path); mkdirSync(ownerBeta.path);
  config.projects.push(ownerAlpha, ownerBeta);
  contexts.setContext(ownerAlpha.id, "owner alpha", 0);
  contexts.setContext(ownerBeta.id, "owner beta", 0);
  contexts.setLinks(ownerAlpha.id, { expectedVersion: 0, links: [{ projectId: ownerBeta.id, relationship: "Shares an interface" }] });
  assert.match(contexts.snapshot(ownerAlpha.id).text, /owner beta/);
  ownerBeta.source.repository = "example/owner-beta-reenrolled";
  assert.deepEqual(contexts.listLinks(ownerAlpha.id).links, [], "valid Slack-free links are bound to both configured repositories");
  assert.equal(contexts.snapshot(ownerAlpha.id).text, "owner alpha", "a revoked target link does not block the source project launch");
  const sourceRepository = ownerAlpha.source.repository;
  ownerAlpha.source.repository = ownerAlpha.team.delivery.repository;
  ownerAlpha.team.delivery.repository = sourceRepository;
  const swapped = contexts.context(ownerAlpha.id);
  assert.equal(swapped.text, "", "swapping configured source and delivery repositories changes provenance");
  assert.equal("binding" in swapped ? swapped.binding : undefined, "review-required");

  const legacyFile = join(config.stateDir, "contexts", "legacy.sealed");
  writeSealed(legacyFile, key, "context:legacy", { version: 4, text: "unproven old note", root: realpathSync(outsidePath) });
  config.projects.push({ id: "legacy", name: "Legacy", path: outsidePath });
  const legacy = contexts.context("legacy");
  assert.equal(legacy.text, "", "path-only sealed notes need an explicit owner save");
  assert.equal("binding" in legacy ? legacy.binding : undefined, "review-required");
  writeSealed(join(config.stateDir, "context-links", "legacy.sealed"), key, "context-links:legacy", {
    version: 4, root: realpathSync(outsidePath), links: [{ projectId: "alpha", relationship: "old relationship", root: realpathSync(outsidePath) }],
  });
  const legacyLinks = contexts.listLinks("legacy");
  assert.equal(legacyLinks.binding, "review-required", "path-only sealed links need an explicit relink");
  assert.deepEqual(legacyLinks.links, []);
  assert.deepEqual(contexts.setLinks("legacy", { expectedVersion: 4, links: [] }), { version: 5, links: [] });
});

test("project context is isolated, linked explicitly in one direction, and revoked for future sessions", { timeout: 60000 }, async () => {
  const root = mkdtempSync("/tmp/context-scope-");
  for (const name of ["alpha", "beta", "gamma"]) mkdirSync(join(root, name));
  const host = await startHost({ config: { projects: [
    { id: "alpha", name: "Alpha", path: join(root, "alpha") },
    { id: "alias", name: "Alias", path: join(root, "alpha") },
    { id: "beta", name: "Beta", path: join(root, "beta") },
    { id: "gamma", name: "Gamma", path: join(root, "gamma") },
  ] } });
  const api = host.fetchApi;
  const launch = async (projectId: string) => {
    const response = await api("/sessions", "owner", { requestId: randomUUID(), provider: "demo", projectId, title: "Scope check", prompt: "Inspect this project" });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
  };
  const links = (project: string, expectedVersion: number, values: { projectId: string; relationship: string }[], role: "owner" | "controller" = "owner") =>
    api(`/projects/${project}/context-links`, role, { expectedVersion, links: values }, {}, "PUT");
  try {
    for (const name of ["alpha", "beta", "gamma"]) {
      assert.equal((await api(`/projects/${name}/context`, "owner", { text: `${name}-private-marker`, expectedVersion: 0 }, {}, "PUT")).status, 200);
    }
    assert.equal((await launch("alpha")).context, "alpha-private-marker");
    assert.equal((await launch("alias")).context, "", "same directory does not authorize sharing");
    assert.equal((await links("alpha", 0, [{ projectId: "beta", relationship: "Uses the API" }], "controller")).status, 403);
    assert.equal((await links("beta", 0, [{ projectId: "gamma", relationship: "Uses the library" }])).status, 200);

    const client = join(root, "client.json");
    writeFileSync(client, JSON.stringify({ origin: host.origin, token: host.tokens.owner }), { mode: 0o600 });
    const cli = ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", client];
    const exec = promisify(execFile);
    const linked = JSON.parse((await exec(process.execPath, [...cli, "repo", "link", "beta", "--project", "alpha", "--relationship", "Uses the API"])).stdout);
    assert.equal(linked.version, 1);
    const shared = await launch("alpha");
    assert.match(shared.context, /alpha-private-marker/);
    assert.match(shared.context, /beta-private-marker/);
    assert.doesNotMatch(shared.context, /gamma-private-marker/);
    assert.deepEqual(shared.contextSources.map((source: any) => source.projectId), ["alpha", "beta"]);
    assert.equal(shared.contextSources[1].relationship, "Uses the API");
    assert.doesNotMatch((await launch("beta")).context, /alpha-private-marker/);
    assert.equal((await links("alpha", 0, [])).status, 409, "stale writes cannot revoke a new relationship");
    await host.stopApi(); await host.start();
    assert.match((await launch("alpha")).context, /beta-private-marker/, "relationship survives host restart");
    await exec(process.execPath, [...cli, "repo", "unlink", "beta", "--project", "alpha"]);
    assert.equal((await launch("alpha")).context, "alpha-private-marker");
    assert.match(shared.context, /beta-private-marker/, "a saved session is a historical snapshot");
    assert.equal((await links("alpha", 2, [{ projectId: "missing", relationship: "Unknown" }])).status, 404);
    assert.equal((await links("alpha", 2, [{ projectId: "alpha", relationship: "Self" }])).status, 400);

    await host.stopApi();
    const configFile = join(host.root, "config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    config.projects.find((project: any) => project.id === "alpha").path = join(root, "gamma");
    writeFileSync(configFile, JSON.stringify(config));
    await host.start();
    const changed = await api("/sessions", "owner", { requestId: randomUUID(), provider: "demo", projectId: "alpha", title: "Changed checkout", prompt: "Inspect" });
    assert.equal(changed.status, 409);
    assert.match(changed.body.error, /codebase|binding/i);
    const withheld = await api("/projects/alpha/context");
    assert.equal(withheld.body.binding, "review-required");
    assert.equal(withheld.body.text, "", "a changed codebase cannot read the old project text");
    assert.equal((await api("/projects/alpha/context", "owner", { text: "reviewed-new-context", expectedVersion: withheld.body.version }, {}, "PUT")).status, 200);
    const staleLinks = JSON.parse((await exec(process.execPath, [...cli, "repo", "links", "--project", "alpha"])).stdout);
    assert.equal(staleLinks.binding, "review-required");
    await exec(process.execPath, [...cli, "repo", "unlink", "beta", "--project", "alpha"]);
    assert.equal((await launch("alpha")).context, "reviewed-new-context", "explicit owner review recovers a changed codebase without its old context");
  } finally { await host.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("HTTP and Manager withhold same-path context after owner GitHub re-enrollment", { timeout: 30000 }, async () => {
  const host = await startHost();
  const configFile = join(host.root, "config.json"), contextMarker = "original repository owner note";
  const request = () => ({ requestId: randomUUID(), provider: "demo", projectId: "rehearsal", title: "Repository review", prompt: "Inspect this repository" });
  try {
    await host.stopApi();
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    config.projects[0].source = { mode: "github", repository: "example/original", baseBranch: "main" };
    writeFileSync(configFile, JSON.stringify(config));
    await host.start();

    const saved = await host.fetchApi("/projects/rehearsal/context", "owner", { text: contextMarker, expectedVersion: 0 }, {}, "PUT");
    assert.equal(saved.status, 200);
    const firstLaunch = await host.fetchApi("/sessions", "owner", request());
    assert.equal(firstLaunch.status, 201, JSON.stringify(firstLaunch.body));
    assert.equal(firstLaunch.body.context, contextMarker, "a verified same-project launch receives the saved owner note");
    const launchedId = firstLaunch.body.id;

    await host.stopApi();
    const reconfigured = JSON.parse(readFileSync(configFile, "utf8"));
    reconfigured.projects[0].source.repository = "example/replacement";
    writeFileSync(configFile, JSON.stringify(reconfigured));
    await host.start();

    const visible = await host.fetchApi("/projects/rehearsal/context");
    assert.equal(visible.body.text, "", "HTTP never discloses text from the previous repository");
    assert.equal(visible.body.binding, "review-required");
    const blockedLaunch = await host.fetchApi("/sessions", "owner", request());
    assert.equal(blockedLaunch.status, 409, "Manager refuses to construct a worker launch with stale context");
    assert.doesNotMatch(JSON.stringify(blockedLaunch.body), new RegExp(contextMarker));
    const sessions = await host.fetchApi("/sessions");
    assert.deepEqual(sessions.body.sessions.map((session: any) => session.id), [launchedId], "the rejected request creates no worker session");
  } finally { await host.stop(); }
});

test("workspace enrollment bounds saved context links on reads and writes in both directions", t => {
  const root = mkdtempSync(join(tmpdir(), "linked-context-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = ["alpha", "beta", "outside", "unknown"].map(id => {
    const path = join(root, id);
    mkdirSync(path);
    return { id, name: id, path };
  });
  const config = { projects, stateDir: join(root, "state") };
  const key = randomBytes(32);
  const prior = new ProjectContexts(config, key);
  for (const { id } of projects) prior.setContext(id, id + " context", 0);
  const link = (projectId: string) => ({ projectId, relationship: "uses " + projectId });
  prior.setLinks("alpha", { expectedVersion: 0, links: [link("beta"), link("outside")] });
  prior.setLinks("outside", { expectedVersion: 0, links: [link("alpha")] });

  const intake = intakeConfigSchema.parse({
    linear: { teamIds: [randomUUID()], creatorId: randomUUID(), label: "work" },
    mission: { groupId: "work" },
    slack: {
      teamId: "T000", ownerUserId: "U000", appTokenFile: join(root, "app"), botTokenFile: join(root, "bot"),
      organizationScope: { workspaces: projects.slice(0, 2).map(p => ({ projectId: p.id, path: p.path, repository: "example/" + p.id })) },
    },
  });
  const bindings = new Map(["alpha", "beta"].map(id => [id, { companyId: "company-a", repositoryId: `repo:${id}` }]));
  const scoped = new ProjectContexts({ ...config, intake }, key, () => bindings);
  for (const id of ["alpha", "beta"]) scoped.setContext(id, `${id} context`, 1);
  scoped.setContext("outside", "reviewed outside context", 1);
  assert.equal(scoped.listLinks("alpha").binding, "review-required", "unscoped historical relationships require an explicit relink");
  scoped.setLinks("alpha", { expectedVersion: 1, links: [link("beta")] });
  scoped.setLinks("outside", { expectedVersion: 1, links: [] });
  assert.deepEqual(scoped.listLinks("alpha").links, [link("beta")]);
  const alpha = scoped.snapshot("alpha");
  assert.deepEqual(alpha.sources.map(s => s.projectId), ["alpha", "beta"]);
  assert.match(alpha.text, /beta context/);
  assert.doesNotMatch(alpha.text, /outside/);
  assert.deepEqual(scoped.listLinks("outside").links, []);
  assert.equal(scoped.snapshot("outside").text, "reviewed outside context", "pre-Slack local notes need explicit re-save after enrollment");
  assert.throws(() => scoped.setLinks("alpha", { expectedVersion: 2, links: [link("outside")] }), /workspace audience/);
  assert.throws(() => scoped.setLinks("outside", { expectedVersion: 2, links: [link("unknown")] }), /workspace audience/);

  const replacement = join(root, "replacement");
  mkdirSync(replacement);
  const beta = projects.find(p => p.id === "beta")!;
  beta.path = replacement;
  intake.slack!.organizationScope!.workspaces!.find(p => p.projectId === "beta")!.path = replacement;
  assert.equal(scoped.listLinks("alpha").binding, undefined, "a revoked target relationship does not stale the source binding");
  assert.deepEqual(scoped.listLinks("alpha").links, []);
  assert.equal(scoped.snapshot("alpha").text, "alpha context", "a revoked target relationship does not block the source launch");
  scoped.setLinks("alpha", { expectedVersion: 2, links: [] });
  assert.equal(scoped.snapshot("alpha").text, "alpha context");
});
