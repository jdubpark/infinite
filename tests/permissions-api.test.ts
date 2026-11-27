import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { startHost, type Host } from "./helpers.js";
import { INTERRUPT_CLASSES, PERMISSION_POLICY_VERSION } from "../packages/host/src/permission-policy.js";
import { PermissionJournal, permissionJournalModule, type PermissionDecision } from "../packages/host/src/evidence/permission-journal.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";

type Projection = { projectId: string; state: string; act?: string };
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

    const everything = await host.fetchApi("/permissions/delegations", "owner", { requestId: randomUUID(), all: true, direction });
    assert.equal(everything.status, 200, JSON.stringify(everything.body));
    assert.deepEqual(everything.body.views.map((view: View) => view.workspaceId).sort(), [shopWorkspace, webWorkspace].sort());
    assert.deepEqual(everything.body.views.map((view: View) => view.state), ["delegated", "delegated"]);
    assert.deepEqual(everything.body.views.map((view: View) => view.direction), [direction, direction]);
    assert.equal((await host.fetchApi("/permissions/delegations", "owner", { requestId: randomUUID(), workspaceId: shopWorkspace, all: true })).status, 400);
    assert.equal((await host.fetchApi("/permissions/delegations", "owner", { requestId: randomUUID() })).status, 400);

    const moved = await host.fetchApi("/project-groups", "owner", { requestId: randomUUID(), name: "Storefront", repos: ["shop-api"] });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const storefront = moved.body.id as string;
    const regrouped = await host.fetchApi("/permissions/status", "owner");
    assert.equal(viewOf(regrouped.body.workspaces, storefront)?.name, "Storefront");
    assert.equal(viewOf(regrouped.body.workspaces, storefront)?.state, "not-delegated");
    assert.deepEqual(projectStates(viewOf(regrouped.body.workspaces, storefront)), ["not-covered"]);
    assert.equal(viewOf(regrouped.body.workspaces, webWorkspace)?.state, "delegated");

    const revocation = { requestId: randomUUID(), workspaceId: webWorkspace };
    const revoked = await host.fetchApi("/permissions/revocations", "owner", revocation);
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.agent, "inactive");
    assert.equal(revoked.body.view.workspaceId, webWorkspace);
    assert.equal(revoked.body.view.state, "not-delegated");
    assert.deepEqual(projectStates(revoked.body.view), ["not-covered"]);
    assert.deepEqual((await host.fetchApi("/permissions/revocations", "owner", revocation)).body, revoked.body);
    assert.equal(viewOf((await host.fetchApi("/permissions/status", "owner")).body.workspaces, webWorkspace)?.state, "not-delegated");

    const settled = await host.fetchApi("/permissions/status", "owner");
    assert.equal(settled.body.agent, "inactive");
    assert.deepEqual(settled.body.headless, { sessions: [], shadowed: [] });
    assert.equal(settled.body.policyVersion, PERMISSION_POLICY_VERSION);
    assert.deepEqual(settled.body.interruptClasses, [...INTERRUPT_CLASSES]);
    assert.equal(settled.body.rates.lastHour.decisions, 0);
    assert.equal(settled.body.rates.lastDay.decisions, 0);
    assert.equal(settled.body.rates.lastDay.perHour, 0);
    assert.deepEqual((await host.fetchApi("/me", "owner")).body.permissions, { workspaceDelegation: 1, decisionLog: 1, onboardingCoverage: 1 });

    const scoped = await host.fetchApi(`/permissions/rates?scope=workspace&id=${webWorkspace}&hours=24`, "controller");
    assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
    assert.deepEqual([scoped.body.scope, scoped.body.id, scoped.body.hours, scoped.body.rates.decisions], ["workspace", webWorkspace, 24, 0]);
    assert.equal((await host.fetchApi("/permissions/rates?scope=host", "owner")).body.hours, 1);
    for (const query of ["scope=workspace", `scope=host&id=${webWorkspace}`, "scope=host&hours=169", "scope=team"])
      assert.equal((await host.fetchApi(`/permissions/rates?${query}`, "owner")).status, 400, query);
    assert.equal((await host.fetchApi("/permissions/rates?scope=host", "viewer")).status, 403);

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

