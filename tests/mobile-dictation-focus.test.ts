import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";

const harness = fileURLToPath(new URL("./fixtures/mobile-dictation-focus-harness.ts", import.meta.url));
const standInPath = fileURLToPath(new URL("./fixtures/mobile-focus-native.ts", import.meta.url));

const standIns: Plugin = {
  name: "mobile-dictation-focus-native",
  setup(builder) {
    builder.onResolve({ filter: /^(react|expo-router|expo|react-native|\.\.\/api\/client)$/ }, () => ({ path: standInPath }));
  },
};

type View = { read(): unknown; unmount(): void };
type Runtime = { mount(): View; setFocused(value: boolean): void; speechListenerCounts(): Record<string, number> };
const expectedSubscriptions = { start: 1, result: 1, error: 1, end: 1 };

test("covered dictation fields release native speech event listeners", async () => {
  const bundle = await build({ entryPoints: [harness], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", plugins: [standIns] });
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`) as Runtime;
  const view = runtime.mount();

  try {
    assert.deepEqual(runtime.speechListenerCounts(), expectedSubscriptions);
    runtime.setFocused(false);
    view.read();
    assert.deepEqual(runtime.speechListenerCounts(), {}, "a covered route must not retain native listeners");
    runtime.setFocused(true);
    view.read();
    assert.deepEqual(runtime.speechListenerCounts(), expectedSubscriptions, "listeners return when the screen is focused again");
  } finally {
    view.unmount();
  }

  assert.deepEqual(runtime.speechListenerCounts(), {});
});
