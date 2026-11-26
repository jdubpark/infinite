import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signalGroup, spawnGroup, terminateGroup, watchLeader } from "../packages/host/src/process-group.js";
import { SUPERVISOR_GRACE_MS, supervisorArgs } from "../packages/host/src/group-supervisor.js";
import { EXIT_DRAIN_MS } from "../packages/host/src/team-workspace.js";
import { blobReader } from "../packages/host/src/git-stream.js";
import { captureGit } from "../packages/host/src/eval-git.js";
import { RepositoryGraphs } from "../packages/host/src/repository-graphs.js";
import { runRepositoryContext } from "../packages/host/src/understanding-runtime.js";
import { createUnderstandingAdapter } from "../packages/host/src/understanding-adapter.js";
import { RepositoryBriefings } from "../packages/host/src/repository-briefings.js";
import { startCloudExecutor } from "../packages/host/src/cloud-executor.js";
import type { Config } from "../packages/host/src/types.js";
import { LEADER_LEAVES, endLeftBehind, gone, groupSignals, leaderGone, leftBehind, stubbornMember, until, within } from "./leader-exit.js";

const CASE = { timeout: 600_000, skip: process.platform === "win32" && "process groups are POSIX" };
const SETTLE_MS = EXIT_DRAIN_MS + 5_000;
const BUFFERED = 131_072;
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const AUTHOR = ["-c", "user.name=Example", "-c", "user.email=dev@example.invalid"];

type Ending = "exits" | "is killed" | "runs" | "ignores SIGTERM" | "leaves its group empty";
type Run = { settled: Promise<string>; stop(): unknown };
type Place = { name: string; held: RegExp; stopped?: RegExp; graceMs: number; start(record: string, base: string, ending: Ending): Run };
const ENDINGS: Record<Ending, string> = { exits: "", "is killed": "-killed", runs: "-running", "ignores SIGTERM": "-stubborn", "leaves its group empty": "-alone" };

function mode(ending: Ending, action: "print" | "exec") {
  return `${action}${ENDINGS[ending]}`;
}

function scratch() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "leader-exit-")));
  return { base, record: join(base, "record") };
}

function checkout(base: string) {
  const root = join(base, "checkout");
  mkdirSync(root);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root, env: GIT_ENV });
  writeFileSync(join(root, "a.txt"), "content\n");
  execFileSync("git", ["add", "a.txt"], { cwd: root, env: GIT_ENV });
  execFileSync("git", [...AUTHOR, "commit", "-q", "-m", "base"], { cwd: root, env: GIT_ENV });
  return { root, head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, env: GIT_ENV, encoding: "utf8" }).trim() };
}

function changed(root: string) {
  writeFileSync(join(root, "a.txt"), "changed\n");
  execFileSync("git", [...AUTHOR, "commit", "-q", "-am", "change"], { cwd: root, env: GIT_ENV });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, env: GIT_ENV, encoding: "utf8" }).trim();
}

function watched(args: string[]) {
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  return { child, closed: new Promise<number | null>(done => child.once("close", done)) };
}

function besideDrain(callback: () => void) {
  const due = performance.now() + EXIT_DRAIN_MS;
  const guard = setTimeout(() => {
    while (performance.now() < due + 50);
  }, EXIT_DRAIN_MS - 200);
  const timer = setTimeout(callback, EXIT_DRAIN_MS);
  return () => {
    clearTimeout(guard);
    clearTimeout(timer);
  };
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
  if (atDrainEnd) child.once("exit", () => besideDrain(() => atDrainEnd(release)));
  const exited = new Promise(done => child.once("exit", done));
  const leader = watchLeader(child);
  out.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (hold) out.pause();
  });
  child.stderr!.resume();
  return { child, leader, exited, closed, release, size: () => size };
}

const LATE_HOLDER = "const fs = require('node:fs'); const [flag, ...steps] = process.argv.slice(1); let taken = 0; process.on('SIGUSR2', () => { const step = steps[taken++] ?? ''; if (step.includes('w')) process.stdout.write(Buffer.alloc(4096, 121)); if (step.includes('c')) fs.closeSync(1); fs.writeFileSync(flag + '.' + taken, ''); if (step.includes('c')) process.exit(0); }); process.stderr.write('ready'); setTimeout(() => {}, 30000)";

