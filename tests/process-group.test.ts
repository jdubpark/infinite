import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GROUP_SUPERVISOR, signalGroup, watchLeader } from "../packages/host/src/process-group.js";
import { EXIT_DRAIN_MS } from "../packages/host/src/team-workspace.js";
import { blobReader } from "../packages/host/src/git-stream.js";
import { RepositoryGraphs } from "../packages/host/src/repository-graphs.js";
import { runRepositoryContext } from "../packages/host/src/understanding-runtime.js";
import { createUnderstandingAdapter } from "../packages/host/src/understanding-adapter.js";
import { RepositoryBriefings } from "../packages/host/src/repository-briefings.js";
import { startCloudExecutor } from "../packages/host/src/cloud-executor.js";
import type { Config } from "../packages/host/src/types.js";
import { LEADER_LEAVES, endLeftBehind, gone, leaderGone, leftBehind, until, within } from "./leader-exit.js";

const CASE = { timeout: 600_000, skip: process.platform === "win32" && "process groups are POSIX" };
const SETTLE_MS = EXIT_DRAIN_MS + 5_000;
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));

type Run = { settled: Promise<string>; stop(): unknown };
type Place = { name: string; held: RegExp; stopped?: RegExp; start(record: string, base: string): Run };

function scratch() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "leader-exit-")));
  return { base, record: join(base, "record") };
}

function checkout(base: string) {
  const root = join(base, "checkout");
  mkdirSync(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root, env });
  writeFileSync(join(root, "a.txt"), "content\n");
  execFileSync("git", ["add", "a.txt"], { cwd: root, env });
  execFileSync("git", ["-c", "user.name=Example", "-c", "user.email=dev@example.invalid", "commit", "-q", "-m", "base"], { cwd: root, env });
  return { root, head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, env, encoding: "utf8" }).trim() };
}

function watched(args: string[]) {
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  return { child, closed: new Promise<number | null>(done => child.once("close", done)) };
}

const outcome = (work: Promise<unknown>) => work.then(
  value => `resolved ${JSON.stringify(value)}`,
  (error: unknown) => `rejected ${error instanceof Error ? error.message : String(error)}`,
);
const briefing = (record: string) => ({ command: process.execPath, args: [LEADER_LEAVES, record, "print", "{}"], automatic: false, intervalMs: 1000, cooldownMs: 0, timeoutMs: 30_000 });
const adapterOptions = (signal: AbortSignal) => ({ signal, timeoutMs: 30_000, maxBytes: 1024 * 1024 });

