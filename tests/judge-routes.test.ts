import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import { finishTrial, insertTrial, startTrial } from "../packages/host/src/eval-trial-store.js";
import { configRef, TRIAL_HARNESS_VERSION } from "../packages/host/src/eval-trial-rules.js";
import { EvalHost } from "../packages/host/src/eval-host.js";
import { handleDuelClientCommand } from "../packages/host/src/duel-cli.js";
import type { EvalApi } from "../packages/host/src/eval-cli.js";
import { JUDGE_MODULE, judgeCalibrationsModule } from "../packages/host/src/judge-store.js";
import type { TrialConfiguration, TrialGrade } from "../packages/host/src/eval-types.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import type { Config } from "../packages/host/src/types.js";

const T0 = "2026-11-22T00:00:00.000Z";
const MARKER = "RESOLVED-MARKER";
const JUDGE = { id: "zz-judge", label: "Judge", provider: "codex", model: "judge-model-q7", effort: "high", tier: "strong" } as TeamModelProfile;
const OTHER = { id: "zz-other", label: "Other", provider: "claude", model: "other-model-q7", effort: "high", tier: "strong" } as TeamModelProfile;
const REQUEST = "11111111-1111-4111-8111-111111111111";
const READ_ROLES = ["owner", "controller", "viewer"];
const VIEW_KEYS = ["accuracy", "calibrationId", "completedAt", "cost", "createdAt", "expiresAt", "inForce", "judgeMinutes", "lowerBound", "pairs",
  "profileEpoch", "profileId", "promptVersion", "reason", "state", "status", "swapAgreement", "validUntil", "waiting"];
const dirs: string[] = [];

test.after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const readGuard: express.RequestHandler = (req, res, next) => READ_ROLES.includes(String(req.header("x-role"))) ? next() : void res.status(401).json({ code: "unauthorized" });
const ownerGuard: express.RequestHandler = (req, res, next) => req.header("x-role") === "owner" ? next() : void res.status(403).json({ code: "forbidden" });

type Rig = { store: EvidenceStore; base: string; clock: { at: string }; seq: { n: number }; close: () => Promise<void> };

function configOf(patch: Record<string, unknown> = {}): Config {
  return {
    projects: [{ id: "P", name: "P", path: "/srv/unused", team: { eval: { trialsPerDay: 2 } } }],
    teams: { lineup: { judge: JUDGE } },
    eval: { member: { agents: { codex: { command: "agent", args: [] } } } },
    ...patch,
  } as unknown as Config;
}

async function rig(options: { config?: Config; newer?: boolean } = {}): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), "infinite-judge-routes-"));
  dirs.push(root);
  const databasePath = evidenceDatabasePath(join(root, "state"));
  const vaultKey = randomBytes(32);
  const clock = { at: T0 };
  const now = () => clock.at;
  if (options.newer) {
    const first = new EvidenceStore({ databasePath, vaultKey });
    const judge = judgeCalibrationsModule(first, now);
    first.register({ ...judge, version: judge.version + 1, readVersion: judge.version + 1 });
    first.close();
  }
  const store = new EvidenceStore({ databasePath, vaultKey });
  store.register(configurationModule());
  const host = new EvalHost({
    config: options.config ?? configOf(), store, now,
    source: { mirrorPath: () => root, status: () => ({ mode: "github", repository: "example/app", baseBranch: "main" }) },
    hostLoad: { held: () => undefined },
    halt: () => ({ check: () => ({ state: "clear" as const }) }),
    runs: () => [],
  } as ConstructorParameters<typeof EvalHost>[0]);
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  host.routes(app, readGuard, ownerGuard);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    store, clock, seq: { n: 0 }, base: `http://127.0.0.1:${port}`,
    close: async () => {
      host.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
    },
  };
}

async function call(r: Rig, method: string, path: string, role: string, body?: unknown) {
  const headers: Record<string, string> = { "x-role": role };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${r.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, text, body: text === "" ? undefined : JSON.parse(text) };
}

const GRADE = (resolved: boolean): TrialGrade => ({ ending: "graded", expectedPassed: resolved ? 1 : 0, expectedTotal: 1, guardPassed: true, resolved, overwritten: 0, diff: null, isolation: "isolated" });