function lateHolder(steps: string[], atDrainEnd: (step: () => void) => void) {
  const { base } = scratch();
  const flag = join(base, "step");
  const leaderScript = `const holder = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(LATE_HOLDER)}, ${JSON.stringify(flag)}, ...${JSON.stringify(steps)}], { detached: true, stdio: ['ignore', 'inherit', 'pipe'] }); holder.stderr.once('data', () => { holder.stderr.destroy(); holder.unref(); process.stdout.write(holder.pid + '\\n'); });`;
  const { child, closed } = watched(["-e", leaderScript]);
  let output = "", holder = 0, taken = 0, ended = false, cancel = () => {};
  const step = () => {
    if (ended || holder <= 1 || gone(holder)) return;
    taken += 1;
    process.kill(holder, "SIGUSR2");
    const deadline = Date.now() + 5_000;
    while (!existsSync(`${flag}.${taken}`) && Date.now() < deadline);
  };
  child.once("exit", () => { cancel = besideDrain(() => atDrainEnd(step)); });
  const leader = watchLeader(child);
  child.stdout!.on("data", (chunk: Buffer) => {
    output += chunk.toString("latin1");
    if (!holder && output.includes("\n")) holder = Number.parseInt(output, 10);
  });
  child.stderr!.resume();
  const everyStep = () => steps.every((_, index) => existsSync(`${flag}.${index + 1}`));
  const end = () => {
    ended = true;
    cancel();
    if (holder > 1 && !gone(holder)) process.kill(holder, "SIGKILL");
    rmSync(base, { recursive: true, force: true });
  };
  return { child, closed, leader, step, output: () => output, holder: () => holder, everyStep, end };
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
    graceMs: 0,
    start(record, base, ending) {
      const { root, head } = checkout(base);
      const controller = new AbortController();
      const reader = blobReader(() => ({ command: process.execPath, args: [LEADER_LEAVES, record, mode(ending, "exec")] }));
      return { settled: outcome(reader.read(root, head, "a.txt", controller.signal)), stop: () => controller.abort() };
    },
  },
  {
    name: "a Git patch read that names a missing commit",
    held: /^resolved \{"state":"failed"\}$/,
    stopped: /^resolved \{"state":"failed"\}$/,
    graceMs: 0,
    start(record, base, ending) {
      const { root, head } = checkout(base);
      const git = captureGit(() => ({ command: process.execPath, args: [LEADER_LEAVES, record, mode(ending, "exec")] }));
      return { settled: outcome(git.patch(root, head, "0".repeat(40))), stop: () => git.close() };
    },
  },
  {
    name: "a repository graph build",
    held: /left a process holding its output/,
    stopped: /closed before refresh completed/,
    graceMs: 2_000,
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
    graceMs: 500,
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
    graceMs: 500,
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
    graceMs: 3_000,
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
    graceMs: SUPERVISOR_GRACE_MS,
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
    const { child, closed } = watched([LEADER_LEAVES, record, "print", "partial"]);
    const leader = watchLeader(child);
    let output = "", exitedAt = 0;
    child.once("exit", () => { exitedAt = performance.now(); });
    child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr!.resume();
    const left = await leaderGone(record);
    assert.equal(await within(closed, SETTLE_MS, "the watched child closes"), 0);
    const waited = performance.now() - exitedAt;
    assert.ok(waited >= EXIT_DRAIN_MS - 50, `the watch waits the drain after the leader's exit before it ends the output, not ${Math.round(waited)} ms`);
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

test("a reader that pauses on bytes read after the drain ends is not a leftover and its output arrives whole", CASE, async () => {
  let armed = false;
  const late = lateHolder(["w", "c"], step => {
    armed = true;
    step();
  });
  late.child.stdout!.on("data", () => {
    if (!armed) return;
    armed = false;
    late.child.stdout!.pause();
    setTimeout(() => {
      late.child.stdout!.resume();
      late.step();
    }, 500);
  });
  try {
    assert.equal(await within(late.closed, 2 * EXIT_DRAIN_MS + 5_000, "the watched child closes"), 0);
    assert.equal(late.leader.leftover, false, "a reader that backpressure paused after the drain ended is not a leftover holder");
    assert.equal(late.output(), `${late.holder()}\n${"y".repeat(4096)}`);
    assert.equal(late.everyStep(), true, "the holder wrote as the drain ended and closed after the reader resumed");
  } finally {
    late.end();
  }
});

test("a reader paused at a drain's end and again on a late chunk re-arms the drain each time and still finds the holder one drain later", CASE, async () => {
  let armed = false;
  const late = lateHolder(["w"], step => {
    const out = late.child.stdout!;
    out.pause();
    setTimeout(() => out.resume(), 500);
    besideDrain(() => {
      armed = true;
      step();
    });
  });
  late.child.stdout!.on("data", () => {
    if (!armed) return;
    armed = false;
    late.child.stdout!.pause();
    setTimeout(() => late.child.stdout!.resume(), 500);
  });
  try {
    assert.equal(await within(late.closed, 3 * EXIT_DRAIN_MS + 5_000, "the watched child closes"), 0);
    assert.equal(late.everyStep(), true, "the holder wrote its late chunk and kept the output open");
    assert.equal(late.leader.leftover, true, "the drain after the last resume ends the output the holder keeps open");
    assert.equal(late.output(), `${late.holder()}\n${"y".repeat(4096)}`);
  } finally {
    late.end();
  }
});

test("bytes arriving in each of the first two drain turns hold the output open until it ends in the third", CASE, async () => {
  const late = lateHolder(["w", "w", "c"], step => {
    step();
    setImmediate(() => {
      step();
      setImmediate(step);
    });
  });
  try {
    assert.equal(await within(late.closed, SETTLE_MS, "the watched child closes"), 0);
    assert.equal(late.leader.leftover, false, "an output that ends in the third turn is not a leftover");
    assert.equal(late.output(), `${late.holder()}\n${"y".repeat(8192)}`);
    assert.equal(late.everyStep(), true, "the holder wrote in two turns and closed in the third");
  } finally {
    late.end();
  }
});

test("the executor supervisor ends a group member that ignores SIGTERM when stopped, and exits with its leader without signalling after it", CASE, async () => {
  const running = scratch(), exited = scratch();
  try {
    const live = spawn(process.execPath, supervisorArgs(process.execPath, [LEADER_LEAVES, running.record, "print-running", "ready\n"], {}), { stdio: ["pipe", "pipe", "pipe"] });
    live.stdout.resume();
    live.stderr.resume();
    const liveExit = new Promise(done => live.once("exit", done));
    const { member } = await stubbornMember(running.record);
    live.stdin.end();
    await Promise.all([
      within(liveExit, SETTLE_MS, "the stopped supervisor exits"),
      until("the group member that ignores SIGTERM ends", () => gone(member), SUPERVISOR_GRACE_MS + 3_000),
    ]);

    const ended = spawn(process.execPath, supervisorArgs(process.execPath, [LEADER_LEAVES, exited.record, "print", "ready\n"], {}), { stdio: ["pipe", "pipe", "pipe"] });
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
        try {
          if (run && !stopped) await run.stop();
        } finally {
          endLeftBehind(record);
          rmSync(base, { recursive: true, force: true });
        }
      }
    });
  }
});