const places: Place[] = [
  {
    name: "a Git stream read",
    held: /^resolved \{"state":"failed"\}$/,
    stopped: /^resolved \{"state":"failed"\}$/,
    start(record, base) {
      const { root, head } = checkout(base);
      const controller = new AbortController();
      const reader = blobReader(() => ({ command: process.execPath, args: [LEADER_LEAVES, record, "exec"] }));
      return { settled: outcome(reader.read(root, head, "a.txt", controller.signal)), stop: () => controller.abort() };
    },
  },
  {
    name: "a repository graph build",
    held: /left a process holding its output/,
    stopped: /closed before refresh completed/,
    start(record, base) {
      const project = join(base, "project");
      mkdirSync(project);
      const projects = [{ id: "sample-project", name: "Sample", path: project, team: {} }] as Config["projects"];
      const service = new RepositoryGraphs({ command: process.execPath, args: [LEADER_LEAVES, record, "print", "{}"], graphifyCommand: "graphify", cacheDir: join(base, "cache"), timeoutMs: 30_000, debounceMs: 0, intervalMs: 86_400_000 }, projects, join(base, "workspaces"));
      return { settled: outcome(service.refresh("sample-project", project, "a".repeat(40), "shared")), stop: () => service.close() };
    },
  },
  {
    name: "a repository context read",
    held: /^rejected context-output-held/,
    stopped: /^rejected context-aborted/,
    start(record, base) {
      const controller = new AbortController();
      const config = { projects: [], repositoryBriefings: briefing(record) } as unknown as Config;
      return { settled: outcome(runRepositoryContext(config, base, adapterOptions(controller.signal))), stop: () => controller.abort() };
    },
  },
  {
    name: "a System tab brief",
    held: /^rejected understanding-output-held$/,
    stopped: /^rejected understanding-process-cancelled$/,
    start(record, base) {
      const controller = new AbortController();
      const config = { projects: [], repositoryBriefings: briefing(record) } as unknown as Config;
      const context = { version: 1, repo: base, generatedAt: "2026-11-25T00:00:00.000Z", head: "a".repeat(40), base: null, files: {}, components: [], edges: [], limitations: [] };
      const brief = createUnderstandingAdapter(config).brief!({ workspaceId: "workspace", root: base, repositoryId: "repo", context, base: null, components: [] } as never, adapterOptions(controller.signal));
      return { settled: outcome(brief), stop: () => controller.abort() };
    },
  },
  {
    name: "a session repository brief",
    held: /^rejected .*Reason: output-held$/,
    stopped: /^rejected /,
    start(record, base) {
      const { root } = checkout(base);
      const manager = {
        state: async () => ({ seq: 1, capabilities: { transcript: 1 } }),
        events: () => ({ events: [{ seq: 1, type: "message", at: "2026-11-25T00:00:00.000Z", data: { id: "probe", role: "user", text: "inspect" } }], cursor: 1, more: false }),
      };
      const briefings = new RepositoryBriefings(briefing(record), manager as never, [{ id: "leader-test", name: "Leader test", path: root } as never]);
      return { settled: outcome(briefings.summarize({ id: "leader-probe", projectId: "leader-test", cwd: root } as never, "0")), stop: () => briefings.close() };
    },
  },
  {
    name: "a cloud executor",
    held: /^resolved/,
    start(record, base) {
      let close: (() => Promise<void>) | undefined;
      const started = startCloudExecutor({ cwd: base, command: process.execPath, commandArgs: [LEADER_LEAVES, record, "print", "ws://127.0.0.1:43210\n"] });
      return { settled: outcome(started.then(executor => { close = executor.close; return executor.exited; })), stop: () => close?.() };
    },
  },
];

test("a group signal reaches the group while its leader runs and nothing once the leader has exited", CASE, async () => {
  const running = scratch(), exited = scratch();
  try {
    const live = watched([LEADER_LEAVES, running.record, "exec", "sleep", "30"]);
    live.child.stdout!.resume();
    live.child.stderr!.resume();
    await until("the running leader records what it leaves", () => leftBehind(running.record) !== undefined);
    const inGroup = leftBehind(running.record)!;
    assert.equal(signalGroup(live.child, "SIGKILL"), "sent");
    await until("the process in the running leader's group ends", () => gone(inGroup.witness));
    assert.equal(gone(inGroup.holder), false, "a process outside the group is not reached");

    const ended = watched([LEADER_LEAVES, exited.record, "print", "done"]);
    ended.child.stdout!.resume();
    ended.child.stderr!.resume();
    const left = await leaderGone(exited.record);
    assert.equal(signalGroup(ended.child, "SIGKILL"), "leader-exited");
    await pause(300);
    assert.equal(gone(left.witness), false, "the process left in the exited leader's group was not signalled");
  } finally {
    endLeftBehind(running.record);
    endLeftBehind(exited.record);
    rmSync(running.base, { recursive: true, force: true });
    rmSync(exited.base, { recursive: true, force: true });
  }
});

test("a watched leader that exits while an escaped holder keeps its output closes a drain later as a leftover", CASE, async () => {
  const { base, record } = scratch();
  try {
    const { child, closed } = watched([LEADER_LEAVES, record, "print", "partial"]);
    const leader = watchLeader(child);
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr!.resume();
    const left = await leaderGone(record);
    assert.equal(await within(closed, SETTLE_MS, "the watched child closes"), 0);
    assert.equal(leader.leftover, true, "the drain, not the holder, ended the output");
    assert.equal(output, "partial");
    assert.equal(gone(left.holder), false, "the holder was not signalled");
    assert.equal(gone(left.witness), false, "the process left in the group was not signalled");
  } finally {
    endLeftBehind(record);
    rmSync(base, { recursive: true, force: true });
  }
});

