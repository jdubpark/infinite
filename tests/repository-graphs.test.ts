import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepositoryGraphs } from "../packages/host/src/repository-graphs.js";
import type { Config } from "../packages/host/src/types.js";
import { waitFor } from "./helpers.js";

const headA = "a".repeat(40), headB = "b".repeat(40);

function fixture(mode = "ready") {
  const root = mkdtempSync(join(tmpdir(), "repository-graphs-"));
  const project = join(root, "project"), workspaces = join(root, "workspaces"), first = join(workspaces, "run-one", "member-one"), second = join(workspaces, "run-one", "member-two");
  for (const path of [project, first, second]) mkdirSync(path, { recursive: true });
  const receiptFile = join(root, "receipts.jsonl"), started = join(root, "started");
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
const status = mode === "fail" ? "failed" : "ready";
process.stdout.write(JSON.stringify({ status, requestedHead: ref, head: mode === "mismatch" ? ${JSON.stringify(headA)} : ref, graphPath: path.join(cache, "graph.json"), mode: "incremental", changedFiles: 1, deletedFiles: 0 }) + "\n");
if (mode === "fail" || mode === "nonzero-ready") process.exit(2);
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
