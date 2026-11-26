import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { proxyNativeHttp } from "../packages/host/src/native-http.js";
import { connectCodexEnvironments } from "../packages/host/src/codex-environment.js";
import { terminalConnection } from "../packages/host/src/client-transport.js";

const cell = new Int32Array(new SharedArrayBuffer(4));
const DEADLINE_MS = 15_000;
const STALL_MS = 15_600;

function block(ms: number) {
  const until = performance.now() + ms;
  while (performance.now() < until) Atomics.wait(cell, 0, 0, until - performance.now());
}

async function peer(kind: "http" | "codex" | "terminal", replies: boolean, stalls: boolean) {
  const script = fileURLToPath(new URL("./fixtures/reply-peer.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, kind, replies ? "300" : "never"], { stdio: ["ignore", "pipe", "inherit"] });
  let stalled = false;
  const port = await new Promise<number>(resolve => createInterface({ input: child.stdout! }).on("line", line => {
    if (line.startsWith("port ")) resolve(Number(line.slice(5)));
    if (line === "request" && stalls && !stalled) {
      stalled = true;
      setImmediate(() => block(STALL_MS));
    }
  }));
  return { port, stop: () => child.kill("SIGKILL") };
}

const inImmediate = <T>(run: () => Promise<T>) => new Promise<T>((resolve, reject) => setImmediate(() => run().then(resolve, reject)));

async function timed<T>(run: () => Promise<T>) {
  const started = performance.now();
  const outcome = await run().then(value => ({ value }), (error: Error & { code?: string }) => ({ error: error.message, code: error.code }));
  return { outcome, ms: performance.now() - started };
}

const proxied = (port: number) => inImmediate(async () => {
  const front = createServer((req, res) => proxyNativeHttp(req, res, new URL(`http://127.0.0.1:${port}/native`), {}));
  await new Promise<void>(resolve => front.listen(0, "127.0.0.1", resolve));
  try {
    return await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const outgoing = request(`http://127.0.0.1:${(front.address() as { port: number }).port}/x`, { method: "POST" }, response => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
  } finally {
    front.close();
  }
});

const codexRead = (port: number) => inImmediate(async () => {
  const client = await connectCodexEnvironments({ endpoint: `ws://127.0.0.1:${port}`, token: "t".repeat(40) });
  try {
    return await client.read("thread-1");
  } finally {
    client.close();
  }
});

function terminalCall(port: number, action: "input" | "control") {
  return inImmediate(async () => {
    const controller = new AbortController();
    const connection = terminalConnection(`http://127.0.0.1:${port}`, "token", "session", 0, controller.signal, { control: true });
    await new Promise(resolve => setTimeout(resolve, 200));
    try {
      return action === "input" ? await connection.input("x") : await connection.control("claim");
    } finally {
      connection.close();
    }
  });
}

test("native proxy: an upstream response that arrived during a host stall past 15 s is relayed", async () => {
  const upstream = await peer("http", true, true);
  try {
    const { outcome } = await timed(() => proxied(upstream.port));
    assert.deepEqual(outcome, { value: { status: 200, body: JSON.stringify({ ok: true }) } });
  } finally {
    upstream.stop();
  }
});

test("native proxy: an upstream that never answers fails with 502 after 15 s", async () => {
  const upstream = await peer("http", false, false);
  try {
    const { outcome, ms } = await timed(() => proxied(upstream.port));
    assert.equal((outcome as { value: { status: number } }).value.status, 502);
    assert.match((outcome as { value: { body: string } }).value.body, /Native connection unavailable/);
    assert.ok(ms >= DEADLINE_MS - 100 && ms < DEADLINE_MS + 3_000, `failed after ${Math.round(ms)} ms`);
  } finally {
    upstream.stop();
  }
});

test("codex environment: a provider reply that arrived during a host stall past 15 s is used", async () => {
  const provider = await peer("codex", true, true);
  try {
    const { outcome } = await timed(() => codexRead(provider.port));
    assert.deepEqual(outcome, { value: { threadId: "thread-1", environments: [] } });
  } finally {
    provider.stop();
  }
});

test("codex environment: a provider that never answers is reported uncertain after 15 s", async () => {
  const provider = await peer("codex", false, false);
  try {
    const { outcome, ms } = await timed(() => codexRead(provider.port));
    assert.deepEqual(outcome, {
      error: "The provider acknowledgement timed out; keep execution held and reconcile before continuing",
      code: "uncertain",
    });
    assert.ok(ms >= DEADLINE_MS - 100 && ms < DEADLINE_MS + 3_000, `failed after ${Math.round(ms)} ms`);
  } finally {
    provider.stop();
  }
});

for (const action of ["input", "control"] as const) {
  test(`terminal ${action}: an acknowledgement that arrived during a host stall past 15 s is accepted`, async () => {
    const server = await peer("terminal", true, true);
    try {
      const { outcome } = await timed(() => terminalCall(server.port, action));
      assert.deepEqual(outcome, { value: action === "input" ? undefined : null });
    } finally {
      server.stop();
    }
  });

  test(`terminal ${action}: a server that never acknowledges fails after 15 s`, async () => {
    const server = await peer("terminal", false, false);
    try {
      const { outcome, ms } = await timed(() => terminalCall(server.port, action));
      assert.deepEqual(outcome, { error: action === "input" ? "Input delivery is uncertain" : "Control acknowledgement was not received", code: undefined });
      assert.ok(ms >= DEADLINE_MS - 100 && ms < DEADLINE_MS + 3_000, `failed after ${Math.round(ms)} ms`);
    } finally {
      server.stop();
    }
  });
}
