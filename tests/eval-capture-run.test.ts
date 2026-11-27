import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, git, limitLineup } from "./team-fixture.js";
import { waitFor } from "./helpers.js";
import type { ProjectSourceService, ProjectSourceStatus } from "../packages/host/src/project-source.js";
import { TaskCapture } from "../packages/host/src/eval-capture.js";
import { capturedTaskId, readMaterial, runEvalTasks } from "../packages/host/src/eval-store.js";
import type { CapturedPayload, CaptureSink, EvalTaskRow } from "../packages/host/src/eval-types.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { EventOutbox } from "../packages/host/src/evidence/outbox.js";
import { outcomeProjector } from "../packages/host/src/outcome-projector.js";
import { outcomeModule } from "../packages/host/src/outcome-store.js";
import { configurationModule, configurationProjector } from "../packages/host/src/configuration-store.js";

function drain(outbox: EventOutbox): void {
  for (let pass = 0; pass < 20; pass++) if (!outbox.advance().pending) return;
}

test("a fixture run captures its accepted task, and deleting it as cancelled removes it", { timeout: 240000 }, async () => {
  const f = await fixture("rubric", limitLineup, {}, { noServer: true });
  try {
    const mirror = join(f.host.root, "source-mirror.git");
    git(f.source, "clone", "--bare", f.source, mirror);
    const status: ProjectSourceStatus = { mode: "github", repository: "example/app", baseBranch: "main", mirrorHead: f.base };
    const source: Pick<ProjectSourceService, "refresh" | "mirrorPath" | "isGithub" | "status"> = {
      refresh: async () => status,
      mirrorPath: () => mirror,
      isGithub: projectId => projectId === "rehearsal",
      status: () => status,
    };
    const project = f.host.config.projects.find(item => item.id === "rehearsal")!;
    project.team = { ...project.team, eval: { capture: true } };

    const store = new EvidenceStore({ databasePath: evidenceDatabasePath(f.host.config.stateDir), vaultKey: readFileSync(f.host.config.keyFile) });
    store.register(configurationModule());
    store.register(outcomeModule());
    const outbox = new EventOutbox(store);
    outbox.registerProjector(configurationProjector());
    outbox.registerProjector(outcomeProjector(store));
    const capture = new TaskCapture({ config: f.host.config, store, source });
    const teams = await f.openTeamService({ source, events: outbox, capture });
    const created = await teams.create(f.create());
    const run = await waitFor(() => Promise.resolve(teams.get(created.id)), current => ["ready-for-review", "merged", "blocked"].includes(current.status), 180000);
    assert.equal(run.status, "ready-for-review", JSON.stringify(run.events.slice(-5)));
    await capture.idle();
    drain(outbox);
    capture.reconcile();

    const rows = (): EvalTaskRow[] => store.read(db => runEvalTasks(db, run.id));
    const memberA = run.members.find(member => member.taskId === "a")!;
    const memberB = run.members.find(member => member.taskId === "b")!;
    const rowA = rows().find(row => row.taskId === capturedTaskId(run.id, memberA.memberId))!;
    assert.equal(rowA.state, "candidate");
    assert.equal(rowA.reason, null);
    assert.equal(rowA.material, "stored");
    assert.equal(rowA.approval, "read");
    assert.equal(rowA.base, "proven");
    const partsA = store.read(db => readMaterial(db, rowA.taskId));
    const payloadA = rowA.payload as CapturedPayload;
    assert.deepEqual(payloadA.files, ["a.txt", "docs/x.md", "tests/y.test.ts"]);
    assert.deepEqual(payloadA.hiddenFiles, ["tests/y.test.ts"]);
    assert.equal(partsA.capsule?.task.id, "a");
    assert.equal(partsA.capsule?.objective, f.create().objective);
    assert.match(partsA.reference?.toString("utf8") ?? "", /diff --git a\/tests\/y\.test\.ts b\/tests\/y\.test\.ts/);
    assert.equal(payloadA.baseDelta === "none", memberA.baseCommit === run.baseCommit);

    const rowB = rows().find(row => row.taskId === capturedTaskId(run.id, memberB.memberId))!;
    assert.equal(rowB.state, "rejected");
    assert.equal(rowB.reason, "no-hidden-tests");
    const partsB = store.read(db => readMaterial(db, rowB.taskId));
    assert.equal(partsB.capsule, undefined);
    assert.equal(partsB.reference, undefined);
    assert.equal(partsB.baseDelta, undefined);

    const { checkedAt: _checkedBefore, ...stableBefore } = rowA;
    const aside = `${run.workspace}.aside`;
    renameSync(run.workspace, aside);
    try { capture.reconcile(); } finally { renameSync(aside, run.workspace); }
    const after = rows().find(row => row.taskId === rowA.taskId)!;
    const { checkedAt: _checkedAfter, ...stableAfter } = after;
    assert.deepEqual(stableAfter, stableBefore);
    assert.deepEqual(store.read(db => readMaterial(db, rowA.taskId)), partsA);

    const cancelled = await teams.cancel(run.id, { requestId: "11111111-1111-4111-8111-111111111111", revision: run.revision });
    assert.equal(cancelled.status, "cancelled");
    await teams.removeRun(run.id);
    drain(outbox);
    store.sweep(id => teams.hasRecordFile(id));
    assert.deepEqual(rows(), []);
    assert.deepEqual(store.read(db => readMaterial(db, rowA.taskId)), {});
    store.close();
  } finally { await f.close(); }
});

test("a failing capture never changes the run", { timeout: 240000 }, async () => {
  const f = await fixture("rubric", limitLineup, {}, { noServer: true });
  try {
    const sink: CaptureSink = {
      enabled: () => true,
      integrated() { throw new Error("The capture sink failed."); },
      approved() { throw new Error("The capture sink failed."); },
    };
    const teams = await f.openTeamService({ capture: sink });
    const created = await teams.create(f.create());
    const run = await waitFor(() => Promise.resolve(teams.get(created.id)), current => ["ready-for-review", "merged", "blocked"].includes(current.status), 180000);
    assert.equal(run.status, "ready-for-review", JSON.stringify(run.events.slice(-5)));
    assert.deepEqual(run.tasks.map(task => [task.id, task.status]), [["a", "integrated"], ["b", "integrated"]]);
    assert.equal(run.events.some(event => /capture|eval/i.test(event.text)), false);
  } finally { await f.close(); }
});
