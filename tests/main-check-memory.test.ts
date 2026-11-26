import test from "node:test";
import assert from "node:assert/strict";
import { MainCheckService, type MainCheckPorts } from "../packages/host/src/main-check.js";
import { emptyRecord, type MainCheckRecord } from "../packages/host/src/main-check-state.js";
import type { TeamProject } from "../packages/host/src/team-types.js";
import type { CommandResult } from "../packages/host/src/team-workspace.js";
import type { Config } from "../packages/host/src/types.js";
import { Clock, World, type WorldHooks } from "./fixtures/main-check-world.js";
import { rand } from "./outcome-sim-script.js";

const ROOT = "/srv/main-check-memory";
const T0 = Date.parse("2026-11-20T08:00:00.000Z");
const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const TEAM = { checks: [{ command: "npm", args: ["test"] }], mainCheck: { minutes: 1 } } satisfies TeamProject;
const PASS_MS = 30_000;
const turns = async () => { for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setImmediate(resolve)); };
const observed = (): MainCheckRecord => ({ ...emptyRecord(), observed: { head: HEAD, at: new Date(T0 - 60_000).toISOString() } });

type Refusal = (next: MainCheckRecord, before: MainCheckRecord | undefined) => boolean;

class Host {
  readonly clock = new Clock(T0);
  readonly world: World;
  readonly calls = { prepare: 0, command: 0, refused: 0, assertClean: 0 };
  refuse?: Refusal;
  service!: MainCheckService;

  constructor() {
    const hooks: WorldHooks = {
      write: (projectId, record) => {
        if (this.refuse?.(record, this.record(projectId))) {
          this.calls.refused += 1;
          throw new Error("The record could not be written.");
        }
        this.world.records.set(projectId, JSON.stringify(record));
      },
      census: () => undefined,
      remove: () => undefined,
      prepare: mirror => {
        this.calls.prepare += 1;
        return /\/mirrors\/([a-z0-9-]+)\.git$/.exec(mirror)![1]!;
      },
      command: () => { this.calls.command += 1; },
      limit: () => undefined,
      natureOf: () => ({ nature: { kind: "pass" }, planLength: 1 }),
      otherHead: head => head,
    };
    this.world = new World(this.clock, rand(1), {}, hooks);
  }

  record(projectId = "alpha"): MainCheckRecord | undefined {
    const text = this.world.records.get(projectId);
    return text === undefined ? undefined : JSON.parse(text) as MainCheckRecord;
  }

  async start(record: MainCheckRecord, ports: Partial<MainCheckPorts> = {}) {
    this.world.records.set("alpha", JSON.stringify(record));
    const config = {
      stateDir: `${ROOT}/state`,
      projects: [{ id: "alpha", name: "Alpha", path: `${ROOT}/projects/alpha`, source: { mode: "github", repository: "example/alpha", baseBranch: "main" }, team: structuredClone(TEAM) }],
      agents: { claude: { command: "claude", args: [] } },
      teams: { workspaceDir: `${ROOT}/teams` },
    } as unknown as Config;
    const world = this.world.ports({ id: 1, stopped: false });
    const assertClean: MainCheckPorts["assertClean"] = async (...args) => {
      this.calls.assertClean += 1;
      return world.assertClean(...args);
    };
    this.service = new MainCheckService({ config, key: Buffer.alloc(32, 7), mirrorPath: id => `${ROOT}/mirrors/${id}.git`, halt: world.halt, hostLoad: world.hostLoad, ports: { ...world, assertClean, ...ports } });
    await this.service.start();
    await turns();
  }

  observe(head: string) {
    this.service.observe({ projectId: "alpha", repository: "example/alpha", baseBranch: "main", head, fetchedAt: new Date(this.clock.now).toISOString() });
  }

  view() {
    const view = this.service.view("alpha");
    assert.ok(view?.readable, "alpha's record reads");
    return view;
  }

  async advance(ms: number) {
    const target = this.clock.now + ms;
    for (let timer = this.clock.take(target); timer; timer = this.clock.take(target)) {
      this.clock.now = timer.at;
      timer.fn();
      await turns();
    }
    this.clock.now = target;
    await turns();
  }
}

test("an observation whose write throws leaves memory as it was, and the fetch repeated once writes work lands", async () => {
  const host = new Host();
  host.world.faults.halt.projects.add("alpha");
  await host.start(observed());
  const before = structuredClone(host.view());
  const disk = host.world.records.get("alpha");
  host.refuse = () => true;
  host.clock.now += 1_000;
  host.observe(NEXT);
  await turns();
  assert.equal(host.calls.refused, 1, "the observation was written and refused");
  assert.deepEqual(host.view(), before, "the view is what the last landed write holds");
  assert.equal(host.world.records.get("alpha"), disk);
  host.refuse = undefined;
  host.observe(NEXT);
  await turns();
  assert.equal(host.view().observed?.head, NEXT, "the repeated fetch is observed");
  assert.equal(host.record()?.observed?.head, NEXT);
});

