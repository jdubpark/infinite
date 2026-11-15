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
  let metaFails = false;
  let listCalls = 0;
  const policy = (id: string) => ({ sourceSessionId: id, projectId: "p", path: join(stateDir, id), commandPrefix: [] });
  const sessions: Record<string, Record<string, unknown>> = {
    a: { id: "a", projectId: "p", handoff: { reason: "No handoff capability for a." } },
    b: { id: "b", projectId: "p", handoff: { policy: policy("b") } },
    c: { id: "c", projectId: "p", handoff: { policy: policy("c") } },
  };
  const manager = {
    async list() {
      listCalls += 1;
      return [{ id: "a", status: "running" }, { id: "b", status: "exited" }, { id: "c", status: "running" }];
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

    assert.deepEqual(service.view("a"), { status: "unavailable", reason: "No handoff capability for a." });
    assert.deepEqual(service.view("b"), { status: "available" });

    metaFails = true;
    assert.throws(() => service.view("a"), { code: "ENOENT", message: "record gone" });
  } finally {
    service.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
