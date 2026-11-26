import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";

function loadPush() {
  if (typeof nodeModule.registerHooks !== "function") return undefined;
  const native = new URL("./fixtures/mobile-push-native.ts", import.meta.url).href;
  const stubs = new Set([
    "expo-notifications",
    "expo-device",
    "expo-constants",
    "expo-secure-store",
    "react-native",
  ]);
  nodeModule.registerHooks({
    resolve: (specifier, context, next) => {
      if (stubs.has(specifier)) return { url: native, shortCircuit: true };
      if (specifier === "../api/client" && context.parentURL?.endsWith("/apps/mobile/src/push/register.ts")) {
        return { url: native, shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
  const require = nodeModule.createRequire(import.meta.url);
  return {
    ...(require("../apps/mobile/src/push/register.ts") as typeof import("../apps/mobile/src/push/register.ts")),
    ...(require("./fixtures/mobile-push-native.ts") as typeof import("./fixtures/mobile-push-native.ts")),
  };
}

const env = loadPush();
const skip = !env && "module.registerHooks requires Node 22.15+";
const flush = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};
const machineA = { id: "machine-a", url: "http://127.0.0.1:4101", token: "tok-a" };
const machineB = { id: "machine-b", url: "http://127.0.0.1:4102", token: "tok-b" };

test("push token rotation retries failed token fetch and partial host failures with backoff without duplicate POSTs", { skip }, async t => {
  const { PUSH_ROTATION_RETRY_DELAYS_MS, getPushStates, pushTestControl, registerForPush, unregisterPush } = env!;
  pushTestControl.reset();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    assert.equal(await registerForPush(machineA), "registered");
    assert.equal(await registerForPush(machineB), "registered");
    pushTestControl.clearCalls();

    let tokenAttempts = 0;
    let machineBFailures = 1;
    pushTestControl.setTokenFetcher(async () => {
      tokenAttempts += 1;
      if (tokenAttempts === 1) throw new Error("expo unavailable");
      return { data: "ExponentPushToken[rot-1]" };
    });
    pushTestControl.setApiHandler(async connection => {
      if (connection.id === "machine-b" && machineBFailures > 0) {
        machineBFailures -= 1;
        throw new Error("machine-b unreachable");
      }
      return {};
    });

    pushTestControl.emitTokenRotation();
    await flush();
    assert.equal(tokenAttempts, 1);
    assert.equal(pushTestControl.calls().length, 0);
    assert.equal(getPushStates()["machine-a"], "registered");
    assert.equal(getPushStates()["machine-b"], "registered");

    t.mock.timers.tick(PUSH_ROTATION_RETRY_DELAYS_MS[0] - 1);
    await flush();
    assert.equal(tokenAttempts, 1);

    t.mock.timers.tick(1);
    await flush();
    assert.equal(tokenAttempts, 2);
    assert.deepEqual(
      pushTestControl.calls().map(call => `${call.key}:${(call.body as { token: string }).token}`),
      ["machine-a:ExponentPushToken[rot-1]", "machine-b:ExponentPushToken[rot-1]"],
    );
    assert.equal(pushTestControl.storedToken(), "ExponentPushToken[initial]");

    t.mock.timers.tick(PUSH_ROTATION_RETRY_DELAYS_MS[1] - 1);
    await flush();
    assert.equal(pushTestControl.calls().length, 2);

    t.mock.timers.tick(1);
    await flush();
    assert.equal(tokenAttempts, 2);
    assert.deepEqual(
      pushTestControl.calls().map(call => `${call.key}:${(call.body as { token: string }).token}`),
      [
        "machine-a:ExponentPushToken[rot-1]",
        "machine-b:ExponentPushToken[rot-1]",
        "machine-b:ExponentPushToken[rot-1]",
      ],
    );
    assert.equal(pushTestControl.storedToken(), "ExponentPushToken[rot-1]");
    assert.equal(getPushStates()["machine-a"], "registered");
    assert.equal(getPushStates()["machine-b"], "registered");
  } finally {
    await unregisterPush(machineA);
    await unregisterPush(machineB);
    t.mock.timers.reset();
    pushTestControl.reset();
  }
});

test("push token rotation exhausts bounded retries into degraded state and recovers on foreground return", { skip }, async t => {
  const { PUSH_ROTATION_RETRY_DELAYS_MS, getPushStates, pushTestControl, registerForPush, setAppState, subscribePushStates, unregisterPush } = env!;
  pushTestControl.reset();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const observed: (string | undefined)[] = [];
  const unsubscribe = subscribePushStates(() => {
    observed.push(getPushStates()["machine-a"]);
  });

  try {
    assert.equal(await registerForPush(machineA), "registered");
    pushTestControl.clearCalls();

    let hostAvailable = false;
    pushTestControl.setTokenFetcher(async () => ({ data: "ExponentPushToken[rot-degraded]" }));
    pushTestControl.setApiHandler(async () => {
      if (!hostAvailable) throw new Error("offline");
      return {};
    });

    pushTestControl.emitTokenRotation();
    await flush();
    assert.equal(pushTestControl.calls().length, 1);
    assert.equal(getPushStates()["machine-a"], "registered");

    for (let i = 0; i < PUSH_ROTATION_RETRY_DELAYS_MS.length; i += 1) {
      t.mock.timers.tick(PUSH_ROTATION_RETRY_DELAYS_MS[i]!);
      await flush();
      assert.equal(pushTestControl.calls().length, i + 2);
      if (i < PUSH_ROTATION_RETRY_DELAYS_MS.length - 1) {
        assert.equal(getPushStates()["machine-a"], "registered");
      }
    }

    assert.equal(getPushStates()["machine-a"], "degraded");
    t.mock.timers.tick(60_000);
    await flush();
    assert.equal(pushTestControl.calls().length, PUSH_ROTATION_RETRY_DELAYS_MS.length + 1);

    hostAvailable = true;
    setAppState("background");
    setAppState("active");
    await flush();

    assert.equal(pushTestControl.calls().length, PUSH_ROTATION_RETRY_DELAYS_MS.length + 2);
    assert.equal(getPushStates()["machine-a"], "registered");
    assert.equal(pushTestControl.storedToken(), "ExponentPushToken[rot-degraded]");
    assert.deepEqual(observed.slice(-2), ["degraded", "registered"]);
  } finally {
    unsubscribe();
    await unregisterPush(machineA);
    t.mock.timers.reset();
    pushTestControl.reset();
  }
});

test("newer push token rotation supersedes both scheduled retries and in-flight older rotations", { skip }, async t => {
  const { PUSH_ROTATION_RETRY_DELAYS_MS, getPushStates, pushTestControl, registerForPush, unregisterPush } = env!;
  pushTestControl.reset();
  t.mock.timers.enable({ apis: ["setTimeout"] });

  try {
    assert.equal(await registerForPush(machineA), "registered");
    pushTestControl.clearCalls();

    let mode: "fail-first" | "succeed-second" | "hold-third" | "succeed-fourth" = "fail-first";
    let releaseHeld!: (value: { data: string }) => void;
    pushTestControl.setTokenFetcher(async () => {
      if (mode === "fail-first") throw new Error("first rotation failed");
      if (mode === "succeed-second") return { data: "ExponentPushToken[second]" };
      if (mode === "hold-third") {
        return await new Promise<{ data: string }>(resolve => {
          releaseHeld = resolve;
        });
      }
      return { data: "ExponentPushToken[fourth]" };
    });

    pushTestControl.emitTokenRotation();
    await flush();
    assert.equal(pushTestControl.calls().length, 0);

    t.mock.timers.tick(300);
    mode = "succeed-second";
    pushTestControl.emitTokenRotation();
    await flush();
    assert.equal(pushTestControl.calls().length, 1);
    assert.equal((pushTestControl.calls()[0]!.body as { token: string }).token, "ExponentPushToken[second]");
    assert.equal(pushTestControl.storedToken(), "ExponentPushToken[second]");

    t.mock.timers.tick(PUSH_ROTATION_RETRY_DELAYS_MS[0] * 5);
    await flush();
    assert.equal(pushTestControl.calls().length, 1);

    mode = "hold-third";
    pushTestControl.emitTokenRotation();
    await flush();
    assert.equal(typeof releaseHeld, "function");

    mode = "succeed-fourth";
    pushTestControl.emitTokenRotation();
    await flush();
    assert.equal(pushTestControl.calls().length, 2);
    assert.equal((pushTestControl.calls()[1]!.body as { token: string }).token, "ExponentPushToken[fourth]");
    assert.equal(pushTestControl.storedToken(), "ExponentPushToken[fourth]");

    releaseHeld({ data: "ExponentPushToken[stale-third]" });
    await flush();
    assert.equal(pushTestControl.calls().length, 2);
    assert.equal(pushTestControl.storedToken(), "ExponentPushToken[fourth]");
    assert.equal(getPushStates()["machine-a"], "registered");
  } finally {
    await unregisterPush(machineA);
    t.mock.timers.reset();
    pushTestControl.reset();
  }
});

test("unregisterPush cleans up pending retry timers, listeners, and in-flight rotations", { skip }, async t => {
  const { getPushStates, pushTestControl, registerForPush, setAppState, unregisterPush } = env!;
  pushTestControl.reset();
  t.mock.timers.enable({ apis: ["setTimeout"] });

  try {
    assert.equal(await registerForPush(machineA), "registered");
    assert.equal(await registerForPush(machineB), "registered");
    assert.equal(pushTestControl.tokenListenerCount(), 1);
    assert.equal(pushTestControl.appStateListenerCount(), 1);
    pushTestControl.clearCalls();

    pushTestControl.setTokenFetcher(async () => ({ data: "ExponentPushToken[rot-partial]" }));
    pushTestControl.setApiHandler(async (connection, _path, init) => {
      if (init?.method !== "DELETE" && connection.id === "machine-b") throw new Error("b offline");
      return {};
    });

    pushTestControl.emitTokenRotation();
    await flush();
    await unregisterPush(machineB);
    await flush();
    assert.equal(getPushStates()["machine-b"], undefined);
    assert.equal(getPushStates()["machine-a"], "registered");
    assert.equal(pushTestControl.tokenListenerCount(), 1);

    pushTestControl.clearCalls();
    pushTestControl.setTokenFetcher(async () => {
      throw new Error("rotation failure before teardown");
    });
    pushTestControl.emitTokenRotation();
    await flush();

    await unregisterPush(machineA);
    await flush();
    assert.equal(pushTestControl.tokenListenerCount(), 0);
    assert.equal(pushTestControl.appStateListenerCount(), 0);
    assert.deepEqual(getPushStates(), {});

    pushTestControl.clearCalls();
    t.mock.timers.tick(60_000);
    setAppState("background");
    setAppState("active");
    await flush();
    assert.equal(pushTestControl.calls().length, 0);

    pushTestControl.setTokenFetcher(async () => ({ data: "ExponentPushToken[re-registered]" }));
    pushTestControl.setApiHandler(async () => ({}));
    assert.equal(await registerForPush(machineA), "registered");
    assert.equal(pushTestControl.tokenListenerCount(), 1);
    assert.equal(pushTestControl.appStateListenerCount(), 1);

    let rejectInFlight!: (error: Error) => void;
    pushTestControl.setTokenFetcher(() => new Promise((_resolve, reject) => {
      rejectInFlight = reject;
    }));
    pushTestControl.emitTokenRotation();
    await flush();
    await unregisterPush(machineA);
    rejectInFlight(new Error("late failure after teardown"));
    await flush();
    assert.deepEqual(getPushStates(), {});
    pushTestControl.clearCalls();
    t.mock.timers.tick(60_000);
    await flush();
    assert.equal(pushTestControl.calls().length, 0);
  } finally {
    await unregisterPush(machineA);
    await unregisterPush(machineB);
    t.mock.timers.reset();
    pushTestControl.reset();
  }
});