test("a patch read whose escaped holder keeps only stderr open fails instead of returning the patch", CASE, async () => {
  const { base, record } = scratch();
  const git = captureGit(() => ({ command: process.execPath, args: [LEADER_LEAVES, record, "exec-stderr"] }));
  try {
    const { root, head } = checkout(base);
    const settled = outcome(git.patch(root, head, changed(root)));
    const left = await leaderGone(record);
    assert.equal(await within(settled, SETTLE_MS, "the patch read settles after its leader exits"), 'resolved {"state":"failed"}');
    assert.equal(gone(left.holder), false, "the holder that keeps stderr open runs on");
  } finally {
    git.close();
    endLeftBehind(record);
    rmSync(base, { recursive: true, force: true });
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
        try {
          if (run && !stopped) await run.stop();
        } finally {
          endLeftBehind(record);
          rmSync(base, { recursive: true, force: true });
        }
      }
    });
  }
});

test("a stop ends the leader and a group member that ignores SIGTERM within the place's grace, whether the leader obeys SIGTERM or ignores it", CASE, async t => {
  for (const place of places) {
    for (const ending of ["runs", "ignores SIGTERM"] as const) {
      await t.test(`${place.name} whose leader ${ending}`, async () => {
        const { base, record } = scratch();
        let run: Run | undefined, stopped = false;
        try {
          run = place.start(record, base, ending);
          const { leader, member } = await stubbornMember(record);
          stopped = true;
          const stopping = Promise.resolve(run.stop());
          await until("the leader and its group member that ignores SIGTERM end", () => gone(leader) && gone(member), place.graceMs + 3_000);
          const settled = await within(run.settled, SETTLE_MS, `${place.name} settles after the stop`);
          if (place.stopped) assert.match(settled, place.stopped);
          await within(stopping, SETTLE_MS, "the stop returns");
        } finally {
          try {
            if (run && !stopped) await run.stop();
          } finally {
            endLeftBehind(record);
            rmSync(base, { recursive: true, force: true });
          }
        }
      });
    }
  }
});

