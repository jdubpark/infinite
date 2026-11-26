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
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};
const machineA = { id: "machine-a", url: "http://127.0.0.1:4101", token: "tok-a" };
const machineB = { id: "machine-b", url: "http://127.0.0.1:4102", token: "tok-b" };

test("push token rotation passes devicePushToken on initial attempt and retries without self-superseding", { skip }, async t => {
  const { PUSH_ROTATION_RETRY_DELAYS_MS, getPushStates, pushTestControl, registerForPush, unregisterPush } = env!;
  pushTestControl.reset();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    assert.equal(await registerForPush(machineA), "registered");
    assert.equal(await registerForPush(machineB), "registered");
    pushTestControl.clearCalls();
    pushTestControl.clearTokenFetchOptions();
    pushTestControl.setReemitWhenDeviceTokenOmitted(true);

    const rotatedDeviceToken = { type: "android" as const, data: "fcm-rotated-token-1" };
    let tokenAttempts = 0;
    let machineBFailures = 1;
    pushTestControl.setTokenFetcher(async options => {
      assert.deepEqual(options?.devicePushToken, rotatedDeviceToken);
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

    pushTestControl.emitTokenRotation(rotatedDeviceToken);
    await flush();
    assert.equal(tokenAttempts, 1);
    assert.equal(pushTestControl.calls().length, 0);
    assert.deepEqual(pushTestControl.tokenFetchOptions(), [
      { projectId: "test-eas-project", devicePushToken: rotatedDeviceToken },
    ]);

    t.mock.timers.tick(PUSH_ROTATION_RETRY_DELAYS_MS[0] - 1);
    await flush();
    assert.equal(tokenAttempts, 1);

    t.mock.timers.tick(1);
    await flush();
    assert.equal(tokenAttempts, 2);
    assert.deepEqual(pushTestControl.tokenFetchOptions(), [
      { projectId: "test-eas-project", devicePushToken: rotatedDeviceToken },
      { projectId: "test-eas-project", devicePushToken: rotatedDeviceToken },
    ]);
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

test("unregisterPush deletes the rotated token accepted by a disconnecting machine while another machine is still offline", { skip }, async t => {
  const { pushTestControl, registerForPush, unregisterPush } = env!;
  pushTestControl.reset();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    assert.equal(await registerForPush(machineA), "registered");
    assert.equal(await registerForPush(machineB), "registered");
    pushTestControl.clearCalls();

    pushTestControl.setTokenFetcher(async () => ({ data: "ExponentPushToken[rot-partial-a]" }));
    pushTestControl.setApiHandler(async (connection, _path, init) => {
      if (init?.method !== "DELETE" && connection.id === "machine-b") {
        throw new Error("machine-b offline");
      }
      return {};
    });

    pushTestControl.emitTokenRotation({ type: "android", data: "fcm-partial-a" });
    await flush();
    assert.equal(pushTestControl.storedToken(), "ExponentPushToken[initial]");

    pushTestControl.clearCalls();
    await unregisterPush(machineA);
    await flush();

    const deletedForA = pushTestControl
      .calls()
      .filter(call => call.key === "machine-a" && call.method === "DELETE" && call.path === "/devices/push")
      .map(call => (call.body as { token: string }).token)
      .sort();
    assert.deepEqual(deletedForA, ["ExponentPushToken[initial]", "ExponentPushToken[rot-partial-a]"]);
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

    pushTestControl.emitTokenRotation({ type: "ios", data: "apns-degraded" });
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

test("in-flight registerForPush does not clobber a newer rotation retry or degraded state", { skip }, async t => {
  const { PUSH_ROTATION_RETRY_DELAYS_MS, getPushStates, pushTestControl, registerForPush, unregisterPush } = env!;
  pushTestControl.reset();
  t.mock.timers.enable({ apis: ["setTimeout"] });

  try {
    assert.equal(await registerForPush(machineA), "registered");
    pushTestControl.clearCalls();

    let releaseStaleRegisterPost!: () => void;
    let failRotatedPosts = true;
    pushTestControl.setTokenFetcher(async options => ({
      data: options?.devicePushToken ? "ExponentPushToken[rot-newer]" : "ExponentPushToken[stale-register]",
    }));
    pushTestControl.setApiHandler(async (_connection, _path, init) => {
      const token = (init?.body as { token?: string } | undefined)?.token;
      if (token === "ExponentPushToken[stale-register]") {
        await new Promise<void>(resolve => {
          releaseStaleRegisterPost = resolve;
        });
        return {};
      }
      if (token === "ExponentPushToken[rot-newer]" && failRotatedPosts) {
        throw new Error("rotated post failed");
      }
      return {};
    });

    const inFlightRegister = registerForPush(machineA);
    await flush();
    assert.equal(typeof releaseStaleRegisterPost, "function");

    pushTestControl.emitTokenRotation({ type: "android", data: "fcm-newer" });
    await flush();
    for (const delay of PUSH_ROTATION_RETRY_DELAYS_MS) {
      t.mock.timers.tick(delay);
      await flush();
    }
    assert.equal(getPushStates()["machine-a"], "degraded");

    releaseStaleRegisterPost();
    const returnedState = await inFlightRegister;
    await flush();
    assert.equal(returnedState, "degraded");
    assert.equal(getPushStates()["machine-a"], "degraded");
    assert.equal(pushTestControl.storedToken(), "ExponentPushToken[initial]");

    let releaseSecondStalePost!: () => void;
    pushTestControl.setTokenFetcher(async options => ({
      data: options?.devicePushToken ? "ExponentPushToken[rot-retry-still-active]" : "ExponentPushToken[stale-register-2]",
    }));
    pushTestControl.setApiHandler(async (_connection, _path, init) => {
      const token = (init?.body as { token?: string } | undefined)?.token;
      if (token === "ExponentPushToken[stale-register-2]") {
        await new Promise<void>(resolve => {
          releaseSecondStalePost = resolve;
        });
        return {};
      }
      if (token === "ExponentPushToken[rot-retry-still-active]" && failRotatedPosts) {
        throw new Error("first attempt fails");
      }
      return {};
    });

    const secondInFlight = registerForPush(machineA);
    await flush();
    pushTestControl.emitTokenRotation({ type: "android", data: "fcm-retry-active" });
    await flush();

    releaseSecondStalePost();
    await secondInFlight;
    await flush();

    failRotatedPosts = false;
    t.mock.timers.tick(PUSH_ROTATION_RETRY_DELAYS_MS[0]!);
    await flush();
    assert.equal(pushTestControl.storedToken(), "ExponentPushToken[rot-retry-still-active]");
    assert.equal(getPushStates()["machine-a"], "registered");
  } finally {
    await unregisterPush(machineA);
    t.mock.timers.reset();
    pushTestControl.reset();
  }
});

test("registerForPush observing denied or unavailable evicts the profile so rotation retries never flip it back to registered", { skip }, async t => {
  const { PUSH_ROTATION_RETRY_DELAYS_MS, getPushStates, pushTestControl, registerForPush, unregisterPush } = env!;
  pushTestControl.reset();
  t.mock.timers.enable({ apis: ["setTimeout"] });

  try {
    assert.equal(await registerForPush(machineA), "registered");
    assert.equal(await registerForPush(machineB), "registered");
    pushTestControl.clearCalls();

    let failBoth = true;
    pushTestControl.setTokenFetcher(async () => ({ data: "ExponentPushToken[rot-after-revoke]" }));
    pushTestControl.setApiHandler(async () => {
      if (failBoth) throw new Error("temporary offline");
      return {};
    });

    pushTestControl.emitTokenRotation({ type: "ios", data: "apns-revoke" });
    await flush();

    pushTestControl.setPermissionStatus("denied");
    assert.equal(await registerForPush(machineA), "denied");
    assert.equal(getPushStates()["machine-a"], "denied");

    failBoth = false;
    t.mock.timers.tick(PUSH_ROTATION_RETRY_DELAYS_MS[0]!);
    await flush();

    assert.equal(getPushStates()["machine-a"], "denied");
    assert.equal(getPushStates()["machine-b"], "registered");
    assert.equal(pushTestControl.storedToken(), "ExponentPushToken[rot-after-revoke]");

    pushTestControl.setIsDevice(false);
    assert.equal(await registerForPush(machineB), "unavailable");
    assert.equal(getPushStates()["machine-b"], "unavailable");
    assert.equal(pushTestControl.tokenListenerCount(), 0);
    assert.equal(pushTestControl.appStateListenerCount(), 0);

    pushTestControl.clearCalls();
    t.mock.timers.tick(60_000);
    await flush();
    assert.equal(pushTestControl.calls().length, 0);
    assert.equal(getPushStates()["machine-a"], "denied");
    assert.equal(getPushStates()["machine-b"], "unavailable");
  } finally {
    await unregisterPush(machineA);
    await unregisterPush(machineB);
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

    pushTestControl.emitTokenRotation({ type: "android", data: "fcm-1" });
    await flush();
    assert.equal(pushTestControl.calls().length, 0);

    t.mock.timers.tick(300);
    mode = "succeed-second";
    pushTestControl.emitTokenRotation({ type: "android", data: "fcm-2" });
    await flush();
    assert.equal(pushTestControl.calls().length, 1);
    assert.equal((pushTestControl.calls()[0]!.body as { token: string }).token, "ExponentPushToken[second]");
    assert.equal(pushTestControl.storedToken(), "ExponentPushToken[second]");

    t.mock.timers.tick(PUSH_ROTATION_RETRY_DELAYS_MS[0] * 5);
    await flush();
    assert.equal(pushTestControl.calls().length, 1);

    mode = "hold-third";
    pushTestControl.emitTokenRotation({ type: "android", data: "fcm-3" });
    await flush();
    assert.equal(typeof releaseHeld, "function");

    mode = "succeed-fourth";
    pushTestControl.emitTokenRotation({ type: "android", data: "fcm-4" });
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

    pushTestControl.emitTokenRotation({ type: "android", data: "fcm-partial" });
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
    pushTestControl.emitTokenRotation({ type: "android", data: "fcm-before-teardown" });
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
    pushTestControl.emitTokenRotation({ type: "android", data: "fcm-in-flight" });
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