test("the owner reads the decision log and marks a decision; no other role reads a note, and a mark changes nothing", { timeout: 120000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "permissions-review-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const keyFile = join(root, "key");
  const key = randomBytes(32);
  writeFileSync(keyFile, key, { mode: 0o600 });
  const shop = join(root, "shop-api");
  mkdirSync(shop, { mode: 0o700 });
  const modelNote = "Reasoning that only the owner reads.";
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const base = (id: string, at: string, overrides: Partial<PermissionDecision> = {}): PermissionDecision => ({
    id, at, workspaceId: "shop-api", projectId: "shop-api", taskId: "run-1", assignment: "run-1/implementer", sessionId: "member-session",
    role: "implementer", provider: "claude", family: "claude", evidenceHash: `evidence-${id}`, action: { tool: "Bash", summary: "npm test" },
    rules: [], tiers: [], verdict: "allow", ...overrides,
  });
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(stateDir), vaultKey: key });
  store.register(permissionJournalModule);
  const seed = new PermissionJournal(store);
  seed.appendDecision(base("allowed", ago(50 * 60_000), { note: modelNote }));
  seed.appendDecision(base("rejected", ago(40 * 60_000), {
    verdict: "reject", code: "unsafe", rules: ["raise:destructive"], note: modelNote, action: { tool: "Bash", summary: "rm -rf build" },
    tiers: [{ tier: "strong", profileId: "strong-1", family: "gpt", startedAt: ago(40 * 60_000 + 3_000), endedAt: ago(40 * 60_000) }],
  }));
  seed.appendDelivery({ decisionId: "rejected", at: ago(39 * 60_000), kind: "intent" });
  for (let index = 0; index < 21; index++)
    seed.appendDecision(base(`busy-${index}`, ago(30 * 60_000 - index * 1_000), { sessionId: "busy-session", taskId: "busy-session", assignment: "busy-session" }));
  store.close();

  let host: Host | undefined;
  try {
    host = await startHost({ config: { stateDir, keyFile, projects: [{ id: "shop-api", name: "Shop API", path: shop }] } });
    for (const path of ["/permissions/log", "/permissions/decisions/rejected", "/permissions/candidates"]) {
      assert.equal((await host.fetchApi(path, "controller")).status, 403, path);
      assert.equal((await host.fetchApi(path, "viewer")).status, 403, path);
      assert.equal((await host.fetchApi(path, null)).status, 401, path);
    }
    const status = await host.fetchApi("/permissions/status", "controller");
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.deepEqual(status.body.rateFlags.map((flag: { sessionId: string; lastHour: number; threshold: number }) => [flag.sessionId, flag.lastHour, flag.threshold]),
      [["busy-session", 21, 20]]);
    assert.doesNotMatch(JSON.stringify(status.body), /only the owner reads/);

    const rejected = await host.fetchApi("/permissions/log?rejected=1", "owner");
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.deepEqual(rejected.body.entries.map((entry: { id: string }) => entry.id), ["rejected"]);
    const entry = rejected.body.entries[0];
    assert.deepEqual([entry.note, entry.workspaceName, entry.projectName, entry.rejectState, entry.durationMs], [modelNote, "Shop API", "Shop API", "open", 3_000]);
    assert.deepEqual(entry.deliveries.map((event: { kind: string }) => event.kind), ["intent"]);
    assert.deepEqual((await host.fetchApi("/permissions/log?raised=1", "owner")).body.entries.map((row: { id: string }) => row.id), ["rejected"]);
    assert.deepEqual((await host.fetchApi(`/permissions/log?since=${encodeURIComponent(ago(45 * 60_000))}&workspace=other`, "owner")).body.entries, []);
    const ids: string[] = [];
    let next: string | undefined;
    do {
      const page = await host.fetchApi(`/permissions/log?limit=10${next ? `&before=${next}` : ""}`, "owner");
      assert.equal(page.status, 200, JSON.stringify(page.body));
      ids.push(...page.body.entries.map((row: { id: string; sessionId: string; rateFlagged?: boolean }) => {
        assert.equal(row.rateFlagged === true, row.sessionId === "busy-session", row.id);
        return row.id;
      }));
      next = page.body.next;
    } while (next);
    assert.equal(ids.length, 23);
    assert.equal(new Set(ids).size, 23);
    for (const query of ["limit=0", "limit=201", "rejected=yes", "since=yesterday", "before=1", "extra=1"])
      assert.equal((await host.fetchApi(`/permissions/log?${query}`, "owner")).status, 400, query);

    const mark = { requestId: randomUUID(), decisionId: "rejected", label: "wrong", note: "The build directory is the session's own." };
    assert.equal((await host.fetchApi("/permissions/marks", "controller", mark)).status, 403);
    assert.equal((await host.fetchApi("/permissions/marks", "viewer", mark)).status, 403);
    const login = await fetch(`${host.origin}/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: host.origin }, body: JSON.stringify({ token: host.tokens.owner }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const browser = await fetch(`${host.origin}/api/permissions/marks`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: host.origin }, body: JSON.stringify(mark),
    });
    assert.equal(browser.status, 403, "an owner browser session without the CLI bearer cannot mark");
    const browserLog = await fetch(`${host.origin}/api/permissions/log`, { headers: { Cookie: cookie } });
    assert.equal(browserLog.status, 200, "the owner's browser session reads the log");

    const first = await host.fetchApi("/permissions/marks", "owner", mark);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual([first.body.mark.decisionId, first.body.mark.label, first.body.mark.note], ["rejected", "wrong", mark.note]);
    assert.deepEqual((await host.fetchApi("/permissions/marks", "owner", mark)).body, first.body, "a replayed request id returns the first result");
    assert.equal((await host.fetchApi("/permissions/marks", "owner", { ...mark, note: "Another note." })).status, 409);
    assert.equal((await host.fetchApi("/permissions/marks", "owner", { ...mark, requestId: randomUUID(), decisionId: "missing" })).status, 404);
    assert.equal((await host.fetchApi("/permissions/marks", "owner", { ...mark, requestId: randomUUID(), note: " " })).status, 400);
    const second = await host.fetchApi("/permissions/marks", "owner", { ...mark, requestId: randomUUID(), note: "Still wrong." });
    assert.equal(second.status, 200, JSON.stringify(second.body));

    const marked = await host.fetchApi("/permissions/decisions/rejected", "owner");
    assert.deepEqual([marked.body.entry.verdict, marked.body.entry.code, marked.body.entry.rejectState], ["reject", "unsafe", "open"]);
    assert.deepEqual(marked.body.entry.marks.map((row: { note: string }) => row.note), [mark.note, "Still wrong."]);
    assert.equal((await host.fetchApi("/permissions/decisions/missing", "owner")).status, 404);
    const candidates = await host.fetchApi("/permissions/candidates", "owner");
    assert.deepEqual(candidates.body.candidates.map((candidate: { decisionId: string; label: string; sources: string[] }) => [candidate.decisionId, candidate.label, candidate.sources]),
      [["rejected", "should-allow", ["marked-wrong"]]]);
    assert.doesNotMatch(JSON.stringify(candidates.body), /only the owner reads/, "a candidate carries no model note");

    const clientFile = join(root, "client.json");
    writeFileSync(clientFile, JSON.stringify({ origin: host.origin, token: host.tokens.owner }), { mode: 0o600 });
    const cli = [import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", clientFile];
    const permissions = (...args: string[]) => promisify(execFile)(process.execPath, ["--import", ...cli, "permissions", ...args]);
    const log = await permissions("log", "--rejected", "--since", "2h");
    assert.match(log.stdout, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z {2}reject unsafe · open {2}Shop API \/ Shop API$/m);
    assert.match(log.stdout, /^ {2}Note \(owner only\): Reasoning that only the owner reads\.$/m);
    assert.match(log.stdout, /^ {2}Marked wrong: .*: Still wrong\.$/m);
    assert.match(log.stdout, /^Above usual rate: session busy-session in shop-api, 21 decisions in the last hour \(flagged above 20\)$/m);
    const marking = await permissions("mark", "allowed", "--wrong", "--note", "Should not have run.");
    assert.match(marking.stdout, /^Marked allowed wrong at /m);
    assert.match(marking.stdout, /A mark is a record only and changes no decision\./);
    await assert.rejects(permissions("mark", "allowed", "--note", "No label."), (error: { stderr: string }) => /Usage: infinite permissions mark/.test(error.stderr));
    await assert.rejects(permissions("log", "--since", "yesterday"), (error: { stderr: string }) => /--since needs a time/.test(error.stderr));
    assert.deepEqual((await host.fetchApi("/permissions/candidates", "owner")).body.candidates.map((candidate: { decisionId: string; label: string }) => [candidate.decisionId, candidate.label]),
      [["allowed", "should-reject"], ["rejected", "should-allow"]]);
  } finally {
    if (host) await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

async function onboardingHost(prefix: string, projectIds: string[]) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const projects = projectIds.map(id => {
    const path = join(root, id);
    mkdirSync(path, { mode: 0o700 });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: path, stdio: "ignore" });
    git("init", "--initial-branch=main");
    git("remote", "add", "origin", `https://github.com/example/${id}.git`);
    writeFileSync(join(path, "tracked.txt"), `${id}\n`);
    git("add", "tracked.txt");
    git("-c", "user.name=Example", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-m", "Initial fixture");
    return { id, name: id, path };
  });
  const host = await startHost({ config: { projects, teams: { workspaceDir: join(root, "team-workspaces") } } });
  const body = (revision: number, options: { policy?: boolean; optOut?: boolean } = {}) => ({
    requestId: randomUUID(), revision,
    team: { checks: [{ command: "git", args: ["status", "--short"] }], handoff: "auto",
      ...(options.policy ? { permissions: { mode: "coordinator", scope: "Run the repository's checks.", maxDecisions: 5 } } : {}) },
    ...(options.optOut ? { permissionOptOut: true } : {}),
  });
  const onboard = (projectId: string, request: ReturnType<typeof body>) => host.fetchApi(`/projects/${projectId}/team`, "owner", request, {}, "PUT");
  const entry = async (projectId: string) => {
    const status = await host.fetchApi("/permissions/status", "owner");
    assert.equal(status.status, 200, JSON.stringify(status.body));
    const found = (status.body.workspaces as View[]).flatMap(view => view.projects).find(project => project.projectId === projectId);
    return found && { state: found.state, ...(found.act ? { act: found.act } : {}) };
  };
  const workspace = async (projectId: string) => (await host.fetchApi(`/project-groups/${projectId}`, "owner")).body.id as string;
  const close = async () => { await host.stop(); rmSync(root, { recursive: true, force: true }); };
  return { host, body, onboard, entry, workspace, close };
}

