import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteClient, RemoteError } from "@infinite/remote";
import { Blackboard } from "../packages/host/src/evidence/blackboard.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { hostEntryIds, hostEntryRun } from "./fixtures/host-entry-run.js";
import { httpRunner } from "./remote-fixture.js";

test("blackboard entry heads expose authorMemberId and headCommit for reports, integrations, and checks", () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-head-links-"));
  try {
    const store = new EvidenceStore({
      databasePath: evidenceDatabasePath(join(root, "state")),
      vaultKey: randomBytes(32),
    });
    const board = new Blackboard(store);
    const run = hostEntryRun();
    run.checks[0] = { ...run.checks[0]!, headCommit: "abcdef0123456789abcdef0123456789abcdef01", round: 1 };
    assert.equal(board.mirror(run), true);

    const entries = board.list(run.id, {}).entries;
    const integration = entries.find(entry => entry.kind === "integration");
    const report = entries.find(entry => entry.kind === "report" && entry.authorRole === "implementer");
    const check = entries.find(entry => entry.kind === "check");

    assert.ok(integration);
    assert.equal(integration.authorMemberId, hostEntryIds.implA);
    assert.equal(integration.headCommit, run.tasks[0]!.commit);
    const integrationDetail = board.get(run.id, integration.entryId);
    assert.equal((integrationDetail?.body as { memberId?: string })?.memberId, hostEntryIds.implA);

    assert.ok(report);
    assert.equal(report.authorMemberId, hostEntryIds.implA);
    assert.equal(report.headCommit, run.members.find(member => member.memberId === hostEntryIds.implA)?.baseCommit);

    assert.ok(check);
    assert.equal(check.headCommit, "abcdef0123456789abcdef0123456789abcdef01");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote access admits team entries, context-usage, and mission progress routes", { timeout: 30000 }, async () => {
  const runner = await httpRunner();
  const client = createRemoteClient({ url: runner.url, token: runner.token });
  try {
    const teamId = randomUUID();
    const entryId = randomUUID();
    const missionId = randomUUID();

    const list = await client.request<{ path: string }>(`/teams/${teamId}/entries?limit=20`);
    const detail = await client.request<{ path: string }>(`/teams/${teamId}/entries/${entryId}`);
    const withdraw = await client.request<{ path: string }>(`/teams/${teamId}/entries/${entryId}/withdraw`, { method: "POST", body: { requestId: randomUUID() } });
    const usage = await client.request<{ path: string }>(`/teams/${teamId}/context-usage`);
    const progress = await client.request<{ path: string }>(`/missions/${missionId}/progress?cursor=abc`);

    assert.deepEqual(
      [list.path, detail.path, withdraw.path, usage.path, progress.path],
      [
        `/api/teams/${teamId}/entries?limit=20`,
        `/api/teams/${teamId}/entries/${entryId}`,
        `/api/teams/${teamId}/entries/${entryId}/withdraw`,
        `/api/teams/${teamId}/context-usage`,
        `/api/missions/${missionId}/progress?cursor=abc`,
      ],
    );

    await assert.rejects(
      client.request(`/teams/${teamId}/entries/not-a-uuid`),
      (error: RemoteError) => error.status === 403 && error.code === "remote-endpoint-denied",
    );
    await assert.rejects(
      client.request(`/missions/${missionId}/progress`, { method: "POST", body: {} }),
      (error: RemoteError) => error.status === 403 && error.code === "remote-endpoint-denied",
    );
  } finally {
    client.close();
    await runner.close();
  }
});
