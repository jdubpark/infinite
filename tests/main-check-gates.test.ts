import test from "node:test";
import assert from "node:assert/strict";
import { MainCheckService, type MainCheckView } from "../packages/host/src/main-check.js";
import { checksDigest, emptyRecord, type MainCheckRecord } from "../packages/host/src/main-check-state.js";
import type { TeamProject } from "../packages/host/src/team-types.js";
import type { Config } from "../packages/host/src/types.js";
import { Clock, World, type WorldHooks } from "./fixtures/main-check-world.js";
import { rand, type Counts } from "./outcome-sim-script.js";

const ROOT = "/srv/main-check-gates";
const T0 = Date.parse("2026-11-20T08:00:00.000Z");
const HEAD = "a".repeat(40);
const TEAM = { checks: [{ command: "npm", args: ["test"] }] } satisfies TeamProject;
const GATES = ["attempts", "execution-identity", "census-unavailable", "halt", "host-load", "storage", "another-check"] as const;
type Gate = typeof GATES[number];
const readable = (view: MainCheckView | undefined) => view?.readable ? view : undefined;

function projectOf(id: string, setting: boolean) {
  return {
    id, name: id === "alpha" ? "Alpha" : "Beta", path: `${ROOT}/projects/${id}`,
    source: { mode: "github", repository: `example/${id}`, baseBranch: "main" },
    team: { ...structuredClone(TEAM), ...(setting ? { mainCheck: { minutes: 1 } } : {}) },
  };
}

const hooks = (world: () => World): WorldHooks => ({
  write: (projectId, record) => { world().records.set(projectId, JSON.stringify(record)); },
  census: () => undefined,
  remove: () => undefined,
  prepare: mirror => /\/mirrors\/([a-z0-9-]+)\.git$/.exec(mirror)![1]!,
  command: () => undefined,
  limit: () => undefined,
  natureOf: () => ({ nature: { kind: "pass" }, planLength: 1 }),
  otherHead: head => head,
});

async function host(held: ReadonlySet<Gate>, options: { setting?: boolean; records?: Record<string, string> } = {}) {
  let world!: World;
  const counts: Counts = {};
  world = new World(new Clock(T0), rand(1), counts, hooks(() => world));
  const config = {
    stateDir: `${ROOT}/state`,
    projects: [projectOf("alpha", options.setting ?? true), projectOf("beta", true)],
    agents: { claude: held.has("execution-identity") ? { command: "/usr/bin/sudo", args: ["-n", "-u", "agent", "--", "claude"] } : { command: "claude", args: [] } },
    teams: { workspaceDir: `${ROOT}/teams` },
  } as unknown as Config;
  const alpha: MainCheckRecord = {
    ...emptyRecord(),
    observed: { head: HEAD, at: new Date(T0 - 60_000).toISOString() },
    ...(held.has("attempts") ? { attempts: [{ head: HEAD, checks: checksDigest(TEAM), count: 3 }] } : {}),
  };
  world.records.set("alpha", JSON.stringify(alpha));
  if (held.has("another-check")) world.records.set("beta", "{ not json");
  for (const [projectId, text] of Object.entries(options.records ?? {})) world.records.set(projectId, text);
  if (held.has("census-unavailable")) world.faults.census = "fail";
  if (held.has("halt")) world.faults.halt.projects.add("alpha");
  if (held.has("host-load")) world.faults.load = "held";
  if (held.has("storage")) world.faults.storage = "low";
  const ports = world.ports({ id: 1, stopped: false });
  const service = new MainCheckService({ config, key: Buffer.alloc(32, 7), mirrorPath: id => `${ROOT}/mirrors/${id}.git`, halt: ports.halt, hostLoad: ports.hostLoad, ports });
  await service.start();
  for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setImmediate(resolve));
  const record = JSON.parse(world.records.get("alpha")!) as MainCheckRecord;
  return { service, record };
}

test("the first R3 gate that holds is what a project waits on, alone and in every pair", async () => {
  const rows: { held: Gate[]; expected: string }[] = [{ held: [], expected: "admitted" }];
  for (const [index, gate] of GATES.entries()) {
    rows.push({ held: [gate], expected: gate });
    for (const later of GATES.slice(index + 1)) rows.push({ held: [gate, later], expected: gate });
  }
  const actual: string[] = [];
  for (const row of rows) {
    const { service, record } = await host(new Set(row.held));
    const outcome = record.running ? "admitted" : record.waiting ?? "nothing";
    assert.equal(readable(service.view("alpha"))?.waiting, record.waiting, "the view shows what the record holds");
    actual.push(`${row.held.join("+") || "no gate"} -> ${outcome}`);
  }
  assert.deepEqual(actual, rows.map(row => `${row.held.join("+") || "no gate"} -> ${row.expected}`));
  assert.equal(rows.length, 1 + GATES.length + GATES.length * (GATES.length - 1) / 2);
});

test("with the setting off nothing is admitted and nothing is waited on, whatever else holds", async () => {
  for (const held of [new Set<Gate>(), new Set<Gate>(GATES)]) {
    const { service, record } = await host(held, { setting: false });
    assert.equal(record.running, undefined);
    assert.equal(record.waiting, undefined);
    assert.equal(readable(service.view("alpha"))?.enabled, false);
  }
});

test("view: no record, an unreadable record, and a project whose setting is off", async () => {
  const { service } = await host(new Set(), { records: { beta: "{ not json" } });
  assert.equal(service.view("gamma"), undefined, "a project with no record has no view");
  assert.deepEqual(service.view("beta"), { readable: false });
  const alpha = service.view("alpha");
  assert.equal(alpha?.readable, true);
  assert.equal(alpha?.enabled, true);
  assert.equal(alpha?.waiting, "another-check", "an unreadable record holds every admission back");
  const off = await host(new Set(), { setting: false });
  const view = off.service.view("alpha");
  assert.equal(view?.readable, true);
  assert.equal(view?.enabled, false);
  assert.equal(view?.observed?.head, HEAD);
});
