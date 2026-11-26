import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import type { RunRequest } from "../apps/mobile/src/store/requests";

function loadRequestsEnv() {
  if (typeof nodeModule.registerHooks !== "function") return undefined;
  const hooksUrl = new URL("./fixtures/react-hooks.ts", import.meta.url).href;
  const nativeUrl = new URL("./fixtures/mobile-native.ts", import.meta.url).href;
  const clientStubUrl = new URL("./fixtures/mobile-run-request-native.ts", import.meta.url).href;
  nodeModule.registerHooks({
    resolve: (specifier, context, next) => {
      if (specifier === "react") return { url: hooksUrl, shortCircuit: true };
      if (specifier === "expo-crypto") return { url: nativeUrl, shortCircuit: true };
      if (specifier === "../../api/client" && context.parentURL?.endsWith("/apps/mobile/src/features/teams/useRunRequest.ts")) {
        return { url: clientStubUrl, shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
  const require = nodeModule.createRequire(import.meta.url);
  return {
    ...(require("../apps/mobile/src/store/requests.ts") as typeof import("../apps/mobile/src/store/requests.ts")),
    ...(require("../apps/mobile/src/features/teams/useRunRequest.ts") as typeof import("../apps/mobile/src/features/teams/useRunRequest.ts")),
    ...(require("./fixtures/react-hooks.ts") as typeof import("./fixtures/react-hooks.ts")),
    ...(require("./fixtures/mobile-run-request-native.ts") as typeof import("./fixtures/mobile-run-request-native.ts")),
  };
}

const env = loadRequestsEnv();
const skip = !env && "module.registerHooks requires Node 22.15+";

test("dismissing a settled run receipt removes its cache entry but keeps pending requests", { skip }, () => {
  const { runRequests } = env!;
  const settledKey = "test-machine/test-run-settled";
  runRequests.begin(settledKey, { requestId: "settled-request", revision: 1, path: "/run", label: "Steer", fields: {} });
  runRequests.complete(settledKey, "settled-request", { id: "result" }, "Steer recorded.");
  runRequests.clearMessage(settledKey);
  assert.deepEqual(runRequests.read(settledKey), { message: "" });

  const pendingKey = "test-machine/test-run-pending";
  const pending = { requestId: "pending-request", revision: 2, path: "/run", label: "Answer", fields: {} };
  runRequests.begin(pendingKey, pending);
  runRequests.fail(pendingKey, pending.requestId, "Delivery is unconfirmed.");
  runRequests.clearMessage(pendingKey);
  assert.equal(runRequests.read(pendingKey).pending?.requestId, pending.requestId);
  assert.equal(runRequests.read(pendingKey).message, "");
  runRequests.clear(pendingKey);
});

test("runRequests preserves numeric and string fields across begin, failure, and retry reads", { skip }, () => {
  const { runRequests } = env!;
  const key = "test-machine/mission/extend-1";
  const request: RunRequest = {
    requestId: "extend-request-1",
    revision: 4,
    path: "/missions/m1/extend",
    label: "Time extension",
    fields: { minutes: 30, reason: "finish review" },
  };
  try {
    const started = runRequests.begin(key, request);
    assert.equal(started.fields.minutes, 30);
    assert.equal(typeof started.fields.minutes, "number");
    assert.equal(started.fields.reason, "finish review");

    runRequests.fail(key, request.requestId, "Delivery is unconfirmed.");
    const pending = runRequests.read(key).pending;
    assert.ok(pending);
    assert.equal(pending.fields.minutes, 30);
    assert.equal(typeof pending.fields.minutes, "number");
    assert.equal(pending.fields.reason, "finish review");

    assert.equal(runRequests.complete(key, request.requestId, { id: "m1" }, "Time extension recorded."), true);
    assert.equal(runRequests.read(key).pending, undefined);
  } finally {
    runRequests.clear(key);
  }
});

test("useRunRequest sends numeric fields without casting and preserves them on retry", { skip }, async () => {
  const { ApiError, renderHook, runRequests, setRunRequestApiHandler, useRunRequest } = env!;
  const sentBodies: Record<string, unknown>[] = [];
  let shouldFail = true;
  setRunRequestApiHandler(async body => {
    sentBodies.push(body as Record<string, unknown>);
    if (shouldFail) throw new ApiError("Temporary error", 503);
    return { id: "m1", revision: 5 };
  });

  const key = "test-machine/mission/use-run-request-extend";
  const accepted: RunRequest[] = [];
  const view = renderHook(() =>
    useRunRequest<{ id: string; revision: number }>(
      { id: "test-machine", url: "http://127.0.0.1", token: "tok" },
      key,
      { accepted: (_result, req) => accepted.push(req), refused: () => {} },
    ),
  );

  try {
    view.read().send("/missions/m1/extend", "Time extension", 4, { minutes: 45 });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    assert.equal(sentBodies.length, 1);
    assert.equal(sentBodies[0]!.minutes, 45);
    assert.equal(typeof sentBodies[0]!.minutes, "number");
    assert.equal(view.read().pending?.fields.minutes, 45);
    assert.equal(typeof view.read().pending?.fields.minutes, "number");

    shouldFail = false;
    view.read().retry();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    assert.equal(sentBodies.length, 2);
    assert.equal(sentBodies[1]!.minutes, 45);
    assert.equal(typeof sentBodies[1]!.minutes, "number");
    assert.equal(sentBodies[1]!.requestId, sentBodies[0]!.requestId);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]!.fields.minutes, 45);
    assert.equal(typeof accepted[0]!.fields.minutes, "number");
  } finally {
    view.unmount();
    runRequests.clear(key);
  }
});
