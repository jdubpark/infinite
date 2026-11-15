import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORRECTION_FILE_BYTES, GOAL_RECORD_USAGE, handleGoalClientCommand, objectiveRecordLines, readCorrectionFile } from "../packages/host/src/objective-cli.js";
import { clientCommandCandidate, parseClientArgs } from "../packages/host/src/client.js";
import type { ObjectiveRecordView } from "../packages/host/src/objective-record.js";

const G = "5f0c2a6e-1b7d-4c3a-9e8f-2d4b6a8c0e12";
const R = "9b1f6c0e-2d4a-4e8b-8f3a-6c5d7e9f0a1b";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AT = "2026-11-14T00:00:00.000Z";
type Api = Parameters<typeof handleGoalClientCommand>[2];
type Fault = { status: number; code?: string };
type Call = { method: string; path: string; body?: unknown };

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

/** A stub API. `fault` applies to every call, or only to POST when `onlyPost` is set. */
function fakeApi(fault?: Fault | Error, onlyPost = false) {
  const paths: string[] = [];
  const calls: Call[] = [];
  const api: Api = {
    async json<T = unknown>(path: string, body?: unknown, _signal?: unknown, _headers?: unknown, method?: string): Promise<T> {
      const verb = method ?? (body === undefined ? "GET" : "POST");
      paths.push(path);
      calls.push({ method: verb, path, body });
      if (fault !== undefined && (!onlyPost || verb === "POST")) {
        throw fault instanceof Error ? fault : Object.assign(new Error("host message, never shown"), fault);
      }
      return view() as T;
    },
  };
  return { api, paths, calls };
}