test("owner onboarding covers a project the first time only, and an off records an opt-out that only a delegation replaces", { timeout: 120000 }, async () => {
  const f = await onboardingHost("permissions-onboarding-", ["first", "older-client", "explicit-off"]);
  try {
    assert.equal((await f.host.fetchApi("/me", "owner")).body.permissions.onboardingCoverage, 1);

    const firstRequest = f.body(0, { policy: true });
    const covered = await f.onboard("first", firstRequest);
    assert.equal(covered.status, 200, JSON.stringify(covered.body));
    assert.equal(covered.body.revision, 1);
    assert.deepEqual(covered.body.permissionAgent, { coverage: "covered", workspaceId: await f.workspace("first") });
    assert.deepEqual(await f.entry("first"), { state: "covered", act: "onboarding" });
    assert.deepEqual((await f.onboard("first", firstRequest)).body.permissionAgent, covered.body.permissionAgent);
    assert.deepEqual((await f.onboard("first", f.body(1, { policy: true }))).body.permissionAgent, { coverage: "unchanged" });
    assert.deepEqual(await f.entry("first"), { state: "covered", act: "onboarding" });

    const older = await f.onboard("older-client", f.body(0));
    assert.equal(older.status, 200, JSON.stringify(older.body));
    assert.deepEqual(older.body.permissionAgent, { coverage: "opt-out" });
    assert.deepEqual(await f.entry("older-client"), { state: "opt-out" });
    const delegated = await f.host.fetchApi("/permissions/delegations", "owner", { requestId: randomUUID(), workspaceId: await f.workspace("older-client") });
    assert.equal(delegated.status, 200, JSON.stringify(delegated.body));
    assert.deepEqual(delegated.body.replacedOptOuts, ["older-client"]);
    assert.deepEqual(await f.entry("older-client"), { state: "covered", act: "delegate" });
    const repeatOff = await f.onboard("older-client", f.body(1, { optOut: true }));
    assert.equal(repeatOff.status, 200, JSON.stringify(repeatOff.body));
    assert.equal(repeatOff.body.revision, 2);
    assert.deepEqual(repeatOff.body.permissionAgent, { coverage: "opt-out" });
    assert.deepEqual(await f.entry("older-client"), { state: "opt-out" });

    assert.equal((await f.onboard("explicit-off", f.body(0, { optOut: true, policy: true }))).status, 400);
    assert.deepEqual(await f.entry("explicit-off"), { state: "not-covered" });
    const off = await f.onboard("explicit-off", f.body(0, { optOut: true }));
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.revision, 1);
    assert.deepEqual(off.body.permissionAgent, { coverage: "opt-out" });
    assert.deepEqual(await f.entry("explicit-off"), { state: "opt-out" });
  } finally { await f.close(); }
});

