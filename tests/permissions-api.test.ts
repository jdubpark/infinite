import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHost, type Host } from "./helpers.js";
import { INTERRUPT_CLASSES, PERMISSION_POLICY_VERSION } from "../packages/host/src/permission-policy.js";

type Projection = { projectId: string; state: string };
type View = { workspaceId: string; name: string; state: string; direction?: string; projects: Projection[] };
const viewOf = (views: View[], workspaceId: string) => views.find(view => view.workspaceId === workspaceId);
const projectStates = (view: View | undefined) => view?.projects.map(project => project.state);

test("owner delegation covers one workspace or all, ends on an owner regroup also while unavailable, and reports an inactive agent", { timeout: 120000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "permissions-api-"));
  const repository = (name: string) => {
    const path = join(root, name);
    mkdirSync(path, { mode: 0o700 });
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: path, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", `https://github.com/example/${name}.git`], { cwd: path, stdio: "ignore" });
    return path;
  };
  const direction = "Run checks and read files.";
  let host: Host | undefined;
  try {
    host = await startHost({ config: { projects: [
      { id: "shop-api", name: "Shop API", path: repository("shop-api") },
      { id: "web-app", name: "Web App", path: repository("web-app") },
    ] } });
    const shopWorkspace = (await host.fetchApi("/project-groups/shop-api", "owner")).body.id as string;
    const webWorkspace = (await host.fetchApi("/project-groups/web-app", "owner")).body.id as string;
    assert.notEqual(shopWorkspace, webWorkspace);

    // Only an owner CLI acts. Controllers, viewers, anonymous callers and a browser session of the owner are refused.
    const oneWorkspace = { requestId: randomUUID(), workspaceId: shopWorkspace, direction };
    assert.equal((await host.fetchApi("/permissions/delegations", "controller", oneWorkspace)).status, 403);
    assert.equal((await host.fetchApi("/permissions/delegations", "viewer", oneWorkspace)).status, 403);
    assert.equal((await host.fetchApi("/permissions/revocations", "controller", { requestId: randomUUID(), workspaceId: shopWorkspace })).status, 403);
    assert.equal((await host.fetchApi("/permissions/status", "viewer")).status, 403);
    assert.equal((await host.fetchApi("/permissions/status", null)).status, 401);
    assert.equal((await host.fetchApi("/permissions/status", "controller")).status, 200, "controllers may read the status");
    const login = await fetch(`${host.origin}/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: host.origin }, body: JSON.stringify({ token: host.tokens.owner }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const browser = await fetch(`${host.origin}/api/permissions/delegations`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: host.origin }, body: JSON.stringify(oneWorkspace),
    });
    assert.equal(browser.status, 403, "an owner browser session without the CLI bearer cannot delegate");
    const browserRevocation = await fetch(`${host.origin}/api/permissions/revocations`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: host.origin },
      body: JSON.stringify({ requestId: randomUUID(), workspaceId: shopWorkspace }),
    });
    assert.equal(browserRevocation.status, 403, "an owner browser session without the CLI bearer cannot revoke");

    // One workspace: the other stays not-delegated, and a retry with the same request ID replays the same body.
    const first = await host.fetchApi("/permissions/delegations", "owner", oneWorkspace);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.agent, "inactive");
    assert.deepEqual(first.body.replacedOptOuts, []);
    assert.equal(first.body.views.length, 1);
    assert.equal(first.body.views[0].workspaceId, shopWorkspace);
    assert.equal(first.body.views[0].state, "delegated");
    assert.equal(first.body.views[0].direction, direction);
    assert.deepEqual(projectStates(first.body.views[0]), ["covered"]);
    const status = await host.fetchApi("/permissions/status", "owner");
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(viewOf(status.body.workspaces, shopWorkspace)?.state, "delegated");
    assert.equal(viewOf(status.body.workspaces, webWorkspace)?.state, "not-delegated");
    assert.deepEqual(projectStates(viewOf(status.body.workspaces, webWorkspace)), ["not-covered"]);
    const replay = await host.fetchApi("/permissions/delegations", "owner", oneWorkspace);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, first.body, "the same request ID returns the recorded body");
    assert.equal((await host.fetchApi("/permissions/delegations", "owner", { ...oneWorkspace, workspaceId: webWorkspace })).status, 409,
      "the same request ID for another workspace is a conflict");

    // All workspaces: both delegated, sharing the direction the owner gave.
    const everything = await host.fetchApi("/permissions/delegations", "owner", { requestId: randomUUID(), all: true, direction });
    assert.equal(everything.status, 200, JSON.stringify(everything.body));
    assert.deepEqual(everything.body.views.map((view: View) => view.workspaceId).sort(), [shopWorkspace, webWorkspace].sort());
    assert.deepEqual(everything.body.views.map((view: View) => view.state), ["delegated", "delegated"]);
    assert.deepEqual(everything.body.views.map((view: View) => view.direction), [direction, direction]);
    // The body names exactly one target: both or neither is refused.
    assert.equal((await host.fetchApi("/permissions/delegations", "owner", { requestId: randomUUID(), workspaceId: shopWorkspace, all: true })).status, 400);
    assert.equal((await host.fetchApi("/permissions/delegations", "owner", { requestId: randomUUID() })).status, 400);

    // An owner regroup moves shop-api into a new workspace. Its coverage ends and the other workspace keeps its delegation.
    const moved = await host.fetchApi("/project-groups", "owner", { requestId: randomUUID(), name: "Storefront", repos: ["shop-api"] });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const storefront = moved.body.id as string;
    const regrouped = await host.fetchApi("/permissions/status", "owner");
    assert.equal(viewOf(regrouped.body.workspaces, storefront)?.name, "Storefront");
    assert.equal(viewOf(regrouped.body.workspaces, storefront)?.state, "not-delegated");
    assert.deepEqual(projectStates(viewOf(regrouped.body.workspaces, storefront)), ["not-covered"]);
    assert.equal(viewOf(regrouped.body.workspaces, webWorkspace)?.state, "delegated");

    // Revoke returns the workspace to not-delegated, and its retry replays.
    const revocation = { requestId: randomUUID(), workspaceId: webWorkspace };
    const revoked = await host.fetchApi("/permissions/revocations", "owner", revocation);
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.agent, "inactive");
    assert.equal(revoked.body.view.workspaceId, webWorkspace);
    assert.equal(revoked.body.view.state, "not-delegated");
    assert.deepEqual(projectStates(revoked.body.view), ["not-covered"]);
    assert.deepEqual((await host.fetchApi("/permissions/revocations", "owner", revocation)).body, revoked.body);
    assert.equal(viewOf((await host.fetchApi("/permissions/status", "owner")).body.workspaces, webWorkspace)?.state, "not-delegated");

    // No permission agent yet: the rates are empty, and the capability advertises delegation.
    const settled = await host.fetchApi("/permissions/status", "owner");
    assert.equal(settled.body.agent, "inactive");
    assert.equal(settled.body.policyVersion, PERMISSION_POLICY_VERSION);
    assert.deepEqual(settled.body.interruptClasses, [...INTERRUPT_CLASSES]);
    assert.equal(settled.body.rates.lastHour.decisions, 0);
    assert.equal(settled.body.rates.lastDay.decisions, 0);
    assert.equal(settled.body.rates.lastDay.perHour, 0);
    assert.deepEqual((await host.fetchApi("/me", "owner")).body.permissions, { workspaceDelegation: 1 });

    // Scoped figures: a workspace, a session and a task need an id, the host takes none, and the window is bounded.
    const scoped = await host.fetchApi(`/permissions/rates?scope=workspace&id=${webWorkspace}&hours=24`, "controller");
    assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
    assert.deepEqual([scoped.body.scope, scoped.body.id, scoped.body.hours, scoped.body.rates.decisions], ["workspace", webWorkspace, 24, 0]);
    assert.equal((await host.fetchApi("/permissions/rates?scope=host", "owner")).body.hours, 1);
    for (const query of ["scope=workspace", `scope=host&id=${webWorkspace}`, "scope=host&hours=169", "scope=team"])
      assert.equal((await host.fetchApi(`/permissions/rates?${query}`, "owner")).status, 400, query);
    assert.equal((await host.fetchApi("/permissions/rates?scope=host", "viewer")).status, 403);

    // A state file that will not open leaves delegation unavailable: its routes answer 503, and regrouping still works.
    assert.equal((await host.fetchApi("/permissions/delegations", "owner", { requestId: randomUUID(), workspaceId: webWorkspace })).body.views[0].state, "delegated");
    await host.stopApi();
    const delegationFile = join(host.config.stateDir, "permission-delegations", "state.sealed");
    const recorded = readFileSync(delegationFile);
    writeFileSync(delegationFile, "not a sealed state\n", { mode: 0o600 });
    await host.start();
    const unavailable = { error: "Permission delegation is unavailable on this host." };
    assert.deepEqual(await host.fetchApi("/permissions/status", "owner").then(response => [response.status, response.body]), [503, unavailable]);
    assert.equal((await host.fetchApi("/permissions/delegations", "owner", { requestId: randomUUID(), all: true })).status, 503);
    assert.equal((await host.fetchApi("/permissions/revocations", "owner", revocation)).status, 503);
    const grouped = await host.fetchApi("/project-groups", "owner", { requestId: randomUUID(), name: "Catalog", repos: ["web-app"] });
    assert.equal(grouped.status, 200, JSON.stringify(grouped.body));

    // The regrouping happened while delegation was unavailable. Once its state opens again, the moved project is not covered.
    await host.stopApi();
    writeFileSync(delegationFile, recorded, { mode: 0o600 });
    await host.start();
    const recovered = await host.fetchApi("/permissions/status", "owner");
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(viewOf(recovered.body.workspaces, grouped.body.id)?.state, "not-delegated");
    assert.deepEqual(projectStates(viewOf(recovered.body.workspaces, grouped.body.id)), ["not-covered"]);
  } finally {
    if (host) await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
