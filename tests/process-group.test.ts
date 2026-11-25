import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signalGroup, watchLeader } from "../packages/host/src/process-group.js";
import { GROUP_SUPERVISOR } from "../packages/host/src/group-supervisor.js";
import { EXIT_DRAIN_MS } from "../packages/host/src/team-workspace.js";
import { blobReader } from "../packages/host/src/git-stream.js";
import { RepositoryGraphs } from "../packages/host/src/repository-graphs.js";
import { runRepositoryContext } from "../packages/host/src/understanding-runtime.js";
import { createUnderstandingAdapter } from "../packages/host/src/understanding-adapter.js";
import { RepositoryBriefings } from "../packages/host/src/repository-briefings.js";
import { startCloudExecutor } from "../packages/host/src/cloud-executor.js";
import type { Config } from "../packages/host/src/types.js";
import { LEADER_LEAVES, endLeftBehind, gone, leaderGone, leftBehind, stubbornMember, until, within } from "./leader-exit.js";

const CASE = { timeout: 600_000, skip: process.platform === "win32" && "process groups are POSIX" };
const SETTLE_MS = EXIT_DRAIN_MS + 5_000;
const BUFFERED = 131_072;
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
const busy = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};

type Ending = "exits" | "is killed" | "runs";
type Run = { settled: Promise<string>; stop(): unknown };
type Place = { name: string; held: RegExp; stopped?: RegExp; escalationMs?: number; start(record: string, base: string, ending: Ending): Run };

function mode(ending: Ending, action: "print" | "exec") {
  return ending === "runs" ? "running" : ending === "is killed" ? `${action}-killed` : action;
}

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

function pausedWriter(atDrainEnd?: (release: () => void) => void) {
  const { child, closed } = watched(["-e", `process.stdout.write(Buffer.alloc(${BUFFERED}, 120))`]);
  const out = child.stdout!;
  let size = 0, hold = true;
  const release = () => {
    hold = false;
    out.resume();
  };
  out.pause();
  if (atDrainEnd) child.once("exit", () => setTimeout(atDrainEnd, EXIT_DRAIN_MS, release));
  const exited = new Promise(done => child.once("exit", done));
  const leader = watchLeader(child);
  out.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (hold) out.pause();
  });
  child.stderr!.resume();
  return { child, leader, exited, closed, release, size: () => size };
}

const outcome = (work: Promise<unknown>) => work.then(
  value => `resolved ${JSON.stringify(value)}`,
  (error: unknown) => `rejected ${error instanceof Error ? error.message : String(error)}`,
);
const briefing = (record: string, ending: Ending) => ({ command: process.execPath, args: [LEADER_LEAVES, record, mode(ending, "print"), "{}"], automatic: false, intervalMs: 1000, cooldownMs: 0, timeoutMs: 30_000 });
const adapterOptions = (signal: AbortSignal) => ({ signal, timeoutMs: 30_000, maxBytes: 1024 * 1024 });