async function captureLogs(run: () => Promise<unknown>): Promise<string[]> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try { await run(); } finally { console.log = original; }
  return logs;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "objective-cli-"));
  try { await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
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
  const separated = objectiveRecordLines(view({ direction: "Prefer\u2028seed\u2029stage" }), G);
  assert.ok(separated.includes(`  s2 steering at ${AT}: Prefer seed stage`));
  assert.ok(separated.every(line => !/[\u2028\u2029]/.test(line)));
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

  const cases: { fault: Fault; text: string }[] = [
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

test("a correction reads the version, then posts once", () => withTempDir(async dir => {
  const retire = fakeApi();
  const logs = await captureLogs(() => handleGoalClientCommand(["record", G, "retire", "c1"], {}, retire.api));
  assert.deepEqual(retire.paths, [`/goals/${G}/record`, `/goals/${G}/record`]);
  assert.deepEqual(retire.calls.map(call => call.method), ["GET", "POST"]);
  const body = retire.calls[1].body as { requestId: string; version: number; ops: unknown };
  assert.match(body.requestId, UUID);
  assert.deepEqual({ ...body, requestId: undefined }, { requestId: undefined, version: 3, ops: [{ op: "criterion.retire", id: "c1" }] });
  assert.equal(logs[0], `Record version 3.`);
  assert.equal(logs[1], `Goal ${G} · record version 2 of 3 · rebuilt · digest abcdef012345`);

  const pinned = fakeApi();
  await handleGoalClientCommand(["record", G, "retire", "c1"], { "--version": "3", "--request-id": R }, pinned.api);
  assert.deepEqual(pinned.calls.map(call => call.method), ["POST"]);
  assert.deepEqual(pinned.calls[0].body, { requestId: R, version: 3, ops: [{ op: "criterion.retire", id: "c1" }] });

  const confirm = fakeApi();
  await handleGoalClientCommand(["record", G, "confirm", "c2"], { "--version": "3", "--request-id": R }, confirm.api);
  assert.deepEqual(confirm.calls[0].body, { requestId: R, version: 3, ops: [{ op: "criterion.confirm", id: "c2" }] });

  const json = fakeApi();
  const jsonLogs = await captureLogs(() => handleGoalClientCommand(["record", G, "confirm", "c2"], { "--version": "3", "--json": true }, json.api));
  assert.equal(JSON.parse(jsonLogs.join("\n")).version, 2);

  const file = join(dir, "ops.json");
  writeFileSync(file, JSON.stringify({ ops: [{ op: "criterion.confirm", id: "c2" }, { op: "criterion.retire", id: "c3" }] }));
  const fromFile = fakeApi();
  await handleGoalClientCommand(["record", G, "apply"], { "--version": "3", "--request-id": R, "--file": file }, fromFile.api);
  assert.deepEqual(fromFile.calls.map(call => call.method), ["POST"]);
  assert.deepEqual(fromFile.calls[0].body, { requestId: R, version: 3, ops: [{ op: "criterion.confirm", id: "c2" }, { op: "criterion.retire", id: "c3" }] });
}));

test("a correction file is checked before anything is sent", () => withTempDir(async dir => {
  const large = join(dir, "large.json");
  writeFileSync(large, " ".repeat(CORRECTION_FILE_BYTES + 1));
  const notJson = join(dir, "not-json.json");
  writeFileSync(notJson, "{ ops: ");
  const unknownKey = join(dir, "unknown-key.json");
  writeFileSync(unknownKey, JSON.stringify({ ops: [
    { op: "criterion.confirm", id: "c1" },
    { op: "criterion.retire", id: "c2" },
    { op: "criterion.retire", id: "c3", secretNote: "x" },
  ] }));
  const cases: { file: string; message: string }[] = [
    { file: large, message: "The correction file is over 64 KiB. Nothing was sent." },
    { file: notJson, message: "The correction file is not JSON. Nothing was sent." },
    { file: unknownKey, message: "Correction op 2 is invalid. Nothing was sent." },
  ];
  for (const { file, message } of cases) {
    const { api, paths } = fakeApi();
    await assert.rejects(handleGoalClientCommand(["record", G, "apply"], { "--version": "3", "--request-id": R, "--file": file }, api), { message });
    assert.deepEqual(paths, []);
  }
  assert.throws(() => readCorrectionFile(unknownKey), { message: "Correction op 2 is invalid. Nothing was sent." });

  const { api, paths } = fakeApi();
  await assert.rejects(handleGoalClientCommand(["record", G, "apply"], { "--version": "3", "--request-id": R }, api), { message: GOAL_RECORD_USAGE });
  assert.deepEqual(paths, []);
}));

// The sentences of the correction codes, written out here so that a change to the host's text fails a test.
const CORRECTION_SENTENCES: { code: string; status: number; message: string }[] = [
  { code: "objective-prompts-off", status: 409, message: "Turn on objective prompts for this goal's project before changing its criteria." },
  { code: "objective-op-invalid", status: 400, message: "The correction is invalid." },
  { code: "objective-op-target", status: 409, message: "A correction names a criterion that is missing or in another state." },
  { code: "objective-op-c0", status: 409, message: "Criterion c0 is the goal's success text and cannot be edited or retired." },
  { code: "objective-op-refused", status: 409, message: "The corrected record would be invalid, so nothing was changed." },
  { code: "objective-version-stale", status: 409, message: "The record changed since it was read. Read it again and resend the correction." },
  { code: "objective-criterion-misfit", status: 400, message: "A criterion's producer or threshold does not fit its check." },
  { code: "objective-criterion-too-large", status: 400, message: "A criterion is over 2,048 bytes." },
  { code: "objective-command-unknown", status: 400, message: "A command criterion must name one of the project's configured checks." },
  { code: "objective-secret", status: 400, message: "A criterion looks like it holds a secret, so nothing was changed." },
  { code: "objective-criteria-limit", status: 409, message: "A record holds at most 8 active criteria and 64 in all." },
  { code: "objective-too-large", status: 409, message: "The corrected record would be over its size limit." },
  { code: "objective-log-full", status: 409, message: "The record's log is full. Start a new goal with consolidated criteria." },
  { code: "objective-digest-too-large", status: 409, message: "The active criteria would be over the 6 KiB prompt digest." },
];

test("correction errors map to sentences", async () => {
  for (const { code, status, message } of CORRECTION_SENTENCES) {
    const { api, paths } = fakeApi({ status, code }, true);
    await assert.rejects(handleGoalClientCommand(["record", G, "retire", "c1"], { "--version": "3", "--request-id": R }, api), { message });
    assert.deepEqual(paths, [`/goals/${G}/record`]);
  }

  const older = fakeApi({ status: 404 }, true);
  await assert.rejects(handleGoalClientCommand(["record", G, "retire", "c1"], { "--version": "3", "--request-id": R }, older.api), { message: "This host does not accept corrections. Upgrade the host." });

  const invalidId = fakeApi();
  await assert.rejects(handleGoalClientCommand(["record", G, "retire", "C1"], { "--version": "3", "--request-id": R }, invalidId.api), { message: "The correction is invalid." });
  assert.deepEqual(invalidId.paths, []);

  const forbidden = fakeApi({ status: 403 }, true);
  await assert.rejects(handleGoalClientCommand(["record", G, "retire", "c1"], { "--version": "3", "--request-id": R }, forbidden.api), { message: "Corrections need an owner device key." });

  const conflict = fakeApi({ status: 409, code: "request-conflict" }, true);
  await assert.rejects(handleGoalClientCommand(["record", G, "retire", "c1"], { "--version": "3", "--request-id": R }, conflict.api), { message: "This request ID was used for another correction. Leave out --request-id to send a new one." });

  const retry = `The correction may have been applied. Retry it safely with: infinite goal record ${G} retire c1 --version 3 --request-id ${R}`;
  for (const failure of [new Error("fetch failed"), { status: 500 }]) {
    const { api } = fakeApi(failure, true);
    await assert.rejects(handleGoalClientCommand(["record", G, "retire", "c1"], { "--version": "3", "--request-id": R }, api), { message: retry });
  }

  const unknown = fakeApi({ status: 400 }, true);
  await assert.rejects(handleGoalClientCommand(["record", G, "retire", "c1"], { "--version": "3", "--request-id": R }, unknown.api), { message: "The host refused the correction." });

  const badId = fakeApi();
  await assert.rejects(handleGoalClientCommand(["record", G, "retire", "c1"], { "--version": "3", "--request-id": "not-a-uuid" }, badId.api), { message: "Give --request-id as a UUID." });
  assert.deepEqual(badId.paths, []);
});

test("goal options parse", async () => {
  const parsed = parseClientArgs(["goal", "record", G, "--version", "2", "--json"]);
  assert.equal(parsed.command, "goal");
  assert.deepEqual(parsed.args, ["record", G]);
  assert.equal(parsed.options["--version"], "2");
  assert.equal(clientCommandCandidate(["--version", "2", "goal"]), "goal");

  const retire = parseClientArgs(["goal", "record", G, "retire", "c1", "--version", "3", "--request-id", R]);
  assert.deepEqual(retire.args, ["record", G, "retire", "c1"]);
  assert.equal(retire.options["--request-id"], R);
  const applied = parseClientArgs(["goal", "record", G, "apply", "--file", "ops.json"]);
  assert.deepEqual(applied.args, ["record", G, "apply"]);
  assert.equal(applied.options["--file"], "ops.json");

  for (const positional of [["record", G, "retire", "c1", "x"], ["record", G, "retire"], ["record", G, "apply", "c1"]]) {
    const { api, paths } = fakeApi();
    await assert.rejects(handleGoalClientCommand(positional, { "--version": "3", "--request-id": R, "--file": "ops.json" }, api), { message: GOAL_RECORD_USAGE });
    assert.deepEqual(paths, []);
  }
  const readWithFlag = fakeApi();
  await assert.rejects(handleGoalClientCommand(["record", G], { "--request-id": R }, readWithFlag.api), { message: GOAL_RECORD_USAGE });
  assert.deepEqual(readWithFlag.paths, []);
});
