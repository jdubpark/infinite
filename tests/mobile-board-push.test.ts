import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";

const harness = fileURLToPath(new URL("./fixtures/mobile-board-push-harness.ts", import.meta.url));
const standInPath = fileURLToPath(new URL("./fixtures/mobile-board-push-native.ts", import.meta.url));

const standIns: Plugin = {
  name: "mobile-board-push-native",
  setup(builder) {
    builder.onResolve(
      {
        filter: /^(react|react\/jsx-runtime|react\/jsx-dev-runtime|react-native|expo-router|react-native-safe-area-context|expo-notifications|expo-device|expo-constants|expo-secure-store|\.\.\/api\/client|\.\.\/\.\.\/api\/client|\.\.\/\.\.\/store\/(connection|machines)|\.\/Board|\.\.\/\.\.\/theme)$/,
      },
      () => ({ path: standInPath }),
    );
  },
};

type NodeElement = { type: unknown; props: Record<string, unknown> };
type Runtime = {
  mountBoardHome(): { read(): NodeElement; unmount(): void };
  PUSH_ROTATION_RETRY_DELAYS_MS: readonly number[];
  getPushStates(): Record<string, string>;
  setSharedMachine(profiles: { id: string; url: string; token: string }[], active: string): void;
  unregisterPush(connection: { id: string; url: string; token: string }): Promise<void>;
  pushTestControl: {
    reset(): void;
    setApiHandler(fn: (connection: { id?: string }, path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>): void;
    setTokenFetcher(fn: () => Promise<{ data: string }>): void;
    emitTokenRotation(token?: { type: "ios" | "android"; data: string }): void;
    tokenListenerCount(): number;
  };
};

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

const readPushNote = (tree: NodeElement): string | undefined => {
  const board = tree.props.children as NodeElement | undefined;
  return board?.props?.pushNote as string | undefined;
};

test("BoardHome reflects degraded rotation state and clears cached push status when /me disables push", async t => {
  const bundle = await build({
    entryPoints: [harness],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    logLevel: "silent",
    plugins: [standIns],
  });
  const runtime = (await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`)) as Runtime;
  const machineA = { id: "machine-a", url: "http://127.0.0.1:4101", token: "tok-a" };
  runtime.pushTestControl.reset();
  runtime.setSharedMachine([machineA], "machine-a");
  t.mock.timers.enable({ apis: ["setTimeout"] });

  let pushEnabled = true;
  let failPushPost = false;
  runtime.pushTestControl.setApiHandler(async (_connection, path) => {
    if (path === "/me") {
      return { role: "owner", environment: "local", capabilities: { signals: true, answer: true, push: pushEnabled } };
    }
    if (path === "/devices/push" && failPushPost) {
      throw new Error("host offline");
    }
    return {};
  });

  const firstMount = runtime.mountBoardHome();
  try {
    await flush();
    assert.equal(readPushNote(firstMount.read()), "Notifications on for this machine");

    failPushPost = true;
    runtime.pushTestControl.setTokenFetcher(async () => ({ data: "ExponentPushToken[rot-board]" }));
    runtime.pushTestControl.emitTokenRotation({ type: "ios", data: "apns-board" });
    await flush();
    for (const delay of runtime.PUSH_ROTATION_RETRY_DELAYS_MS) {
      t.mock.timers.tick(delay);
      await flush();
    }
    assert.equal(readPushNote(firstMount.read()), "Notifications degraded: failed to refresh push token");
  } finally {
    firstMount.unmount();
  }

  pushEnabled = false;
  const secondMount = runtime.mountBoardHome();
  try {
    await flush();
    assert.equal(readPushNote(secondMount.read()), undefined);
    assert.equal(runtime.getPushStates()["machine-a"], undefined);
    assert.equal(runtime.pushTestControl.tokenListenerCount(), 0);
  } finally {
    secondMount.unmount();
    await runtime.unregisterPush(machineA);
    t.mock.timers.reset();
    runtime.pushTestControl.reset();
  }
});