test("onboarding never covers a project that was enrolled without a delegation record, and an unopened record fails only an explicit off", { timeout: 120000 }, async () => {
  const f = await onboardingHost("permissions-onboarding-legacy-", ["legacy", "recovered", "refused"]);
  try {
    const delegationFile = join(f.host.config.stateDir, "permission-delegations", "state.sealed");
    await f.host.stopApi();
    writeFileSync(delegationFile, "not a sealed state\n", { mode: 0o600 });
    await f.host.start();

    const legacyFirst = f.body(0, { policy: true });
    const recoveredFirst = f.body(0, { policy: true });
    for (const [projectId, request] of [["legacy", legacyFirst], ["recovered", recoveredFirst]] as const) {
      const saved = await f.onboard(projectId, request);
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.revision, 1);
      assert.deepEqual(saved.body.permissionAgent, { coverage: "unavailable", reason: "Permission delegation is unavailable on this host." });
    }
    assert.equal((await f.onboard("refused", f.body(0, { optOut: true }))).status, 503);
    assert.equal((await f.host.fetchApi("/projects/refused/team", "owner")).body.revision, 0);

    await f.host.stopApi();
    rmSync(delegationFile);
    const key = readFileSync(f.host.config.keyFile);
    const enrollments = join(f.host.config.stateDir, "repo-enrollments.sealed");
    const stored = unseal<{ requests: Record<string, { created?: true }> }>(key, "repo-enrollments", readFileSync(enrollments, "utf8"));
    assert.equal(stored.requests[legacyFirst.requestId]?.created, true);
    delete stored.requests[legacyFirst.requestId]!.created;
    writeSealed(enrollments, key, "repo-enrollments", stored);
    await f.host.start();

    const recovered = await f.onboard("recovered", recoveredFirst);
    assert.equal(recovered.body.revision, 1);
    assert.deepEqual(recovered.body.permissionAgent, { coverage: "covered", workspaceId: await f.workspace("recovered") });
    const replayed = await f.onboard("legacy", legacyFirst);
    assert.equal(replayed.body.revision, 1);
    assert.deepEqual(replayed.body.permissionAgent, { coverage: "unchanged" });
    const repeat = await f.onboard("legacy", f.body(1, { policy: true }));
    assert.equal(repeat.status, 200, JSON.stringify(repeat.body));
    assert.equal(repeat.body.revision, 2);
    assert.deepEqual(repeat.body.permissionAgent, { coverage: "unchanged" });
    assert.deepEqual(await f.entry("legacy"), { state: "not-covered" });
  } finally { await f.close(); }
});
