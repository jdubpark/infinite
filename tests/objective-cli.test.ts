import test from "node:test";
import assert from "node:assert/strict";
import { GOAL_RECORD_USAGE, handleGoalClientCommand, objectiveRecordLines } from "../packages/host/src/objective-cli.js";
import { clientCommandCandidate, parseClientArgs } from "../packages/host/src/client.js";
import type { ObjectiveRecordView } from "../packages/host/src/objective-record.js";

const G = "5f0c2a6e-1b7d-4c3a-9e8f-2d4b6a8c0e12";
const AT = "2026-11-14T00:00:00.000Z";
type Api = Parameters<typeof handleGoalClientCommand>[2];

function view(overrides: { direction?: string } = {}): ObjectiveRecordView {
  return {
    owner: { kind: "goal", goalId: G },
    version: 2,
    latestVersion: 3,
    rebuilt: true,
    record: {
      schemaVersion: 1,
      owner: { kind: "goal", goalId: G },
      version: 2,
      digest: "abcdef0123456789" + "0".repeat(48),
      statement: {
        objective: "Find ranked seed-stage companies",
        directions: [{ id: "s2", text: overrides.direction ?? "Prefer seed stage", source: "steering", at: AT }],
      },
      definitions: [],
      constraints: { allowedPaths: ["research"], excludedPaths: [], rules: [] },
      nonGoals: [{ id: "n1", text: "no paid sources" }],
      ownerEvidence: [],
      criteria: [{
        id: "c0", origin: "owner", statement: "A ranked shortlist", check: { kind: "judgement", item: "owner-text" },
        producer: "evaluator", threshold: { kind: "pass" }, state: "active",
      }],
      assumptions: [],
      questions: [],
      rubricVersion: 1,
    },
    log: [
      { seq: 1, at: AT, version: 1, actor: "owner", authority: "direction", op: "record.created", target: "record", handle: G },
      { seq: 2, at: AT, version: 2, actor: "owner", authority: "direction", op: "direction.appended", target: "s2", handle: "R1" },
    ],
  };
}

function fakeApi(fault?: { status: number; code?: string }) {
  const paths: string[] = [];
  const api: Api = {
    async json<T = unknown>(path: string): Promise<T> {
      paths.push(path);
      if (fault) throw Object.assign(new Error("host message, never shown"), fault);
      return view() as T;
    },
  };
  return { api, paths };
}

async function captureLogs(run: () => Promise<unknown>): Promise<string[]> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try { await run(); } finally { console.log = original; }
  return logs;
}

test("record lines show the record and its log", () => {
  assert.deepEqual(objectiveRecordLines(view(), G), [
    `Goal ${G} · record version 2 of 3 · rebuilt · digest abcdef012345`,
    "Objective: Find ranked seed-stage companies",
    "Criteria:",
    "  c0 owner active · judgement owner-text · evaluator · pass: A ranked shortlist",
    "Directions:",
    `  s2 steering at ${AT}: Prefer seed stage`,
    "Non-goals:",
    "  n1: no paid sources",
    "Allowed paths: research",
    "Excluded paths: none",
    "Owner evidence: none",
    "Definitions 0 · rules 0 · assumptions 0 · open questions 0 of 0",
    "Log:",
    `  #1 v 1 ${AT} owner direction record.created record`,
    `  #2 v 2 ${AT} owner direction direction.appended s2`,
  ]);
  const escaped = objectiveRecordLines(view({ direction: "\u001b[31mPrefer seed stage" }), G);
  assert.ok(escaped.includes(`  s2 steering at ${AT}:  [31mPrefer seed stage`));
  assert.ok(escaped.every(line => !/[\x00-\x1f\x7f-\x9f]/.test(line)));
});

test("the command reads a version and maps each error", async () => {
  const plain = fakeApi();
  await handleGoalClientCommand(["record", G], {}, plain.api);
  assert.deepEqual(plain.paths, [`/goals/${G}/record`]);

  const versioned = fakeApi();
  await handleGoalClientCommand(["record", G], { "--version": "2" }, versioned.api);
  assert.deepEqual(versioned.paths, [`/goals/${G}/record?version=2`]);

  const json = fakeApi();
  const jsonLogs = await captureLogs(() => handleGoalClientCommand(["record", G], { "--json": true }, json.api));
  assert.equal(JSON.parse(jsonLogs.join("\n")).version, 2);

  const cases: { fault: { status: number; code?: string }; text: string }[] = [
    { fault: { status: 404, code: "goal-not-found" }, text: "No goal has this ID." },
    { fault: { status: 404, code: "objective-version-not-found" }, text: "The record has no version 2." },
    { fault: { status: 409, code: "objective-version-unavailable" }, text: "This host cannot rebuild version 2 of the record." },
    { fault: { status: 409, code: "objective-source-invalid" }, text: "This goal's fields do not fit an objective record. The goal works as before, without one." },
    { fault: { status: 409, code: "objective-record-invalid" }, text: "The stored objective record cannot be read. The host keeps it unchanged." },
    { fault: { status: 409, code: "objective-record-newer" }, text: "A newer host wrote this objective record. Upgrade the host to read it." },
    { fault: { status: 404, code: "objective-record-absent" }, text: "This goal has no objective record yet." },
    { fault: { status: 400 }, text: "The host refused the record query." },
    { fault: { status: 404 }, text: "This host has no objective records. Upgrade the host." },
  ];
  for (const { fault, text } of cases) {
    const { api } = fakeApi(fault);
    await assert.rejects(handleGoalClientCommand(["record", G], { "--version": "2" }, api), { message: text });
  }

  const unknown = fakeApi({ status: 500 });
  await assert.rejects(handleGoalClientCommand(["record", G], {}, unknown.api), { status: 500 });

  for (const positional of [["record"], ["list", G], ["record", G, "x"]]) {
    const { api, paths } = fakeApi();
    await assert.rejects(handleGoalClientCommand(positional, {}, api), { message: GOAL_RECORD_USAGE });
    assert.deepEqual(paths, []);
  }

  for (const bad of ["0", "x"]) {
    const { api, paths } = fakeApi();
    await assert.rejects(handleGoalClientCommand(["record", G], { "--version": bad }, api), { message: "Give --version as a whole number of 1 or more." });
    assert.deepEqual(paths, []);
  }
});

test("goal options parse", () => {
  const parsed = parseClientArgs(["goal", "record", G, "--version", "2", "--json"]);
  assert.equal(parsed.command, "goal");
  assert.deepEqual(parsed.args, ["record", G]);
  assert.equal(parsed.options["--version"], "2");
  assert.equal(clientCommandCandidate(["--version", "2", "goal"]), "goal");
});
