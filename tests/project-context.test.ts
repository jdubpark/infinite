import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ProjectContexts } from "../packages/host/src/project-context.js";
import { intakeConfigSchema } from "../packages/host/src/intake-types.js";
import { startHost } from "./helpers.js";

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
  const scoped = new ProjectContexts({ ...config, intake }, key);
  assert.deepEqual(scoped.listLinks("alpha").links, [link("beta")]);
  const alpha = scoped.snapshot("alpha");
  assert.deepEqual(alpha.sources.map(s => s.projectId), ["alpha", "beta"]);
  assert.match(alpha.text, /beta context/);
  assert.doesNotMatch(alpha.text, /outside/);
  assert.deepEqual(scoped.listLinks("outside").links, []);
  assert.equal(scoped.snapshot("outside").text, "outside context");
  assert.throws(() => scoped.setLinks("alpha", { expectedVersion: 1, links: [link("outside")] }), /workspace audience/);
  assert.throws(() => scoped.setLinks("outside", { expectedVersion: 1, links: [link("unknown")] }), /workspace audience/);

  const replacement = join(root, "replacement");
  mkdirSync(replacement);
  const beta = projects.find(p => p.id === "beta")!;
  beta.path = replacement;
  intake.slack!.organizationScope!.workspaces!.find(p => p.projectId === "beta")!.path = replacement;
  assert.deepEqual(scoped.listLinks("alpha").links, []);
  assert.equal(scoped.snapshot("alpha").text, "alpha context");
});