function seedPairs(r: Rig, count: number): void {
  for (let i = 0; i < count; i++) {
    const taskId = `t-P-${String(i).padStart(3, "0")}`;
    r.store.write(tx => {
      tx.run("INSERT INTO eval_groups (group_id, kind, project_ref, root_id, created_at, holdout, set_at, confirms, exposed) VALUES (?, 'run', ?, ?, ?, 0, NULL, 0, 0)",
        `g-${taskId}`, tx.index("project", "P"), `g-${taskId}`, T0);
      tx.run("INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, material, base, captured_at, checked_at, payload, group_id) "
        + "VALUES (?, 'captured', '', '', ?, 'valid', 'stored', 'proven', ?, ?, 'x', ?)", taskId, tx.index("project", "P"), T0, T0, `g-${taskId}`);
      for (const resolved of [true, false]) {
        const trialId = `trial-${r.seq.n++}`;
        const configuration: TrialConfiguration = { profile: OTHER, guidance: "as-of-base", knowledge: "none" };
        insertTrial(tx, { trialId, jobId: "job-1", taskId, configRef: configRef(configuration), harness: TRIAL_HARNESS_VERSION, slot: r.seq.n, attempt: 0,
          projectId: "P", configuration, keepDays: 365 }, T0);
        startTrial(tx, trialId, T0);
        finishTrial(tx, trialId, { grade: GRADE(resolved), configId: null, profileEpoch: null, sessionId: null, patchKeepDays: 90, patch: Buffer.from(resolved ? MARKER : "plain"), }, T0);
      }
    });
  }
}

const body = (requestId = REQUEST) => ({ requestId, judgeProfileId: JUDGE.id });

const cliApi = (r: Rig, role: string): EvalApi => ({
  json: async <T>(path: string, payload?: unknown, _signal?: AbortSignal, _headers?: Record<string, string>, method?: string) => {
    const reply = await call(r, method ?? (payload === undefined ? "GET" : "POST"), `/api${path}`, role, payload);
    if (reply.status >= 400) throw Object.assign(new Error(`HTTP ${reply.status}`), { status: reply.status, code: reply.body?.code });
    return reply.body as T;
  },
});

async function printed(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try { await run(); } finally { console.log = original; }
  return lines;
}
const CREATE = "/api/duels/judges/calibrations";

test("a viewer reads the judges list", async () => {
  const r = await rig();
  try {
    const reply = await call(r, "GET", "/api/duels/judges", "viewer");
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, { calibrations: [] });
    assert.equal((await call(r, "GET", "/api/duels/judges", "nobody")).status, 401);
    assert.equal(r.store.read(db => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM judge_calibrations")!.n), 0);
  } finally {
    await r.close();
  }
});

test("only the owner starts a calibration", async () => {
  const r = await rig();
  try {
    seedPairs(r, 30);
    assert.equal((await call(r, "POST", CREATE, "controller", body())).status, 403);
    const made = await call(r, "POST", CREATE, "owner", body());
    assert.equal(made.status, 201, made.text);
    assert.equal(made.body.calibration.status, "running");
    const again = await call(r, "POST", CREATE, "owner", body());
    assert.equal(again.status, 201, "a repeated request answers the same view");
    assert.equal(again.body.calibration.calibrationId, made.body.calibration.calibrationId);
  } finally {
    await r.close();
  }
});

test("a refusal returns its code and fixed message", async () => {
  const r = await rig({ config: configOf({ teams: { lineup: {} } }) });
  try {
    const refused = await call(r, "POST", CREATE, "owner", body());
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body, { code: "judge-not-configured", error: "The host has no judge configured." });
    const invalid = await call(r, "POST", CREATE, "owner", { requestId: "bad text echoed-4f2a", extra: 1 });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, "invalid-calibration-request");
    assert.equal(invalid.text.includes("echoed-4f2a"), false);
  } finally {
    await r.close();
  }
});