const places: Place[] = [
  {
    name: "a Git stream read",
    held: /^resolved \{"state":"failed"\}$/,
    stopped: /^resolved \{"state":"failed"\}$/,
    start(record, base, ending) {
      const { root, head } = checkout(base);
      const controller = new AbortController();
      const reader = blobReader(() => ({ command: process.execPath, args: [LEADER_LEAVES, record, mode(ending, "exec")] }));
      return { settled: outcome(reader.read(root, head, "a.txt", controller.signal)), stop: () => controller.abort() };
    },
  },
  {
    name: "a repository graph build",
    held: /left a process holding its output/,
    stopped: /closed before refresh completed/,
    start(record, base, ending) {
      const project = join(base, "project");
      mkdirSync(project);
      const projects = [{ id: "sample-project", name: "Sample", path: project, team: {} }] as Config["projects"];
      const service = new RepositoryGraphs({ command: process.execPath, args: [LEADER_LEAVES, record, mode(ending, "print"), "{}"], graphifyCommand: "graphify", cacheDir: join(base, "cache"), timeoutMs: 30_000, debounceMs: 0, intervalMs: 86_400_000 }, projects, join(base, "workspaces"));
      return { settled: outcome(service.refresh("sample-project", project, "a".repeat(40), "shared")), stop: () => service.close() };
    },
  },
  {
    name: "a repository context read",
    held: /^rejected context-output-held/,
    stopped: /^rejected context-aborted/,
    escalationMs: 500,
    start(record, base, ending) {
      const controller = new AbortController();
      const config = { projects: [], repositoryBriefings: briefing(record, ending) } as unknown as Config;
      return { settled: outcome(runRepositoryContext(config, base, adapterOptions(controller.signal))), stop: () => controller.abort() };
    },
  },
  {
    name: "a System tab brief",
    held: /^rejected understanding-output-held$/,
    stopped: /^rejected understanding-process-cancelled$/,
    escalationMs: 500,
    start(record, base, ending) {
      const controller = new AbortController();
      const config = { projects: [], repositoryBriefings: briefing(record, ending) } as unknown as Config;
      const context = { version: 1, repo: base, generatedAt: "2026-11-25T00:00:00.000Z", head: "a".repeat(40), base: null, files: {}, components: [], edges: [], limitations: [] };
      const brief = createUnderstandingAdapter(config).brief!({ workspaceId: "workspace", root: base, repositoryId: "repo", context, base: null, components: [] } as never, adapterOptions(controller.signal));
      return { settled: outcome(brief), stop: () => controller.abort() };
    },
  },
  {
    name: "a session repository brief",
    held: /^rejected .*Reason: output-held$/,
    stopped: /^rejected /,
    escalationMs: 3_000,
    start(record, base, ending) {
      const { root } = checkout(base);
      const manager = {
        state: async () => ({ seq: 1, capabilities: { transcript: 1 } }),
        events: () => ({ events: [{ seq: 1, type: "message", at: "2026-11-25T00:00:00.000Z", data: { id: "probe", role: "user", text: "inspect" } }], cursor: 1, more: false }),
      };
      const briefings = new RepositoryBriefings(briefing(record, ending), manager as never, [{ id: "leader-test", name: "Leader test", path: root } as never]);
      return { settled: outcome(briefings.summarize({ id: "leader-probe", projectId: "leader-test", cwd: root } as never, "0")), stop: () => briefings.close() };
    },
  },
  {
    name: "a cloud executor",
    held: /^resolved/,
    escalationMs: 2_000,
    start(record, base, ending) {
      const started = startCloudExecutor({ cwd: base, command: process.execPath, commandArgs: [LEADER_LEAVES, record, mode(ending, "print"), "ws://127.0.0.1:43210\n"] });
      return { settled: outcome(started.then(executor => executor.exited)), stop: () => started.then(executor => executor.close(), () => undefined) };
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
    const spawnedAt = performance.now();
    const { child, closed } = watched([LEADER_LEAVES, record, "print", "partial"]);
    const leader = watchLeader(child);
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr!.resume();
    const left = await leaderGone(record);
    assert.equal(await within(closed, SETTLE_MS, "the watched child closes"), 0);
    assert.ok(performance.now() - spawnedAt >= EXIT_DRAIN_MS, "the watch waits the drain before it ends the output");
    assert.equal(leader.leftover, true, "the drain, not the holder, ended the output");
    assert.equal(output, "partial");
    assert.equal(gone(left.holder), false, "the holder was not signalled");
    assert.equal(gone(left.witness), false, "the process left in the group was not signalled");
  } finally {
    endLeftBehind(record);
    rmSync(base, { recursive: true, force: true });
  }
});

test("a watched leader whose reader stays paused through the drain is not a leftover and its output arrives whole", CASE, async () => {
  const writer = pausedWriter();
  try {
    await within(writer.exited, 10_000, "the writer exits with its output buffered");
    await pause(EXIT_DRAIN_MS + 500);
    assert.equal(writer.leader.leftover, false, "a paused reader is not a leftover holder");
    writer.release();
    assert.equal(await within(writer.closed, 5_000, "the resumed child closes"), 0);
    assert.equal(writer.size(), BUFFERED);
    assert.equal(writer.leader.leftover, false);
  } finally {
    writer.child.kill("SIGKILL");
  }
});

