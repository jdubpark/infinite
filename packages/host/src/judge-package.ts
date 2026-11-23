import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Capsule } from "./eval-types.js";
import { JUDGE_PACKAGE_DIR } from "./judge-types.js";
import type { TeamCommand } from "./team-types.js";
import { TeamError, teamCommand, teamGitArgs } from "./team-workspace.js";

export type JudgeGate = { scope: "pass" | "fail"; checks: "pass" | "fail" | "skipped" };
export type JudgeSide = { patch: Buffer; gate: JudgeGate };
export type JudgeTask = { title: string; instructions: string; paths: string[]; acceptance: string[] };
export type JudgePackageFiles = { "A.patch": Buffer; "B.patch": Buffer; "task.json": string; "gate.json": string };
export const JUDGE_PACKAGE_MAX_BYTES = 3 * 1024 * 1024;
const PACKAGE_NAMES = ["A.patch", "B.patch", "task.json", "gate.json"] as const;

/** The label draw: the low bit of the first byte of sha256(seed). 0 puts the resolved trial in A for ordering 0. */
export function labelDraw(seed: string): 0 | 1 {
  return (createHash("sha256").update(seed).digest()[0]! & 1) as 0 | 1;
}

/** The task as the judge sees it: no task ID, no brief fields beyond the acceptance criteria. */
export function judgeTaskOf(capsule: Capsule): JudgeTask {
  return {
    title: capsule.task.title,
    instructions: capsule.task.instructions,
    paths: [...capsule.task.paths],
    acceptance: capsule.brief ? [...capsule.brief.acceptance] : [],
  };
}

/** Four files, neutral labels only. Returns undefined when the package is over the size limit. */
export function judgePackage(input: { a: JudgeSide; b: JudgeSide; task: JudgeTask }): JudgePackageFiles | undefined {
  const task = JSON.stringify({
    title: input.task.title,
    instructions: input.task.instructions,
    paths: input.task.paths,
    acceptance: input.task.acceptance,
  }, null, 2);
  const gate = JSON.stringify({
    A: { scope: input.a.gate.scope, checks: input.a.gate.checks },
    B: { scope: input.b.gate.scope, checks: input.b.gate.checks },
  }, null, 2);
  const bytes = input.a.patch.length + input.b.patch.length + Buffer.byteLength(task) + Buffer.byteLength(gate);
  if (bytes > JUDGE_PACKAGE_MAX_BYTES) return undefined;
  return { "A.patch": input.a.patch, "B.patch": input.b.patch, "task.json": task, "gate.json": gate };
}

const writeJudgePackageScript = `
const fs = require("node:fs");
const path = require("node:path");
const metadata = path.join(process.cwd(), ".git");
const nonce = process.argv[1];
const allowed = ["A.patch", "B.patch", "task.json", "gate.json"];
const chunks = [];
const fds = [];
let directoryFd;
function fail() { throw new Error("unsafe package destination"); }
process.stdin.on("data", chunk => chunks.push(chunk));
process.stdin.on("end", () => {
  try {
    const noFollow = fs.constants.O_NOFOLLOW;
    if (!noFollow) fail();
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const names = Object.keys(parsed);
    if (names.length !== allowed.length || !allowed.every(name => names.includes(name))) fail();
    const metadataInfo = fs.lstatSync(metadata);
    if (!metadataInfo.isDirectory() || metadataInfo.isSymbolicLink() || fs.realpathSync(metadata) !== metadata) fail();
    const directory = path.join(metadata, ${JSON.stringify(JUDGE_PACKAGE_DIR)});
    fs.mkdirSync(directory, { mode: 0o700 });
    const directoryInfo = fs.lstatSync(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || fs.realpathSync(directory) !== directory) fail();
    directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | noFollow);
    const opened = fs.fstatSync(directoryFd);
    if (opened.dev !== directoryInfo.dev || opened.ino !== directoryInfo.ino) fail();
    for (const name of allowed) {
      const content = Buffer.from(parsed[name], "base64");
      const fd = fs.openSync(path.join(directory, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
      fds.push(fd);
      fs.writeFileSync(fd, content);
      fs.fchmodSync(fd, 0o400);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fds.pop();
    }
    fs.fsyncSync(directoryFd);
    fs.closeSync(directoryFd);
    directoryFd = undefined;
    process.stdout.write("INFINITE_JUDGE_PACKAGE_WRITTEN:" + nonce);
  } catch {
    for (const fd of fds) { try { fs.closeSync(fd); } catch {} }
    try { if (directoryFd !== undefined) fs.closeSync(directoryFd); } catch {}
    process.stderr.write("The host refused an unsafe Git metadata package write.\\n");
    process.exitCode = 1;
  }
});
`;

function invalidWorkspace(message: string) {
  return new TeamError(409, "invalid-workspace", message);
}

/** Store the package under the workspace's Git metadata directory, never in the working tree. */
export async function writeJudgePackage(cwd: string, files: JudgePackageFiles, prefix: TeamCommand | undefined, signal?: AbortSignal): Promise<void> {
  let info: ReturnType<typeof lstatSync>;
  let canonical: string;
  try {
    info = lstatSync(cwd);
    canonical = realpathSync(cwd);
  } catch { throw invalidWorkspace("The judge workspace must be an accessible real Git repository."); }
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== resolve(cwd))
    throw invalidWorkspace("The judge workspace must be a real directory without a symlink path.");
  const top = await teamCommand({ command: "git", args: teamGitArgs(canonical, ["rev-parse", "--show-toplevel"]) }, canonical, signal, 30000, prefix);
  if (top.exitCode !== 0 || top.interrupted || top.truncated || top.stdout.trim() !== canonical)
    throw invalidWorkspace("The judge workspace must be a Git repository root.");
  const encoded: Record<string, string> = {};
  for (const name of PACKAGE_NAMES) encoded[name] = Buffer.from(files[name]).toString("base64");
  const nonce = randomUUID();
  const result = await teamCommand({ command: process.execPath, args: ["-e", writeJudgePackageScript, nonce] }, canonical, signal, 30000, prefix, JSON.stringify(encoded));
  if (result.exitCode !== 0 || result.interrupted || result.truncated || !result.stdout.includes(`INFINITE_JUDGE_PACKAGE_WRITTEN:${nonce}`))
    throw new TeamError(409, "judge-package-write-failed", "The judge package could not be stored safely in Git metadata; do not launch this judge.");
}
