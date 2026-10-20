import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";

const harness = fileURLToPath(new URL("./fixtures/mobile-signals-harness.ts", import.meta.url));
const standInPath = fileURLToPath(new URL("./fixtures/mobile-signals-native.ts", import.meta.url));

const standIns: Plugin = {
  name: "mobile-signals-native",
  setup(builder) {
    builder.onResolve({ filter: /^(react|\.\.\/\.\.\/api\/client|\.\.\/\.\.\/api\/useLive)$/ }, () => ({ path: standInPath }));
  },
};

test("signal recovery consumes each journal page before requesting the next cursor", async () => {
  const bundle = await build({ entryPoints: [harness], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", plugins: [standIns] });
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`) as {
    loadSignals(): Promise<{ id: string; events: { seq: number }[]; exited: boolean }>;
    signalRead(): { calls: number; firstSequenceRead: boolean; secondAfter: string };
  };

  const result = await runtime.loadSignals();
  assert.deepEqual(result.events.map(event => event.seq), [1, 2]);
  assert.equal(runtime.signalRead().calls, 2);
  assert.equal(runtime.signalRead().firstSequenceRead, true);
  assert.equal(runtime.signalRead().secondAfter, "1");
});
