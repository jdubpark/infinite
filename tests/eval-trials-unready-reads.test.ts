import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { Config } from "../packages/host/src/types.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import { EvalHost } from "../packages/host/src/eval-host.js";
import { EVAL_TRIALS_MODULE, evalTrialsModule } from "../packages/host/src/eval-trial-store.js";

// Reads and controls of a trial job need the trials module. The host answers 503 evidence-unavailable while it is not ready.

const PROJECT = "project-unready-1";
const CLAUDE: TeamModelProfile = { id: "claude-strong", label: "Claude strong", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" };
const LINEUP = { coordinator: CLAUDE, integrator: CLAUDE, reviewer: CLAUDE, implementers: [CLAUDE], escalations: [], fallbacks: [] };
const FOCUSED = { command: "node", args: ["--test", "--test-reporter=junit", "--test-reporter-destination={report}", "{files}"] };
const dirs: string[] = [];

test.after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function configFor(root: string): Config {
  return {
    projects: [{ id: PROJECT, name: PROJECT, path: "/srv/unused",
      source: { mode: "github", repository: "example/app" },
      team: { eval: { mine: true, focusedTest: FOCUSED, reportFormat: "junit", trialsPerDay: 100 } } }],
    stateDir: join(root, "state"), runDir: join(root, "runs"), keyFile: join(root, "vault.key"), maxSessions: 16,
    eval: {
      grader: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: "/var/lib/infinite-grader/root" },
      member: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: "/var/lib/infinite-eval", agents: { claude: { command: "claude", args: [] } } },
    },
    teams: { workspaceDir: join(root, "workspaces"), lineup: LINEUP },
  } as unknown as Config;
}

function hostOver(root: string, store: EvidenceStore): EvalHost {
  return new EvalHost({
    config: configFor(root), store,
    source: { mirrorPath: () => join(root, "mirror.git"), status: () => ({ mode: "github", repository: "example/app", baseBranch: "main" }) as never },
    hostLoad: { held: () => undefined }, halt: () => ({ check: () => ({ state: "clear" as const }) }), runs: () => [],
  });
}

type Rig = { host: EvalHost; store: EvidenceStore; baselineId: string | undefined; validateId: string; ready: () => void; cleanup: () => void };

/** Stores a validation job and, when asked, a baseline job while the trials module is ready, then reopens it not ready. */
function rig(options: { baseline: boolean }): Rig {
  const root = mkdtempSync(join(tmpdir(), "infinite-trials-unready-"));
  dirs.push(root);
  const vaultKey = randomBytes(32);
  const databasePath = evidenceDatabasePath(join(root, "state"));
  const first = new EvidenceStore({ databasePath, vaultKey });
  const seeded = hostOver(root, first);
  const validate = seeded.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 10 } } as never, randomUUID());
  assert.ok("job" in validate, "the validation job is created");
  let baselineId: string | undefined;
  if (options.baseline) {
    const baseline = seeded.create(PROJECT, {
      kind: "baseline", configurations: [{ profile: CLAUDE, guidance: "as-of-base", knowledge: "none" }],
      limits: { maxTrials: 10, maxWallMinutes: 600 },
    } as never, randomUUID());
    assert.ok("job" in baseline, `the baseline job is created: ${JSON.stringify(baseline).slice(0, 200)}`);
    baselineId = baseline.job.jobId;
  }
  seeded.close();
  first.close();
  // A stored trials version one above the code's makes that module unavailable, as in evidence-store.test.ts.
  const second = new EvidenceStore({ databasePath, vaultKey });
  const trials = evalTrialsModule(second, () => new Date().toISOString());
  second.register({ ...trials, version: trials.version + 1, readVersion: trials.version + 1 });
  second.close();
  const store = new EvidenceStore({ databasePath, vaultKey });
  const host = hostOver(root, store);
  assert.equal(store.status().modules[EVAL_TRIALS_MODULE], "unavailable");
  return { host, store, baselineId, validateId: validate.job.jobId, ready: () => undefined, cleanup: () => { host.close(); store.close(); } };
}

function refused(value: unknown): { status?: number; code?: string } {
  return value as { status?: number; code?: string };
}

test("a read or control of a trial job answers 503 while the trials module is not ready", () => {
  const r = rig({ baseline: true });
  try {
    const list = refused(r.host.jobs());
    assert.equal(list.status, 503, "the list");
    assert.equal(list.code, "evidence-unavailable");
    const view = refused(r.host.job(r.baselineId as string));
    assert.equal(view.status, 503, "the view");
    assert.equal(view.code, "evidence-unavailable");
    const control = refused(r.host.control(r.baselineId as string, "cancel"));
    assert.equal(control.status, 503, "the control");
    assert.equal(control.code, "evidence-unavailable");
    const stored = r.store.read(db => db.get<{ status: string }>("SELECT status FROM eval_jobs WHERE job_id = ?", r.baselineId as string));
    assert.equal(stored?.status, "scheduled", "the refused cancel changed nothing");
  } finally {
    r.cleanup();
  }
});

test("the summary answers 503 while the trials module is not ready", async () => {
  const r = rig({ baseline: false });
  try {
    const summary = refused(await r.host.summary(PROJECT));
    assert.equal(summary.status, 503);
    assert.equal(summary.code, "evidence-unavailable");
  } finally {
    r.cleanup();
  }
});

test("a validation job reads and controls as usual while the trials module is not ready", () => {
  const r = rig({ baseline: false });
  try {
    const list = r.host.jobs();
    assert.ok(Array.isArray(list), "the list of validation jobs answers");
    assert.equal(list.length, 1);
    const view = r.host.job(r.validateId);
    assert.ok(!("code" in view), "the view answers");
    assert.equal((view as { kind: string }).kind, "validate");
    assert.equal((view as { status: string }).status, "scheduled");
    const control = r.host.control(r.validateId, "pause");
    assert.ok(!("code" in control), "pause answers the job");
    assert.equal((control as { status: string }).status, "paused");
  } finally {
    r.cleanup();
  }
});

test("GET /api/eval/jobs answers 503 with the code, not 500", async () => {
  const r = rig({ baseline: true });
  const app = express();
  r.host.routes(app, (_req, _res, next) => next(), (_req, _res, next) => next());
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>(resolve => server.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/eval/jobs`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 503);
    const body = await response.json() as { code?: string };
    assert.equal(body.code, "evidence-unavailable");
  } finally {
    server.close();
    r.cleanup();
  }
});
