import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { outcomeModule } from "../packages/host/src/outcome-store.js";
import { ROUTING_DEFAULTS } from "../packages/host/src/routing-policy.js";
import { decisionKey, insertDecision, routingModule } from "../packages/host/src/routing-store.js";
import type { DecisionRow, RoutingPayload } from "../packages/host/src/routing-types.js";
import { startHost, type Host } from "./helpers.js";

/** One stored start decision of a run's task, written while the host's API is stopped. */
function seedDecision(host: Host, runId: string, taskId: string): void {
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(host.config.stateDir), vaultKey: readFileSync(host.config.keyFile) });
  try {
    store.register(configurationModule());
    store.register(outcomeModule());
    store.register(routingModule());
    const payload: RoutingPayload = {
      projectId: "rehearsal", taskId, area: "host", featureMap: "default", coordinatorProfileId: "astra-xhigh", knobs: ROUTING_DEFAULTS,
      costs: { lightUsd: 0.4, strongUsd: 2.2, rescueUsd: 1.5, basis: "tier-default" }, headroom: "not-modelled", chosenWeight: 0.5,
      current: [], candidates: [], elapsedMs: 1,
    };
    store.write(tx => {
      const row: DecisionRow = {
        key: decisionKey(runId, 1, tx.index("task", taskId), "start", 1), runId, revision: 1, taskKey: tx.index("task", taskId),
        point: "start", ordinal: 1, projectRef: tx.index("project", "rehearsal"), role: "implementer", areaRef: tx.index("area", "host"),
        kind: "feature", risk: "normal", featureVersion: 1, featureMapRef: tx.index("feature-map", "default"), mode: "shadow",
        algorithmVersion: 1, rewardVersion: 1, policyDigest: "d".repeat(64), seed: "s".repeat(64), basis: "single-candidate",
        chosenProfileId: "astra-xhigh", chosenIdentity: "i".repeat(64), greedyProfileId: "astra-xhigh",
        coordinatorProfileId: "astra-xhigh", explore: false, state: "recorded", memberId: null,
        decidedAt: new Date().toISOString(),
      };
      insertDecision(tx, row, payload);
    });
  } finally {
    store.close();
  }
}

test("routing reads answer every paired role on a real host", { timeout: 60000 }, async () => {
  const host = await startHost();
  const runId = randomUUID();
  try {
    // The API holds the evidence file open, so the decision is written while it is stopped, then the API starts again.
    await host.stopApi();
    seedDecision(host, runId, "task-one");
    await host.start();

    for (const role of ["owner", "controller", "viewer"] as const) {
      const project = await host.fetchApi("/routing/projects/rehearsal", role);
      assert.equal(project.status, 200, `project status for ${role}`);
      assert.equal(project.body.projectId, "rehearsal");
      // Off without a saved policy in a supervised project; the history of shadow decisions still counts.
      assert.equal(project.body.mode, "off");
      assert.equal(project.body.shadow.decisions, 1);
      const explain = await host.fetchApi(`/teams/${runId}/routing/task-one`, role);
      assert.equal(explain.status, 200, `explain for ${role}`);
      assert.equal(explain.body.decisions.length, 1);
      assert.equal(explain.body.decisions[0].payload.taskId, "task-one");
      assert.equal("taskKey" in explain.body.decisions[0], false);
    }

    const unknownProject = await host.fetchApi("/routing/projects/missing", "owner");
    assert.equal(unknownProject.status, 404);
    assert.equal(unknownProject.body.code, "unknown-project");
    const unknownTask = await host.fetchApi(`/teams/${runId}/routing/task-two`, "owner");
    assert.equal(unknownTask.status, 404);
    assert.equal(unknownTask.body.code, "routing-decision-not-found");
    const badTask = await host.fetchApi(`/teams/${runId}/routing/A_B`, "owner");
    assert.equal(badTask.status, 400);
    const badRun = await host.fetchApi("/teams/not-a-uuid/routing/task-one", "owner");
    assert.equal(badRun.status, 400);
    const anonymous = await host.fetchApi("/routing/projects/rehearsal", null);
    assert.equal(anonymous.status, 401);

    // The evidence directory replaced by a file: the store is unavailable and both routes answer 503.
    await host.stopApi();
    rmSync(join(host.config.stateDir, "evidence"), { recursive: true, force: true });
    writeFileSync(join(host.config.stateDir, "evidence"), "not a directory");
    await host.start();
    const projectDown = await host.fetchApi("/routing/projects/rehearsal", "owner");
    assert.equal(projectDown.status, 503);
    assert.equal(projectDown.body.code, "evidence-unavailable");
    const explainDown = await host.fetchApi(`/teams/${runId}/routing/task-one`, "owner");
    assert.equal(explainDown.status, 503);
    assert.equal(explainDown.body.code, "evidence-unavailable");
  } finally {
    await host.stop();
  }
});