test("a reader paused when the drain ends and resumed in that loop turn is not a leftover", CASE, async () => {
  const writer = pausedWriter(release => setImmediate(release));
  try {
    assert.equal(await within(writer.closed, 2 * EXIT_DRAIN_MS + 5_000, "the resumed child closes"), 0);
    assert.equal(writer.leader.leftover, false, "a reader paused at the drain's end is not a leftover holder");
    assert.equal(writer.size(), BUFFERED);
  } finally {
    writer.child.kill("SIGKILL");
  }
});

test("a holder whose last bytes arrive as the drain ends and that closes within the drain turns is not a leftover", CASE, async () => {
  const { base } = scratch();
  const flag = join(base, "written");
  const last = "process.on('SIGUSR2', () => { process.stdout.write(Buffer.alloc(8192, 121)); require('node:fs').writeFileSync(process.argv[1], ''); setTimeout(() => process.exit(0), 30); }); process.stderr.write('ready'); setTimeout(() => {}, 30000)";
  const leaderScript = `const holder = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(last)}, ${JSON.stringify(flag)}], { detached: true, stdio: ['ignore', 'inherit', 'pipe'] }); holder.stderr.once('data', () => { holder.stderr.destroy(); holder.unref(); process.stdout.write(holder.pid + '\\n'); });`;
  const { child, closed } = watched(["-e", leaderScript]);
  let output = "", holder = 0;
  child.once("exit", () => setTimeout(() => {
    if (holder > 1) process.kill(holder, "SIGUSR2");
    const deadline = Date.now() + 5_000;
    while (!existsSync(flag) && Date.now() < deadline);
    let turns = 0;
    const slow = () => {
      busy(300);
      if (++turns < 2) setImmediate(slow);
    };
    setImmediate(slow);
  }, EXIT_DRAIN_MS));
  const leader = watchLeader(child);
  child.stdout!.on("data", (chunk: Buffer) => {
    output += chunk.toString("latin1");
    if (!holder && output.includes("\n")) holder = Number.parseInt(output, 10);
  });
  child.stderr!.resume();
  try {
    assert.equal(await within(closed, SETTLE_MS, "the watched child closes"), 0);
    assert.equal(existsSync(flag), true, "the holder wrote its last bytes as the drain ended");
    assert.equal(leader.leftover, false, "bytes still arriving hold the drain open for a few turns");
    assert.equal(output, `${holder}\n${"y".repeat(8192)}`);
  } finally {
    if (holder > 1 && !gone(holder)) process.kill(holder, "SIGKILL");
    rmSync(base, { recursive: true, force: true });
  }
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
        run = place.start(record, base, "exits");
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

test("a stop inside the drain after a signal ended the leader settles the spawner and signals nothing", CASE, async t => {
  for (const place of places.filter(candidate => candidate.stopped)) {
    await t.test(place.name, async st => {
      const { base, record } = scratch();
      let run: Run | undefined, stopped = false, settled = false;
      try {
        run = place.start(record, base, "is killed");
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

test("a stop whose SIGTERM ends a running leader sends no SIGKILL after it, so a group member that ignores SIGTERM outlives the escalation delay", CASE, async t => {
  for (const place of places.filter(candidate => candidate.escalationMs !== undefined)) {
    await t.test(place.name, async () => {
      const { base, record } = scratch();
      let run: Run | undefined, stopped = false;
      try {
        run = place.start(record, base, "runs");
        const { leader, member } = await stubbornMember(record);
        stopped = true;
        const stoppedAt = performance.now();
        const stopping = Promise.resolve(run.stop());
        await until("the leader ends on the SIGTERM", () => gone(leader));
        const settled = await within(run.settled, SETTLE_MS, `${place.name} settles after the stop`);
        if (place.stopped) assert.match(settled, place.stopped);
        await within(stopping, SETTLE_MS, "the stop returns");
        await pause(Math.max(0, stoppedAt + place.escalationMs! + 500 - performance.now()));
        assert.equal(gone(member), false, "the group member that ignores SIGTERM was not signalled after the leader ended");
      } finally {
        endLeftBehind(record);
        if (run && !stopped) await run.stop();
        rmSync(base, { recursive: true, force: true });
      }
    });
  }
});