test("only the owner cancels", async () => {
  const r = await rig();
  try {
    seedPairs(r, 30);
    const made = await call(r, "POST", CREATE, "owner", body());
    const id = made.body.calibration.calibrationId;
    assert.equal((await call(r, "POST", `${CREATE}/${id}/cancel`, "controller")).status, 403);
    const cancelled = await call(r, "POST", `${CREATE}/${id}/cancel`, "owner");
    assert.equal(cancelled.status, 200, cancelled.text);
    assert.equal(cancelled.body.calibration.status, "cancelled");
    const unknown = await call(r, "POST", `${CREATE}/00000000-0000-4000-8000-000000000000/cancel`, "owner");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, "unknown-calibration");
  } finally {
    await r.close();
  }
});

test("the judges view carries no task, trial, or patch field", async () => {
  const r = await rig();
  try {
    seedPairs(r, 30);
    await call(r, "POST", CREATE, "owner", body());
    const listed = await call(r, "GET", "/api/duels/judges", "viewer");
    assert.equal(listed.body.calibrations.length, 1);
    assert.equal(listed.body.calibrations[0].waiting, null, "a running calibration reports that nothing holds it");
    for (const key of Object.keys(listed.body.calibrations[0])) assert.ok(VIEW_KEYS.includes(key), `unexpected key ${key}`);
    for (const secret of ["t-P-", "trial-", "other-model-q7", "judge-model-q7", MARKER, "plain"]) assert.equal(listed.text.includes(secret), false, secret);
  } finally {
    await r.close();
  }
});

test("the list is newest first and capped at 20", async () => {
  const r = await rig();
  try {
    seedPairs(r, 30);
    for (let i = 0; i < 22; i++) {
      r.clock.at = new Date(Date.parse(T0) + i * 60_000).toISOString();
      const made = await call(r, "POST", CREATE, "owner", body(`request-${i}`));
      assert.equal(made.status, 201, made.text);
      await call(r, "POST", `${CREATE}/${made.body.calibration.calibrationId}/cancel`, "owner");
    }
    const listed = await call(r, "GET", "/api/duels/judges", "owner");
    assert.equal(listed.body.calibrations.length, 20);
    assert.equal(listed.body.calibrations[0].createdAt, new Date(Date.parse(T0) + 21 * 60_000).toISOString());
  } finally {
    await r.close();
  }
});

test("a judge module that is not ready answers 503 on every route", async () => {
  const r = await rig({ newer: true });
  try {
    assert.equal(r.store.status().modules[JUDGE_MODULE], "unavailable");
    for (const [method, path, role, payload] of [["GET", "/api/duels/judges", "viewer", undefined], ["POST", CREATE, "owner", body()],
      ["POST", `${CREATE}/00000000-0000-4000-8000-000000000000/cancel`, "owner", undefined]] as const) {
      const reply = await call(r, method, path, role, payload);
      assert.equal(reply.status, 503, path);
      assert.equal(reply.body.code, "evidence-unavailable");
    }
  } finally {
    await r.close();
  }
});

test("the duels command line reaches the routes", async () => {
  const r = await rig();
  try {
    seedPairs(r, 30);
    const owner = cliApi(r, "owner");
    const started = await printed(() => handleDuelClientCommand(["calibrate"], { "--judge": JUDGE.id, "--request-id": REQUEST }, owner));
    const id = r.store.read(db => db.get<{ id: string }>("SELECT calibration_id AS id FROM judge_calibrations")!.id);
    assert.equal(started.length, 3);
    assert.ok(started[0]!.startsWith(`calibration ${id} judge ${JUDGE.id} `), started[0]);
    assert.ok(started[0]!.includes(" · running · "), started[0]);
    const listed = await printed(() => handleDuelClientCommand(["judges"], {}, cliApi(r, "viewer")));
    assert.equal(listed.length, 4);
    assert.ok(listed[1]!.startsWith(`calibration ${id} `), listed[1]);
    const cancelled = await printed(() => handleDuelClientCommand(["cancel", id], {}, owner));
    assert.ok(cancelled[0]!.includes(" · cancelled · "), cancelled[0]);
    assert.equal(r.store.read(db => db.get<{ status: string }>("SELECT status FROM judge_calibrations WHERE calibration_id = ?", id)!.status), "cancelled");
    await assert.rejects(() => handleDuelClientCommand(["cancel", "00000000-0000-4000-8000-000000000000"], {}, owner), /No calibration has this ID\./);
  } finally {
    await r.close();
  }
});