test("an admission whose write throws prepares no copy and starts no command; the next pass, with writes working, admits", async () => {
  const host = new Host();
  host.refuse = (next, before) => next.running !== undefined && before?.running === undefined;
  await host.start(observed());
  assert.ok(host.calls.refused >= 1, "the pass at start tried to admit");
  const refused = host.calls.refused;
  await host.advance(5_000);
  assert.deepEqual([host.calls.prepare, host.calls.command], [0, 0], "no copy and no command");
  assert.equal(host.view().running, undefined);
  assert.deepEqual(host.view().attempts, [], "nothing was charged");
  assert.equal(host.record()?.running, undefined);
  assert.equal(host.record()?.attempts, undefined);
  host.refuse = undefined;
  await host.advance(T0 + PASS_MS - host.clock.now);
  assert.equal(host.calls.refused, refused, "no write was refused after the writes worked again");
  assert.equal(host.record()?.running?.head, HEAD, "the next pass admitted the head");
  assert.equal(host.view().running?.head, HEAD);
  assert.equal(host.calls.prepare, 1, "and started its copy");
  await host.advance(5_000);
  assert.equal(host.calls.command, 1, "and ran its check");
  assert.equal(host.view().last?.outcome, "passed");
});

test("a stop that lands after a command's leader exited ends the check by that stop, with no Git helper after it", async () => {
  const host = new Host();
  let ran = 0;
  const run: MainCheckPorts["run"] = (_command, _cwd, signal) => new Promise<CommandResult>(resolve => {
    ran += 1;
    signal?.addEventListener("abort", () => resolve({ exitCode: 0, output: "", stdout: "", interrupted: false, truncated: true }), { once: true });
  });
  await host.start(observed(), { run });
  await host.advance(5_000);
  assert.equal(ran, 1, "the check's command runs");
  host.world.faults.halt.projects.add("alpha");
  await host.advance(2_500);
  const last = host.record()?.last;
  assert.equal(`${last?.outcome}/${last?.reason}`, "interrupted/halt");
  assert.deepEqual(last?.commands.map(command => [command.status, command.exitCode]), [["passed", 0]], "the command's own ending is recorded");
  assert.equal(host.calls.assertClean, 0, "the copy was not checked after the stop");
  assert.equal(ran, 1);
});

const ANCHOR_ROOT = `${ROOT}/teams`;
type Anchor = { version: number; boot: string; processes: { pid: number; start: string }[] };
const anchorIn = (host: Host, directory: string): Anchor | undefined => {
  const stored = host.world.anchors.get(directory);
  return stored === undefined ? undefined : JSON.parse(stored.text) as Anchor;
};
const retiringOf = (host: Host) => host.record()?.retiring?.length ?? 0;

async function admitted(host: Host) {
  await host.start(observed());
  const directory = host.record()?.running?.directory;
  assert.ok(directory, "the head was admitted at start");
  return directory;
}

async function untilRetired(host: Host, rounds = 3) {
  for (let round = 0; round < rounds && retiringOf(host) + (host.record()?.running ? 1 : 0) > 0; round += 1) await host.advance(PASS_MS);
}

test("a process hidden before the admission does not hold the copy: its anchor excuses it, and the anchor goes with the copy (INF-403)", async () => {
  const host = new Host();
  const earlier = host.world.hide();
  const directory = await admitted(host);
  assert.deepEqual(anchorIn(host, directory), { version: 1, boot: "boot-1", processes: [{ pid: earlier, start: `boot-1:${earlier}` }] });
  await untilRetired(host);
  assert.equal(retiringOf(host), 0, "the copy retired");
  assert.equal(host.world.runs.get(`${ANCHOR_ROOT}/${directory}`)?.exists, false, "the copy was removed");
  assert.equal(host.world.anchors.size, 0, "its anchor was deleted");
  assert.equal(host.world.processes.has(earlier), true, "the hidden process still runs");
});

