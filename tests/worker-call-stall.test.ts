import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerCallAt } from "../packages/host/src/ipc.js";
import { channelCall } from "../packages/host/src/permission-headless.js";

const result = { status: "running", seq: 7 };
const reply = JSON.stringify({ result }) + "\n";
const timedOut = { error: "Worker response timed out; delivery may be uncertain" };
const cell = new Int32Array(new SharedArrayBuffer(4));

function block(ms: number) {
  const until = performance.now() + ms;
  while (performance.now() < until) Atomics.wait(cell, 0, 0, until - performance.now());
}

function settle(call: Promise<unknown>, limitMs: number) {
  return Promise.race([
    call.then(value => ({ value }), (error: Error) => ({ error: error.message })),
    new Promise(resolve => setTimeout(resolve, limitMs, { pending: true }).unref()),
  ]);
}

async function standIn(answer: (socket: Socket) => void, pauseOnConnect = false) {
  const dir = mkdtempSync(join(tmpdir(), "inf-call-"));
  const path = join(dir, "worker.sock");
  const sockets: Socket[] = [];
  const server = createServer({ pauseOnConnect }, socket => {
    sockets.push(socket);
    socket.on("error", () => {});
    answer(socket);
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  return {
    path,
    sockets,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const size of [0, 1024 * 1024])
  test(`a ${size ? "long" : "short"} reply written just before the caller's event loop blocks past the timeout is returned`, async () => {
    const worker = await standIn(socket => socket.once("data", () => {
      socket.end(JSON.stringify({ result: { pad: "x".repeat(size) } }) + "\n");
      block(750);
    }));
    try {
      const call = workerCallAt<{ pad: string }>(worker.path, { op: "state" }, 250).then(value => value.pad.length);
      assert.deepEqual(await settle(call, 5000), { value: size });
    } finally {
      worker.close();
    }
  });

test("a long reply whose transfer straddles the caller's blocked event loop is returned", async () => {
  const line = JSON.stringify({ result: { pad: "x".repeat(1024 * 1024) } }) + "\n";
  const worker = await standIn(socket => socket.once("data", () => {
    socket.write(line.slice(0, 10));
    setImmediate(() => setImmediate(() => {
      socket.end(line.slice(10));
      block(750);
    }));
  }));
  try {
    const call = workerCallAt<{ pad: string }>(worker.path, { op: "state" }, 250).then(value => value.pad.length);
    assert.deepEqual(await settle(call, 5000), { value: 1024 * 1024 });
  } finally {
    worker.close();
  }
});

for (const replies of [true, false])
  test(`a call whose caller blocks before the request is sent ${replies ? "returns the reply" : "still sends it and times out on a silent worker"}`, async () => {
    let requests = 0;
    const worker = await standIn(socket => socket.once("data", () => {
      requests += 1;
      if (replies) socket.end(reply);
    }));
    try {
      const outcome = await new Promise(resolve => setImmediate(() => {
        const call = settle(workerCallAt(worker.path, { op: "state" }, 250), 5000);
        block(750);
        resolve(call);
      }));
      assert.deepEqual({ outcome, requests }, { outcome: replies ? { value: result } : timedOut, requests: 1 });
    } finally {
      worker.close();
    }
  });

test("a worker that never replies still times out after 4 s", async () => {
  const worker = await standIn(() => {});
  try {
    const started = performance.now();
    assert.deepEqual(await settle(workerCallAt(worker.path, { op: "state" }), 10_000), timedOut);
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 3_900 && elapsed < 6_000, `timed out after ${Math.round(elapsed)} ms`);
  } finally {
    worker.close();
  }
});

test("a partial reply followed by silence times out one timeout after its last byte", async () => {
  let lastByte = 0;
  const worker = await standIn(socket => socket.once("data", () => {
    setTimeout(() => {
      socket.write(reply.slice(0, 10));
      lastByte = performance.now();
    }, 100);
  }));
  try {
    const outcome = await settle(workerCallAt(worker.path, { op: "state" }, 500), 5000);
    const quiet = performance.now() - lastByte;
    assert.deepEqual(outcome, timedOut);
    assert.ok(lastByte > 0 && quiet >= 490 && quiet < 2_000, `timed out ${Math.round(quiet)} ms after the last byte`);
  } finally {
    worker.close();
  }
});

for (const reset of [true, false])
  test(`an error after a call has settled raises nothing unhandled when the ${reset ? "worker resets the connection" : "connection idles past the timeout"}`, async () => {
    const worker = await standIn(socket => socket.write(reply), true);
    try {
      assert.deepEqual(await settle(workerCallAt(worker.path, { op: "state" }, 250), 5000), { value: result });
      if (reset) worker.sockets[0].destroy();
      await new Promise(resolve => setTimeout(resolve, 750));
    } finally {
      worker.close();
    }
  });

for (const [kind, answer, expected] of [
  ["a malformed", "{\n", /JSON/],
  ["an oversized", "x".repeat(2 * 1024 * 1024 + 1), /^Oversized worker response$/],
] as const)
  test(`${kind} reply still fails the call`, async () => {
    const worker = await standIn(socket => socket.once("data", () => socket.end(answer)));
    try {
      const outcome = await settle(workerCallAt(worker.path, { op: "state" }, 1000), 5000);
      assert.match(String((outcome as { error?: string }).error), expected);
    } finally {
      worker.close();
    }
  });

test("a permission channel reply written just before the caller's event loop blocks past the timeout is returned", async () => {
  const channel = await standIn(socket => socket.once("data", () => {
    socket.end(JSON.stringify({ result: "none" }) + "\n");
    block(750);
  }));
  try {
    const request = { v: 1, op: "class", sessionId: "session", token: "token", call: { toolName: "Bash", toolInput: {} } } as const;
    assert.deepEqual(await settle(channelCall(channel.path, request, 250), 5000), { value: { result: "none" } });
  } finally {
    channel.close();
  }
});
