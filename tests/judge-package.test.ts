import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capsule } from "../packages/host/src/eval-types.js";
import { TeamError } from "../packages/host/src/team-workspace.js";
import {
  JUDGE_PACKAGE_MAX_BYTES, judgePackage, judgeTaskOf, labelDraw, writeJudgePackage,
  type JudgeGate, type JudgePackageFiles, type JudgeTask,
} from "../packages/host/src/judge-package.js";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "judge-package-test-"));
  git(root, "init", "--initial-branch=main");
  writeFileSync(join(root, "tracked.txt"), "committed content\n");
  git(root, "add", "tracked.txt");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "base");
  return realpathSync(root);
}

const gate: JudgeGate = { scope: "pass", checks: "skipped" };
const otherGate: JudgeGate = { scope: "fail", checks: "pass" };
const task: JudgeTask = { title: "Fix the parser", instructions: "Make it parse.", paths: ["src/parser.ts"], acceptance: ["parses"] };
const capsule: Capsule = {
  objective: "objective",
  steering: [],
  ownerAnswers: [],
  task: { id: "task-zz-secret", title: "Fix the parser", instructions: "Make it parse.", paths: ["src/parser.ts"] },
};

test("the label draw is stable and splits", () => {
  assert.equal(labelDraw("x"), labelDraw("x"));
  const counts = [0, 0];
  for (let index = 0; index < 200; index += 1) counts[labelDraw(`c:${index}`)] += 1;
  assert.ok(counts[0] >= 70 && counts[0] <= 130, `zeros ${counts[0]}`);
  assert.ok(counts[1] >= 70 && counts[1] <= 130, `ones ${counts[1]}`);
});

test("task.json holds exactly four keys", () => {
  const withBrief: Capsule = {
    ...capsule,
    brief: { title: "t", problem: "p", evidence: [{ source: "s", observation: "o" }], dataShape: "d", acceptance: ["first", "second"], expectedOutcome: "e", uiChanges: false },
  };
  const taskOf = judgeTaskOf(withBrief);
  assert.deepEqual(taskOf.acceptance, ["first", "second"]);
  const files = judgePackage({ a: { patch: Buffer.from("a"), gate }, b: { patch: Buffer.from("b"), gate }, task: taskOf });
  assert.ok(files);
  assert.deepEqual(Object.keys(JSON.parse(files["task.json"])), ["title", "instructions", "paths", "acceptance"]);
  assert.equal(files["task.json"].includes("task-zz-secret"), false);
  assert.deepEqual(judgeTaskOf(capsule).acceptance, []);
  assert.equal(JSON.stringify(judgeTaskOf(capsule)).includes("task-zz-secret"), false);
});

test("gate.json holds exactly A and B", () => {
  const files = judgePackage({ a: { patch: Buffer.from("a"), gate }, b: { patch: Buffer.from("b"), gate: otherGate }, task });
  assert.ok(files);
  const parsed = JSON.parse(files["gate.json"]);
  assert.deepEqual(Object.keys(parsed), ["A", "B"]);
  assert.deepEqual(parsed.A, gate);
  assert.deepEqual(parsed.B, otherGate);
});

test("an empty patch is written as an empty file", () => {
  const files = judgePackage({ a: { patch: Buffer.alloc(0), gate }, b: { patch: Buffer.from("b"), gate }, task });
  assert.ok(files);
  assert.equal(files["A.patch"].length, 0);
});

test("an oversized package is refused", () => {
  const big = Buffer.alloc(Math.floor(1.6 * 1024 * 1024), 1);
  assert.ok(big.length * 2 > JUDGE_PACKAGE_MAX_BYTES);
  assert.equal(judgePackage({ a: { patch: big, gate }, b: { patch: big, gate }, task }), undefined);
});

function sample(): JudgePackageFiles {
  const files = judgePackage({
    a: { patch: Buffer.concat([Buffer.from("diff a\n"), Buffer.from([0, 255, 10])]), gate },
    b: { patch: Buffer.from("diff b\n"), gate },
    task,
  });
  assert.ok(files);
  return files;
}

test("the writer stores the package in Git metadata", async () => {
  const root = repository();
  const prefix = {
    command: process.execPath,
    args: ["-e", "const {spawnSync}=require('node:child_process');const r=spawnSync(process.argv[1],process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1)"],
  };
  try {
    const files = sample();
    await writeJudgePackage(root, files, prefix);
    const directory = join(root, ".git", "infinite-judge");
    assert.equal(lstatSync(directory).mode & 0o777, 0o700);
    for (const name of ["A.patch", "B.patch", "task.json", "gate.json"] as const) {
      const path = join(directory, name);
      const expected = Buffer.from(files[name]);
      assert.equal(readFileSync(path).equals(expected), true, name);
      assert.equal(lstatSync(path).mode & 0o777, 0o400, name);
    }
    assert.equal(git(root, "status", "--porcelain"), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the writer refuses a symlinked directory", async () => {
  const root = repository();
  const outside = mkdtempSync(join(tmpdir(), "judge-package-outside-"));
  try {
    symlinkSync(outside, join(root, ".git", "infinite-judge"));
    await assert.rejects(writeJudgePackage(root, sample(), undefined), (error: unknown) =>
      error instanceof TeamError && error.code === "judge-package-write-failed");
    assert.equal(existsSync(join(outside, "A.patch")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("the writer refuses a directory that is not a repository root", async () => {
  const root = repository();
  const inner = join(root, "inner");
  mkdirSync(inner);
  try {
    await assert.rejects(writeJudgePackage(inner, sample(), undefined), (error: unknown) =>
      error instanceof TeamError && error.code === "invalid-workspace");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