test("a watched leader whose reader pauses past the drain is not a leftover and its output arrives whole", CASE, async () => {
  const { child, closed } = watched(["-e", "process.stdout.write('x'.repeat(8192))"]);
  const leader = watchLeader(child);
  child.stdout!.pause();
  let size = 0;
  child.stdout!.on("data", (chunk: Buffer) => { size += chunk.length; });
  child.stderr!.resume();
  await new Promise(done => child.once("exit", done));
  await pause(EXIT_DRAIN_MS + 500);
  assert.equal(leader.leftover, false, "a paused reader is not a leftover holder");
  child.stdout!.resume();
  assert.equal(await within(closed, 5_000, "the resumed child closes"), 0);
  assert.equal(size, 8192);
  assert.equal(leader.leftover, false);
});

test("the executor supervisor stops its group while the leader runs and exits with the leader without signalling after it", CASE, async () => {
  const running = scratch(), exited = scratch();
  try {
    const live = spawn(process.execPath, ["-e", GROUP_SUPERVISOR, process.execPath, LEADER_LEAVES, running.record, "exec", "sleep", "30"], { stdio: ["pipe", "pipe", "pipe"] });
    live.stdout.resume();
    live.stderr.resume();
    const liveExit = new Promise(done => live.once("exit", done));
    await until("the running leader records what it leaves", () => leftBehind(running.record) !== undefined);
    const inGroup = leftBehind(running.record)!;
    live.stdin.end();
    await within(liveExit, SETTLE_MS, "the stopped supervisor exits");
    await until("the process in the running leader's group ends", () => gone(inGroup.witness));

    const ended = spawn(process.execPath, ["-e", GROUP_SUPERVISOR, process.execPath, LEADER_LEAVES, exited.record, "print", "ready\n"], { stdio: ["pipe", "pipe", "pipe"] });
    ended.stdout.resume();
    ended.stderr.resume();
    const endedExit = new Promise<number | null>(done => ended.once("exit", done));
    const left = await leaderGone(exited.record);
    assert.equal(await within(endedExit, SETTLE_MS, "the supervisor exits with its leader"), 0);
    await pause(300);
    assert.equal(gone(left.witness), false, "the process left in the exited leader's group was not signalled");
    assert.equal(gone(left.holder), false, "the holder was not signalled");
  } finally {
    endLeftBehind(running.record);
    endLeftBehind(exited.record);
    rmSync(running.base, { recursive: true, force: true });
    rmSync(exited.base, { recursive: true, force: true });
  }
});

test("every spawner settles about a drain after its leader exits while an escaped holder keeps the output, and signals nothing after the exit", CASE, async t => {
  for (const place of places) {
    await t.test(place.name, async () => {
      const { base, record } = scratch();
      let run: Run | undefined, stopped = false;
      try {
        run = place.start(record, base);
        const left = await leaderGone(record);
        assert.match(await within(run.settled, SETTLE_MS, `${place.name} settles after its leader exits`), place.held);
        stopped = true;
        await run.stop();
        await pause(300);
        assert.equal(gone(left.witness), false, "the process left in the leader's group was not signalled");
        assert.equal(gone(left.holder), false, "the holder outside the group runs on");
      } finally {
        endLeftBehind(record);
        if (run && !stopped) await run.stop();
        rmSync(base, { recursive: true, force: true });
      }
    });
  }
});

test("a stop inside the drain after the leader exits settles the spawner and signals nothing", CASE, async t => {
  for (const place of places.filter(candidate => candidate.stopped)) {
    await t.test(place.name, async st => {
      const { base, record } = scratch();
      let run: Run | undefined, stopped = false, settled = false;
      try {
        run = place.start(record, base);
        void run.settled.then(() => { settled = true; });
        const left = await leaderGone(record);
        if (settled) {
          st.skip("the spawner settled before the test could stop it inside the drain");
          return;
        }
        stopped = true;
        const stopping = Promise.resolve(run.stop());
        assert.match(await within(run.settled, SETTLE_MS, `${place.name} settles after the stop`), place.stopped!);
        await within(stopping, SETTLE_MS, "the stop returns");
        await pause(500);
        assert.equal(gone(left.witness), false, "the process left in the leader's group was not signalled");
      } finally {
        endLeftBehind(record);
        if (run && !stopped) await run.stop();
        rmSync(base, { recursive: true, force: true });
      }
    });
  }
});
