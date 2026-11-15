import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { outcomeModule } from "../packages/host/src/outcome-store.js";
import { pinRouting } from "../packages/host/src/routing-policy.js";
import { RoutingRecorder } from "../packages/host/src/routing-recorder.js";
import { routingRoutes } from "../packages/host/src/routing-routes.js";
import { routingModule } from "../packages/host/src/routing-store.js";
import type { TeamRun, TeamTask } from "../packages/host/src/team-types.js";
import type { Config } from "../packages/host/src/types.js";
import { mixedLineup } from "./team-fixture.js";

const NOW = "2026-11-15T12:00:00.000Z";
const ROLES = ["owner", "controller", "viewer"];

function open(databasePath: string, key: Buffer): EvidenceStore {
  const store = new EvidenceStore({ databasePath, vaultKey: key });
  store.register(configurationModule());
  store.register(outcomeModule({ now: () => NOW }));
  store.register(routingModule());
  return store;
}

/** An app that answers the guard by the `x-role` header, as the host's requireRole does by the paired device's role. */
function appOn(evidence: EvidenceStore, config: Config): express.Express {
  const app = express();
  const guard: express.RequestHandler = (req, res, next) =>
    ROLES.includes(String(req.headers["x-role"])) ? next() : void res.status(403).json({ code: "forbidden" });
  routingRoutes(app, { evidence, config: () => config }, guard);
  return app;
}

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test("routing reads answer every paired role", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-routing-routes-"));
  const key = randomBytes(32);
  let store: EvidenceStore | undefined, broken: EvidenceStore | undefined;
  let served: { url: string; close: () => Promise<void> } | undefined, brokenServed: { url: string; close: () => Promise<void> } | undefined;
  try {
    store = open(evidenceDatabasePath(join(root, "state")), key);
    const config = {
      projects: [{ id: "rehearsal", autonomy: "autonomous", team: {} }],
      teams: { lineup: mixedLineup, publishHeads: true },
    } as unknown as Config;

    // A decision for one task of a run, recorded by the recorder itself.
    const routing = pinRouting(undefined, "autonomous", mixedLineup);
    assert.ok(routing);
    const runId = randomUUID();
    const run = { id: runId, revision: 1, projectId: "rehearsal", lineup: mixedLineup, routing } as unknown as TeamRun;
    const task = { id: "task-one", title: "t", instructions: "do it", paths: ["packages/host/src/a.ts"], dependsOn: [], revision: 1, status: "pending", agentProfileId: "astra-xhigh" } as unknown as TeamTask;
    new RoutingRecorder({ store, now: () => NOW, log: () => {} }).recordStart({ run, task, publishHeads: true, entryTools: false, featureMap: undefined, limited: new Set() });

    served = await listen(appOn(store, config));
    for (const role of ROLES) {
      const project = await fetch(`${served.url}/api/routing/projects/rehearsal`, { headers: { "x-role": role } });
      assert.equal(project.status, 200, `project status for ${role}`);
      const body = await project.json() as { mode: string; shadow: { decisions: number } };
      assert.equal(body.mode, "shadow");
      assert.equal(body.shadow.decisions, 1);
      const explain = await fetch(`${served.url}/api/teams/${runId}/routing/task-one`, { headers: { "x-role": role } });
      assert.equal(explain.status, 200, `explain for ${role}`);
    }
    const none = await fetch(`${served.url}/api/routing/projects/missing`, { headers: { "x-role": "owner" } });
    assert.equal(none.status, 404);
    assert.equal((await none.json() as { code: string }).code, "unknown-project");
    const unknownTask = await fetch(`${served.url}/api/teams/${runId}/routing/task-two`, { headers: { "x-role": "owner" } });
    assert.equal(unknownTask.status, 404);
    assert.equal((await unknownTask.json() as { code: string }).code, "routing-decision-not-found");
    const badTask = await fetch(`${served.url}/api/teams/${runId}/routing/A_B`, { headers: { "x-role": "owner" } });
    assert.equal(badTask.status, 400);
    const badRun = await fetch(`${served.url}/api/teams/not-a-uuid/routing/task-one`, { headers: { "x-role": "owner" } });
    assert.equal(badRun.status, 400);
    const denied = await fetch(`${served.url}/api/routing/projects/rehearsal`, { headers: { "x-role": "remote" } });
    assert.equal(denied.status, 403);

    // The evidence directory replaced by a file: the store is unavailable and both routes answer 503.
    mkdirSync(join(root, "broken"), { recursive: true });
    writeFileSync(join(root, "broken", "evidence"), "not a directory");
    broken = open(evidenceDatabasePath(join(root, "broken")), key);
    brokenServed = await listen(appOn(broken, config));
    const projectDown = await fetch(`${brokenServed.url}/api/routing/projects/rehearsal`, { headers: { "x-role": "owner" } });
    assert.equal(projectDown.status, 503);
    assert.equal((await projectDown.json() as { code: string }).code, "evidence-unavailable");
    const explainDown = await fetch(`${brokenServed.url}/api/teams/${runId}/routing/task-one`, { headers: { "x-role": "owner" } });
    assert.equal(explainDown.status, 503);
    assert.equal((await explainDown.json() as { code: string }).code, "evidence-unavailable");
  } finally {
    await served?.close();
    await brokenServed?.close();
    store?.close();
    broken?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
