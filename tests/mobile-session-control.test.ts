import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";

const harness = fileURLToPath(new URL("./fixtures/mobile-control-harness.ts", import.meta.url));
const standInPath = fileURLToPath(new URL("./fixtures/mobile-control-native.ts", import.meta.url));

const standIns: Plugin = {
  name: "mobile-control-native",
  setup(builder) {
    builder.onResolve({ filter: /^(react|expo-router|\.\.\/\.\.\/api\/(client|foreground))$/ }, () => ({ path: standInPath }));
  },
};

type Control = { holder: { id: string } | null; generation(): number; observe(session: never, revision: number): void };
type View = { read(): Control; unmount(): void };
type Runtime = {
  mount(): View;
  setFocused(value: boolean): void;
  observeRemoteHolder(control: Control): void;
};

test("session control state is released from the module cache after its last route unmounts", async () => {
  const bundle = await build({ entryPoints: [harness], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", plugins: [standIns] });
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`) as Runtime;
  const first = runtime.mount();

  try {
    runtime.observeRemoteHolder(first.read());
    assert.equal(first.read().holder?.id, "remote-lease");
    runtime.setFocused(false);
    first.read();
  } finally {
    first.unmount();
  }

  await new Promise(resolve => setTimeout(resolve, 10));
  runtime.setFocused(true);
  const second = runtime.mount();
  try {
    assert.equal(second.read().holder, null, "a new route must not reuse state retained after the prior route unmounted");
  } finally {
    second.unmount();
  }
});
