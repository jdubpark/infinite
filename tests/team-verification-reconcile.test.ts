import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { waitFor } from "./helpers.js";
import { fixture } from "./team-fixture.js";

test("an interrupted setup check can be attested and rerun at the same head", { timeout: 90000 }, async () => {
  const f = await fixture("lifecycle");
  let checkPid: number | undefined;
  let dirtyPath: string | undefined;
  try {
    const project = f.host.config.projects.find(item => item.id === "rehearsal")!;
    const holdSetup = `const { spawnSync } = require("node:child_process"); if (process.cwd().includes("/verification/")) { const result = spawnSync(process.execPath, [${JSON.stringify(join(process.cwd(), "tests/fixtures/team-agent.mjs"))}, "--hold-check", ${JSON.stringify(f.receipts)}], { stdio: "inherit" }); process.exit(result.status ?? 1); }`;
    project.team!.setup = { command: process.execPath, args: ["-e", holdSetup] };
    await f.host.stopApi();
    writeFileSync(join(f.host.root, "config.json"), JSON.stringify(f.host.config));
    await f.host.start();
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const id = created.body.id as string;
    const checking = await waitFor(() => f.get(id), run => run.status === "verifying" && run.checks.some(check => check.status === "running") && existsSync(join(f.receipts, "check-ready.json")), 30000);
    checkPid = JSON.parse((await import("node:fs")).readFileSync(join(f.receipts, "check-ready.json"), "utf8")).pid;
    assert.ok(checkPid && checkPid > 1);

    await f.host.stopApi();
    await f.host.start();
    const blocked = await f.get(id);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.pendingOperation?.kind, "check");
    const interrupted = blocked.checks.filter(check => check.revision === blocked.revision && check.round === blocked.round);
    assert.equal(interrupted.at(-1)?.status, "interrupted");

    const resume = await f.host.fetchApi(`/teams/${id}/resume`, "owner", { requestId: randomUUID(), revision: blocked.revision });
    assert.equal(resume.status, 409);
    assert.equal(resume.body.code, "team-reconciliation-required");

    try { process.kill(-checkPid, "SIGKILL"); } catch { /* The fixture may use a different process group leader. */ }
    try { process.kill(checkPid, "SIGKILL"); } catch { /* The old check process may already have exited. */ }
    await waitFor(() => {
      try {
        const stat = readFileSync(`/proc/${checkPid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
      }
      catch { return true; }
    }, Boolean, 10000);
    // The fixture's fresh check may use this release; the interrupted attempt remains sealed.
    writeFileSync(join(f.receipts, "check-release"), "release\n");

    const pendingId = blocked.pendingOperation!.id;
    const head = blocked.headCommit!;
    const requestId = randomUUID();
    const body = (overrides: Record<string, unknown> = {}) => ({ requestId, revision: blocked.revision, pendingId, headCommit: head,
      attestation: { boundary: "check-only", processesStopped: true, text: "Confirmed the interrupted check process and team workspace are quiescent." }, ...overrides });
    const refuse = async (candidate: unknown, code: string) => {
      const response = await f.host.fetchApi(`/teams/${id}/reconcile-verification`, "owner", candidate);
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.equal(response.body.code, code);
    };
    await refuse(body({ revision: blocked.revision + 1 }), "stale-team-revision");
    await refuse(body({ pendingId: randomUUID() }), "verification-reconciliation-operation-changed");
    await refuse(body({ headCommit: "0".repeat(40) }), "verification-reconciliation-head-changed");
    dirtyPath = join(blocked.workspace, "reconcile-dirty.txt");
    writeFileSync(dirtyPath, "dirty\n");
    await refuse(body(), "integration-changed-files");
    (await import("node:fs")).rmSync(dirtyPath, { force: true });
    dirtyPath = undefined;

    const before = { id: blocked.id, revision: blocked.revision, objective: blocked.objective, headCommit: blocked.headCommit,
      tasks: structuredClone(blocked.tasks), memberIds: new Set(blocked.members.map(member => member.memberId)) };
    const reconciled = await f.host.fetchApi(`/teams/${id}/reconcile-verification`, "owner", body());
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
    for (const key of ["id", "revision", "objective", "headCommit"] as const) assert.equal(reconciled.body[key], before[key]);
    assert.deepEqual(reconciled.body.tasks, before.tasks);
    assert.equal(reconciled.body.checks.filter((check: any) => check.revision === blocked.revision).at(-1)?.status, "interrupted");
    assert.equal(reconciled.body.verificationReconciliations.length, 1);

    const finished = await f.settled(id);
    assert.equal(finished.status, "ready-for-review", JSON.stringify(finished));
    assert.equal(finished.review?.revision, blocked.revision);
    assert.ok(finished.checks.some(check => check.revision === blocked.revision && check.headCommit === head && check.status === "passed"));
    const addedMembers = finished.members.filter(member => !before.memberIds.has(member.memberId));
    assert.equal(addedMembers.length, 1);
    assert.equal(addedMembers[0]?.role, "reviewer");
    assert.equal(finished.verificationReconciliations?.length, 1);

    const replay = await f.host.fetchApi(`/teams/${id}/reconcile-verification`, "owner", body());
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.verificationReconciliations.length, 1);
    await refuse(body({ attestation: { boundary: "check-only", processesStopped: true, text: "A different operator statement." } }), "request-conflict");
  } finally {
    if (dirtyPath) (await import("node:fs")).rmSync(dirtyPath, { force: true });
    if (checkPid) { try { process.kill(-checkPid, "SIGKILL"); } catch { /* Already exited. */ } }
    await f.close();
  }
});
