import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffService } from "../packages/host/src/handoffs.js";
import type { Config } from "../packages/host/src/types.js";
import type { Manager } from "../packages/host/src/manager.js";

test("discovery reads a record once when its answer cannot change", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "inf-handoff-discovery-"));
  const reads: Record<string, number> = { a: 0, b: 0, c: 0 };
  const requests: Record<string, number> = { a: 0, b: 0, c: 0 };
  // The identity of each session's meta file; undefined while the file is younger than the settle time.
  const revisions: Record<string, string | undefined> = { a: "rev-a", b: "rev-b", c: "rev-c" };
  let metaFails = false;
  let listCalls = 0;
  let listOmitsA = false;
  const policy = (id: string) => ({ sourceSessionId: id, projectId: "p", path: join(stateDir, id), commandPrefix: [] });
  const sessions: Record<string, Record<string, unknown>> = {
    a: { id: "a", projectId: "p", handoff: { reason: "No handoff capability for a." } },
    b: { id: "b", projectId: "p", handoff: { policy: policy("b") } },
    c: { id: "c", projectId: "p", handoff: { policy: policy("c") } },
  };
  const manager = {
    async list() {
      listCalls += 1;
      const rows = [{ id: "a", status: "running" }, { id: "b", status: "exited" }, { id: "c", status: "running" }];
      return listOmitsA ? rows.slice(1) : rows;
    },
    meta(id: string) {
      reads[id] += 1;
      if (id === "a" && metaFails) throw Object.assign(new Error("record gone"), { code: "ENOENT" });
      return { session: sessions[id] };
    },
    handoffRequest(id: string) {
      requests[id] += 1;
      return undefined;
    },
    metaRevision: (id: string) => revisions[id],
    reserveHandoff() {},
    releaseHandoff() {},
  };
  const service = new HandoffService({ stateDir } as Config, Buffer.alloc(32, 7), manager as unknown as Manager, {} as never, {} as never);
  try {
    service.start();
    const deadline = Date.now() + 5000;
    // Tick 2 runs its discovery in the same microtask run as its listing, so once a macrotask sees two listings, it has finished.
    while (listCalls < 2) {
      if (Date.now() > deadline) throw new Error("the handoff poller did not list twice");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    service.close();
    assert.deepEqual(reads, { a: 1, b: 1, c: 2 });
    assert.deepEqual(requests, { a: 0, b: 1, c: 2 });

    // A listing row reads no record for a source whose answer it remembers.
    const reasonA = "No handoff capability for a.";
    assert.deepEqual(service.listedView("a"), { status: "unavailable", reason: reasonA });
    assert.deepEqual(service.listedView("b"), { status: "available" });
    assert.deepEqual(reads, { a: 1, b: 1, c: 2 });
    // A running source is never answered from memory.
    const listedC = service.listedView("c");
    assert.equal(reads.c, 4);
    assert.deepEqual(listedC, service.view("c"));
    // Each call returns a new object, so a caller cannot change a later answer.
    const first = service.listedView("a");
    Object.assign(first, { reason: "changed" });
    assert.notEqual(first, service.listedView("a"));
    assert.deepEqual(service.listedView("a"), { status: "unavailable", reason: reasonA });

    assert.deepEqual(service.view("a"), { status: "unavailable", reason: reasonA });
    assert.deepEqual(service.view("b"), { status: "available" });

    metaFails = true;
    assert.throws(() => service.view("a"), { code: "ENOENT", message: "record gone" });
    assert.deepEqual(service.listedView("a"), { status: "unavailable", reason: reasonA });

    // A listing that no longer holds A makes the memory forget it, so the next row reads the record again.
    listOmitsA = true;
    const listsBefore = listCalls;
    service.start();
    const forgetDeadline = Date.now() + 5000;
    while (listCalls < listsBefore + 2) {
      if (Date.now() > forgetDeadline) throw new Error("the handoff poller did not list again");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    service.close();
    const readsA = reads.a;
    assert.throws(() => service.listedView("a"), { code: "ENOENT", message: "record gone" });
    assert.equal(reads.a, readsA + 1);

    // Two ticks with the listing's own revisions; the poller runs twice in that wait.
    const settleTicks = async () => {
      const target = listCalls + 2;
      service.start();
      const until = Date.now() + 5000;
      while (listCalls < target) {
        if (Date.now() > until) throw new Error("the handoff poller did not list again");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      service.close();
    };
    metaFails = false;
    listOmitsA = false;
    const readsBeforeSettle = reads.a;
    await settleTicks();
    assert.deepEqual(service.listedView("a"), { status: "unavailable", reason: reasonA });
    assert.equal(reads.a, readsBeforeSettle + 1);

    // A replaced record: the file's reason and its revision change together, as a rewritten file does.
    const replacedReason = "Replaced handoff reason for a.";
    sessions.a = { id: "a", projectId: "p", handoff: { reason: replacedReason } };
    revisions.a = "rev-a-2";
    const readsBeforeReplace = reads.a;
    await settleTicks();
    assert.equal(reads.a, readsBeforeReplace + 1);
    const readsReplaced = reads.a;
    assert.deepEqual(service.listedView("a"), { status: "unavailable", reason: replacedReason });
    assert.equal(reads.a, readsReplaced);

    // Same revision, changed stub content: a real file cannot change without its revision changing,
    // so the memory keeps answering with the remembered reason and reads nothing.
    sessions.a = { id: "a", projectId: "p", handoff: { reason: "Changed again without a new revision." } };
    assert.deepEqual(service.listedView("a"), { status: "unavailable", reason: replacedReason });
    assert.equal(reads.a, readsReplaced);

    // The route asks first: the record is replaced and a listing has seen it (a new revision), but the handoff poller
    // has not ticked since. The listed view must not answer from the old revision's memory.
    const routeReason = "Replaced again, and the route asks before the poller.";
    sessions.a = { id: "a", projectId: "p", handoff: { reason: routeReason } };
    revisions.a = "rev-a-3";
    const readsBeforeRoute = reads.a;
    assert.deepEqual(service.listedView("a"), { status: "unavailable", reason: routeReason });
    // The stale memory is dropped: discovery reads the record, then the view reads it for its own answer.
    assert.equal(reads.a, readsBeforeRoute + 2);
    assert.deepEqual(service.listedView("a"), { status: "unavailable", reason: routeReason });
    assert.equal(reads.a, readsBeforeRoute + 2, "the new answer is remembered under the new revision");

    // A file that is not settled: nothing is remembered, so every row reads the record.
    revisions.a = undefined;
    await settleTicks();
    const readsUnsettled = reads.a;
    assert.deepEqual(service.listedView("a"), { status: "unavailable", reason: routeReason });
    // An unremembered view reads the record twice (discovery, then its own answer), on every call.
    assert.equal(reads.a, readsUnsettled + 2);
    assert.deepEqual(service.listedView("a"), { status: "unavailable", reason: routeReason });
    assert.equal(reads.a, readsUnsettled + 4);
  } finally {
    service.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