test("with one thing changed from an anchored admission, the copy waits until that process ends (INF-403)", async () => {
  const changes: [string, (host: Host, earlier: number, directory: string) => number][] = [
    ["a process hidden after the admission", host => host.world.hide()],
    ["the anchored pid reused by a process of the run", (host, earlier, directory) => {
      host.world.end(earlier);
      return host.world.hide(`${ANCHOR_ROOT}/${directory}`, earlier);
    }],
    ["an anchor of another boot", (host, earlier, directory) => {
      host.world.anchors.set(directory, { projectId: "alpha", text: JSON.stringify({ ...anchorIn(host, directory), boot: "boot-0" }) });
      return earlier;
    }],
    ["no anchor", (host, earlier, directory) => {
      host.world.anchors.delete(directory);
      return earlier;
    }],
    ["an anchor sealed for another project", (host, earlier, directory) => {
      host.world.anchors.set(directory, { projectId: "beta", text: host.world.anchors.get(directory)!.text });
      return earlier;
    }],
  ];
  for (const [name, change] of changes) {
    const host = new Host();
    const earlier = host.world.hide();
    const directory = await admitted(host);
    const holder = change(host, earlier, directory);
    await untilRetired(host);
    assert.equal(retiringOf(host), 1, `${name}: the copy waits`);
    assert.equal(host.view().waiting, "processes", name);
    assert.equal(host.world.runs.get(`${ANCHOR_ROOT}/${directory}`)?.exists, true, `${name}: the copy stays`);
    host.world.end(holder);
    await host.advance(PASS_MS);
    assert.equal(retiringOf(host), 0, `${name}: the copy retires once that process ended`);
  }
});

test("a retirement whose record write fails keeps the anchor, so the copy retires at a later pass (INF-403)", async () => {
  const host = new Host();
  const earlier = host.world.hide();
  const directory = await admitted(host);
  host.refuse = (next, before) => host.calls.refused === 0 && (next.retiring?.length ?? 0) < (before?.retiring?.length ?? 0);
  for (let second = 0; second < 120 && host.calls.refused === 0; second += 1) await host.advance(1_000);
  assert.equal(host.calls.refused, 1, "the retirement's write was refused");
  assert.equal(host.world.runs.get(`${ANCHOR_ROOT}/${directory}`)?.exists, false, "the copy was removed");
  assert.equal(retiringOf(host), 1, "the record still holds the entry");
  assert.deepEqual(anchorIn(host, directory)?.processes, [{ pid: earlier, start: `boot-1:${earlier}` }], "the anchor stays while the record holds the entry");
  await host.advance(PASS_MS);
  assert.equal(retiringOf(host), 0, "the next pass retired it");
  assert.equal(host.world.anchors.size, 0);
});

test("an anchor no record holds is swept at start once every record reads, and an anchor of a held entry stays (INF-403)", async () => {
  const host = new Host();
  const held = "alpha-2026-11-20-main-check-0000beef";
  const orphan = "alpha-2026-11-20-main-check-0000dead";
  const text = JSON.stringify({ version: 1, boot: "boot-1", processes: [{ pid: 5, start: "boot-1:5" }] });
  host.world.anchors.set(held, { projectId: "alpha", text });
  host.world.anchors.set(orphan, { projectId: "alpha", text });
  host.world.records.set("beta", "{ not json");
  host.world.hide();
  await host.start({ ...emptyRecord(), retiring: [{ directory: held, root: ANCHOR_ROOT, witness: { boot: "boot-1", processes: [], sessions: [], groups: [] } }] });
  assert.equal(retiringOf(host), 1, "a hidden process the anchor does not hold keeps the entry");
  assert.deepEqual([...host.world.anchors.keys()].sort(), [held, orphan], "nothing is swept while a record cannot be read");
  host.world.records.set("beta", JSON.stringify(emptyRecord()));
  await host.advance(PASS_MS);
  assert.deepEqual([...host.world.anchors.keys()], [held], "the orphan is swept and the held entry's anchor stays");
});

test("an anchor keeps the first 256 hidden processes; the rest hold the copy until they end (INF-403)", async () => {
  const host = new Host();
  const hidden = Array.from({ length: 300 }, () => host.world.hide());
  const directory = await admitted(host);
  assert.deepEqual(anchorIn(host, directory)?.processes.map(item => item.pid), hidden.slice(0, 256));
  await untilRetired(host);
  assert.equal(retiringOf(host), 1, "the 44 processes past the cut hold the copy");
  for (const pid of hidden.slice(256)) host.world.end(pid);
  await host.advance(PASS_MS);
  assert.equal(retiringOf(host), 0);
});

test("after a boot change a hidden process holds no copy on Linux, and on macOS the copy waits as before (INF-403)", async () => {
  const outcomes: [NodeJS.Platform, number][] = [["linux", 0], ["darwin", 1]];
  for (const [platform, left] of outcomes) {
    const host = new Host();
    host.world.hide();
    await host.start({ ...emptyRecord(), retiring: [{ directory: "alpha-2026-11-20-main-check-0000b007", root: ANCHOR_ROOT, witness: { boot: "boot-0", processes: [], sessions: [], groups: [] } }] }, { platform });
    await host.advance(PASS_MS);
    assert.equal(retiringOf(host), left, platform);
  }
});
