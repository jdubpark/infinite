import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepositoryGraphs } from "../packages/host/src/repository-graphs.js";
import type { Config } from "../packages/host/src/types.js";
import { waitFor } from "./helpers.js";

const headA = "a".repeat(40), headB = "b".repeat(40);
const codeMap = {
  areas: [{ id: "apps/web/src", files: 2, symbols: 7 }, { id: "packages/host/src", files: 3, symbols: 11 }],
  links: [{ source: "apps/web/src", target: "packages/host/src", weight: 4 }],
  truncated: { areas: false, links: false },
};

function fixture(mode = "ready") {
  const root = mkdtempSync(join(tmpdir(), "repository-graphs-"));
  const project = join(root, "project"), workspaces = join(root, "workspaces"), first = join(workspaces, "run-one", "member-one"), second = join(workspaces, "run-one", "member-two");
  for (const path of [project, first, second]) mkdirSync(path, { recursive: true });
  const receiptFile = join(root, "receipts.jsonl"), started = join(root, "started");
  const receiptExtras: Record<string, Record<string, unknown>> = {
    map: { map: codeMap },
    "bad-map": { map: { ...codeMap, areas: [{ id: "packages/host/src", files: 1.5, symbols: 2 }] } },
    "too-large": { mapStatus: "too-large" },
    "map-fail-a": { map: codeMap },
    "many-areas": { map: { areas: Array.from({ length: 121 }, (_, index) => ({ id: `dir${index}`, files: 1, symbols: 1 })), links: [], truncated: { areas: false, links: false } } },
  };
  const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(1);
const value = key => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
const ref = value("--ref"), cache = value("--cache-dir"), log = args[0], mode = args[1];
fs.mkdirSync(cache, { recursive: true });
fs.writeFileSync(path.join(cache, "graph.json"), "{}\n");
fs.appendFileSync(log, JSON.stringify({ ref, cache, seed: value("--seed-cache-dir"), repo: value("--repo") }) + "\n");
fs.writeFileSync(${JSON.stringify(started)}, ref);
if (ref === ${JSON.stringify(headA)}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
// Valid in shape and inside the receipt limit, yet over the map's own byte budget: 400 links with 300-character two-byte names.
// Built here, because a command-line argument this large is refused on Linux.
const hugeMap = mode !== "huge-map" ? {} : { map: { areas: [], links: Array.from({ length: 400 }, (_, index) => ({ source: "\u00e9".repeat(296) + String(index).padStart(4, "0"), target: "\u00e8".repeat(300), weight: 1 })), truncated: { areas: false, links: false } } };
const failing = mode === "fail" || (mode === "map-fail-a" && ref === ${JSON.stringify(headA)});
const status = failing ? "failed" : "ready";
process.stdout.write(JSON.stringify({ status, requestedHead: ref, head: mode === "mismatch" ? ${JSON.stringify(headA)} : ref, graphPath: path.join(cache, "graph.json"), mode: "incremental", changedFiles: 1, deletedFiles: 0, ...${JSON.stringify(receiptExtras[mode] ?? {})}, ...hugeMap }) + "\n");
if (failing || mode === "nonzero-ready") process.exit(2);
`;
  const projects = [{ id: "sample-project", name: "Sample", path: project, team: {} }] as Config["projects"];
  const service = new RepositoryGraphs({ command: process.execPath, args: ["-e", script, receiptFile, mode], graphifyCommand: "graphify", cacheDir: join(root, "cache"), timeoutMs: 3000, debounceMs: 15, intervalMs: 86_400_000 }, projects, workspaces);
  return { root, project, first, second, receiptFile, started, service, projects };
}

test("nearby requests coalesce and a changed head during a build gets its own current receipt", { timeout: 15000 }, async () => {
  const f = fixture();
  try {
    const firstA = f.service.refresh("sample-project", f.first, headA, "run-one");
    const duplicateA = f.service.refresh("sample-project", f.first, headA, "run-one");
    await waitFor(() => Promise.resolve(existsSync(f.started)), Boolean, 3000);
    const latestB = f.service.refresh("sample-project", f.second, headB, "run-one");
    const [oldOne, oldDuplicate, latest] = await Promise.all([firstA, duplicateA, latestB]);
    assert.equal(oldOne.head, headA);
    assert.equal(oldDuplicate.head, headA);
    assert.equal(latest.head, headB);
    assert.equal(latest.status, "ready");
    const calls = readFileSync(f.receiptFile, "utf8").trim().split("\n").map(line => JSON.parse(line) as { ref: string; cache: string; seed?: string; repo: string });
    assert.deepEqual(calls.map(call => call.ref), [headA, headB]);
    assert.equal(calls[0].cache, calls[1].cache, "members in one run reuse the run lane cache");
    assert.ok(calls[0].seed?.endsWith("/shared"), "the feature lane seeds its first build from the project graph cache");
    assert.equal(calls[1].repo, realpathSync(f.second), "the newer checkout path is used for the newer head");
    assert.equal(f.service.status("sample-project").at(-1)?.result.head, headB);
    const shared = await f.service.refresh("sample-project", f.project, headB, "shared");
    assert.equal(shared.status, "ready");
    const allCalls = readFileSync(f.receiptFile, "utf8").trim().split("\n").map(line => JSON.parse(line) as { cache: string; seed?: string });
    assert.notEqual(allCalls[2].cache, allCalls[1].cache, "the shared project lane stays separate from the feature lane");
    assert.equal(allCalls[2].seed, undefined);
  } finally { f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("a newer request before debounce settles the superseded waiter instead of stranding it", { timeout: 15000 }, async () => {
  const f = fixture();
  try {
    const superseded = f.service.refresh("sample-project", f.first, headA, "run-one");
    const latest = f.service.refresh("sample-project", f.first, headB, "run-one");
    const [oldResult, newResult] = await Promise.all([superseded, latest]);
    assert.equal(oldResult.status, "failed");
    assert.match(oldResult.reason ?? "", /superseded/);
    assert.equal(newResult.head, headB);
    const calls = readFileSync(f.receiptFile, "utf8").trim().split("\n").map(line => JSON.parse(line) as { ref: string });
    assert.deepEqual(calls.map(call => call.ref), [headB]);
  } finally { f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("builder failure and a receipt for another head remain advisory unavailable results", { timeout: 15000 }, async () => {
  for (const mode of ["fail", "mismatch", "nonzero-ready"]) {
    const f = fixture(mode);
    try {
      const result = await f.service.refresh("sample-project", f.project, headB, "shared");
      assert.equal(result.status, "failed");
      assert.equal(result.requestedHead, headB);
      if (mode === "mismatch") assert.notEqual(result.head, result.requestedHead);
    } finally { f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("project filters and changed project-root authority stop graph execution", async () => {
  const f = fixture();
  try {
    const filtered = new RepositoryGraphs({ command: process.execPath, args: ["-e", "process.exit(99)"], graphifyCommand: "graphify", cacheDir: join(f.root, "filtered"), projectIds: ["other"], timeoutMs: 3000, debounceMs: 0, intervalMs: 86_400_000 }, f.projects, f.root);
    const result = await filtered.refresh("sample-project", f.project, headA, "shared");
    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /filter/);
    filtered.close();

    const changed = fixture();
    const request = changed.service.refresh("sample-project", changed.project, headA, "shared");
    changed.projects[0].path = changed.first;
    const receipt = await request;
    assert.equal(receipt.status, "failed");
    assert.match(receipt.reason ?? "", /authority changed/);
    assert.equal(existsSync(changed.receiptFile), false);
    changed.service.close(); rmSync(changed.root, { recursive: true, force: true });
  } finally { f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("queue capacity is bounded and an aborted member wait clears its queued timer", async () => {
  const f = fixture();
  try {
    const controller = new AbortController();
    const cancelled = f.service.refresh("sample-project", f.first, headA, "run-one", controller.signal);
    controller.abort();
    const result = await cancelled;
    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /cancelled/);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(existsSync(f.started), false, "an aborted preparation does not start a graph process later");

    const requests = Array.from({ length: 65 }, () => f.service.refresh("sample-project", f.first, headB, "run-one"));
    const results = await Promise.all(requests);
    assert.equal(results.filter(item => item.status === "busy").length, 1);
    assert.equal(results.filter(item => item.status === "ready").length, 64);
  } finally { f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("shared lane rejects a checkout whose canonical root is not the configured project root", async () => {
  const f = fixture();
  try {
    const result = await f.service.refresh("sample-project", f.first, headA, "shared");
    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /configured project root/);
    assert.equal(existsSync(f.receiptFile), false, "invalid project path never reaches the graph command");
  } finally { f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("codeMap falls back to the shared lane", { timeout: 15000 }, async () => {
  const f = fixture("map");
  try {
    const shared = await f.service.refresh("sample-project", f.project, headB, "shared");
    assert.equal(shared.status, "ready");
    const fallback = f.service.codeMap("sample-project", "run-one");
    assert.equal(fallback.state, "ready");
    assert.equal(fallback.state === "ready" && fallback.lane, "shared");
    assert.equal(fallback.state === "ready" && fallback.head, headB);
    assert.deepEqual(fallback.state === "ready" ? { areas: fallback.areas, links: fallback.links, truncated: fallback.truncated } : undefined, codeMap);

    const run = await f.service.refresh("sample-project", f.first, headB, "run-one");
    assert.equal(run.status, "ready");
    const own = f.service.codeMap("sample-project", "run-one");
    assert.equal(own.state === "ready" && own.lane, "run-one");
  } finally { f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("the host enforces the map's byte budget and area cap itself", { timeout: 15000 }, async () => {
  for (const [mode, expected] of [["huge-map", { state: "unavailable", reason: "too-large" }], ["many-areas", { state: "unavailable", reason: "none-built" }]] as const) {
    const f = fixture(mode);
    try {
      const receipt = await f.service.refresh("sample-project", f.project, headB, "shared");
      assert.equal(receipt.status, "ready", "the graph receipt itself stays usable");
      assert.equal(receipt.map, undefined);
      assert.deepEqual(f.service.codeMap("sample-project"), expected);
      assert.equal(f.service.areas("sample-project"), undefined);
    } finally { f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("a failed refresh keeps the lane's last map", { timeout: 15000 }, async () => {
  const f = fixture("map-fail-a");
  try {
    assert.equal((await f.service.refresh("sample-project", f.project, headB, "shared")).status, "ready");
    assert.equal((await f.service.refresh("sample-project", f.project, headA, "shared")).status, "failed");
    const kept = f.service.codeMap("sample-project");
    assert.equal(kept.state, "ready");
    assert.equal(kept.state === "ready" && kept.head, headB);
    assert.deepEqual([...f.service.areas("sample-project") ?? []].sort(), codeMap.areas.map(area => area.id).sort());
  } finally { f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("codeMap reports disabled and none-built", { timeout: 15000 }, async () => {
  const f = fixture("ready");
  try {
    await f.service.refresh("sample-project", f.project, headB, "shared");
    assert.deepEqual(f.service.codeMap("sample-project"), { state: "unavailable", reason: "none-built" });
    assert.deepEqual(f.service.codeMap("unknown-project"), { state: "disabled" });

    const filtered = new RepositoryGraphs({ command: process.execPath, args: ["-e", "process.exit(99)"], graphifyCommand: "graphify", cacheDir: join(f.root, "filtered"), projectIds: ["other"], timeoutMs: 3000, debounceMs: 0, intervalMs: 86_400_000 }, f.projects, f.root);
    assert.deepEqual(filtered.codeMap("sample-project"), { state: "disabled" });
    filtered.close();
  } finally { f.service.close(); rmSync(f.root, { recursive: true, force: true }); }

  const large = fixture("too-large");
  try {
    await large.service.refresh("sample-project", large.project, headB, "shared");
    assert.deepEqual(large.service.codeMap("sample-project"), { state: "unavailable", reason: "too-large" });
  } finally { large.service.close(); rmSync(large.root, { recursive: true, force: true }); }
});

test("malformed map is dropped", { timeout: 15000 }, async () => {
  const f = fixture("bad-map");
  try {
    const result = await f.service.refresh("sample-project", f.project, headB, "shared");
    assert.equal(result.status, "ready");
    assert.ok(result.graphPath, "the graph receipt is kept");
    assert.equal(result.map, undefined);
    assert.equal(f.service.codeMap("sample-project").state, "unavailable");
  } finally { f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("status omits the map", { timeout: 15000 }, async () => {
  const f = fixture("map");
  try {
    await f.service.refresh("sample-project", f.project, headB, "shared");
    const receipts = f.service.status("sample-project");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].result.status, "ready");
    assert.equal("map" in receipts[0].result, false);
    assert.equal(f.service.codeMap("sample-project").state, "ready");
  } finally { f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("areas returns shared-lane IDs", { timeout: 15000 }, async () => {
  const f = fixture("map");
  try {
    assert.equal(f.service.areas("sample-project"), undefined);
    await f.service.refresh("sample-project", f.first, headB, "run-one");
    assert.equal(f.service.areas("sample-project"), undefined, "run-lane areas are not the shared set");
    await f.service.refresh("sample-project", f.project, headB, "shared");
    assert.deepEqual([...f.service.areas("sample-project")!].sort(), ["apps/web/src", "packages/host/src"]);
  } finally { f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});
