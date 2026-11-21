import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { objectiveRoutes } from "../packages/host/src/objective-routes.js";
import type { GoalVerdictView } from "../packages/host/src/verdict-view.js";
import type { VerdictDetail } from "../packages/host/src/team-verdicts.js";

const GOAL = "5f0c2a6e-1b7d-4c3a-9e8f-2d4b6a8c0e12";
const TEAM_ONE = "11111111-1111-4111-8111-111111111111";
const TEAM_TWO = "22222222-2222-4222-8222-222222222222";
const VERDICT_ONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VERDICT_TWO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HEAD = "a".repeat(40);
const AT = "2026-11-20T00:00:00.000Z";
const LABEL = "Agent assessment, provisional";

function assessment(verdictId: string, result: "met" | "not-met", progress: number) {
  return {
    verdictId, revision: 1, head: HEAD, kind: "reviewed" as const, result, evaluatorResult: "met" as const,
    counts: { met: 1, notMet: 1, inconclusive: 0, pendingOwner: 0 },
    criteria: [{ id: "c0", state: "met" as const }, { id: "c1", state: "not-met" as const }], at: AT, progress,
  };
}

function cycle(teamId: string, number: number, value: ReturnType<typeof assessment>) {
  return { teamId, cycle: number, assessment: value };
}

function detail(): VerdictDetail {
  return {
    verdictId: VERDICT_ONE, kind: "reviewed", revision: 1, head: HEAD, result: "not-met", evaluatorResult: "met",
    criteria: [
      { id: "c0", producer: "host", state: "met", receipt: { handle: "receipt:r1", outcome: "pass" }, handles: [] },
      { id: "c1", producer: "evaluator", state: "not-met", evaluatorState: "not-met", handles: ["file:a.ts"], note: "the note" },
      { id: "c2", producer: "owner", state: "met", handles: [] },
      { id: "c3", producer: "owner", state: "pending-owner", handles: [] },
    ],
    evaluator: { profileId: "p1", provider: "claude", family: "anthropic", sharedFamily: false, alsoReviewed: true },
  };
}

function goal() {
  return {
    id: GOAL,
    cycles: [cycle(TEAM_ONE, 1, assessment(VERDICT_ONE, "not-met", 1)), cycle(TEAM_TWO, 2, assessment(VERDICT_TWO, "met", 0))],
    outcomes: [{ result: "not-achieved" as const, verdictId: VERDICT_ONE, at: AT }],
  };
}

async function serve(): Promise<{ base: string; calls: string[]; close: () => Promise<void> }> {
  const calls: string[] = [];
  const app = express();
  const read: express.RequestHandler = (req, res, next) => ["owner", "controller", "viewer"].includes(String(req.header("x-role")))
    ? next()
    : void res.status(401).json({ code: "unauthorized" });
  const owner: express.RequestHandler = (_req, _res, next) => next();
  const services = {
    goals: {
      objectiveRecord: () => { throw new Error("not used"); },
      correctObjective: async () => { throw new Error("not used"); },
      get: (id: string) => {
        if (id !== GOAL) throw Object.assign(new Error("no goal"), { status: 404 });
        return goal();
      },
    },
    teams: {
      objectiveRecord: () => { throw new Error("not used"); },
      verdicts: {
        detail: (id: string) => {
          calls.push(id);
          return id === TEAM_ONE ? detail() : undefined;
        },
      },
    },
  };
  objectiveRoutes(app, services as never, read, owner);
  app.use(((error: { status?: number }, _req, res, _next) => {
    res.status(error.status ?? 500).json({ code: "error" });
  }) as express.ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, calls, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

async function get(base: string, path: string, role: string) {
  const response = await fetch(`${base}${path}`, { headers: { "x-role": role } });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}

test("the verdicts read joins cycles, details, and owner answers", async () => {
  const server = await serve();
  try {
    const reply = await get(server.base, `/api/goals/${GOAL}/verdicts`, "owner");
    assert.equal(reply.status, 200);
    const views = (reply.body as { verdicts: GoalVerdictView[] }).verdicts;
    assert.equal(views.length, 2);
    const [first, second] = views;
    assert.equal(first.cycle, 1);
    assert.equal(first.teamId, TEAM_ONE);
    assert.equal(first.verdictId, VERDICT_ONE);
    assert.equal(first.label, LABEL);
    assert.equal(first.detail, "available");
    assert.equal(first.result, "not-met");
    assert.equal(first.progress, 1);
    assert.equal(first.differs, true);
    assert.deepEqual(first.owner, { result: "not-achieved", agrees: true });
    assert.equal(first.criteria.length, 4);
    assert.equal(first.criteria[0].label, "host receipt");
    assert.deepEqual(first.criteria[0].receipt, { handle: "receipt:r1", outcome: "pass" });
    assert.equal(first.criteria[1].label, "agent assessment");
    assert.equal(first.criteria[1].note, "the note");
    assert.deepEqual(first.criteria[1].handles, ["file:a.ts"]);
    assert.equal(first.criteria[2].label, "your rating");
    assert.equal(first.criteria[3].label, "waiting for you");
    assert.equal(first.evaluator?.family, "anthropic");
    assert.equal(first.evaluator?.alsoReviewed, true);
    assert.equal(second.cycle, 2);
    assert.equal(second.detail, "expired");
    assert.equal(second.label, LABEL);
    assert.equal(second.result, "met");
    assert.equal(second.counts.met, 1);
    assert.equal(second.criteria.length, 0);
    assert.equal(second.differs, false);
    assert.equal(second.owner, undefined);
    assert.deepEqual(server.calls, [TEAM_ONE, TEAM_TWO]);
  } finally { await server.close(); }
});

test("the verdicts read keeps the record roles", async () => {
  const server = await serve();
  try {
    for (const role of ["owner", "controller", "viewer"]) {
      const reply = await get(server.base, `/api/goals/${GOAL}/verdicts`, role);
      assert.equal(reply.status, 200, role);
    }
    const unknown = await get(server.base, "/api/goals/00000000-0000-4000-8000-000000000000/verdicts", "owner");
    assert.equal(unknown.status, 404);
    const none = await get(server.base, `/api/goals/${GOAL}/verdicts`, "stranger");
    assert.equal(none.status, 401);
  } finally { await server.close(); }
});