test("a stop after the leader has ended and left its group empty sends that group no signal", CASE, async t => {
  for (const place of places.filter(candidate => candidate.stopped)) {
    await t.test(place.name, async st => {
      const { base, record } = scratch();
      let run: Run | undefined, stopped = false, settled = false;
      try {
        run = place.start(record, base, "leaves its group empty");
        void run.settled.then(() => { settled = true; });
        const left = await leaderGone(record);
        if (settled) {
          st.skip("the spawner settled before the test could stop it inside the drain");
          return;
        }
        const signals = groupSignals(left.group);
        try {
          stopped = true;
          const stopping = Promise.resolve(run.stop());
          assert.match(await within(run.settled, SETTLE_MS, `${place.name} settles after the stop`), place.stopped!);
          await within(stopping, SETTLE_MS, "the stop returns");
          await pause(place.graceMs + 500);
        } finally {
          signals.restore();
        }
        assert.deepEqual(signals.sent, [], "no signal went to the emptied group after its leader ended");
      } finally {
        try {
          if (run && !stopped) await run.stop();
        } finally {
          endLeftBehind(record);
          rmSync(base, { recursive: true, force: true });
        }
      }
    });
  }
});

function report(child: ChildProcess, input?: string) {
  return new Promise<string>(done => {
    let out = "", err = "";
    child.stdout!.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.stderr!.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
    child.once("error", error => done(`error ${(error as NodeJS.ErrnoException).code}`));
    child.once("close", (code, signal) => done(JSON.stringify({ code, signal, out, err })));
    child.stdin!.on("error", () => {});
    child.stdin!.end(input);
  });
}

test("a grouped spawn reports the status, signal, output and missing command that a direct spawn reports", CASE, async () => {
  const stdio: StdioOptions = ["pipe", "pipe", "pipe"];
  for (const script of ["exit 0", "exit 3", "printf out; printf err >&2; exit 4", "cat", "kill -s TERM $$", "kill -s KILL $$", "kill -s USR1 $$", "kill -s PIPE $$"]) {
    const direct = await report(spawn("/bin/sh", ["-c", script], { stdio }), "input");
    assert.equal(await report(spawnGroup("/bin/sh", ["-c", script], { stdio }, 500), "input"), direct, script);
  }
  const missing = "no-such-command-for-a-grouped-spawn";
  assert.equal(await report(spawnGroup(missing, [], { stdio }, 500)), await report(spawn(missing, [], { stdio })));
});

test("a grouped stop closes the caller's pipes well before its grace, because the sleeper it leaves holds none of them", CASE, async () => {
  const graceMs = 5_000;
  const child = spawnGroup(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], { stdio: ["pipe", "pipe", "pipe"] }, graceMs);
  const closed = new Promise<number>(done => child.once("close", () => done(Date.now())));
  await new Promise<void>((ready, fail) => { child.stdout!.once("data", () => ready()); child.once("error", fail); });
  const stopped = Date.now();
  terminateGroup(child, graceMs);
  const elapsed = (await closed) - stopped;
  assert.ok(elapsed < graceMs / 2, `close arrived ${elapsed} ms after the stop, with a grace of ${graceMs} ms`);
});

test("a grouped spawn refuses a fourth stdio entry and an ipc entry, because its anchor keeps the caller's stderr on descriptor 3", () => {
  const refused: StdioOptions[] = [["pipe", "pipe", "pipe", "pipe"], ["ignore", "pipe", "pipe", "ipc"], ["ignore", "pipe", "ipc"]];
  for (const stdio of refused) assert.throws(() => spawnGroup(process.execPath, ["-e", ""], { stdio }, 500), /descriptor 3/, JSON.stringify(stdio));
});
