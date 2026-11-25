import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";

const harness = fileURLToPath(new URL("./fixtures/mobile-focus-harness.ts", import.meta.url));
const standInPath = fileURLToPath(new URL("./fixtures/mobile-focus-native.ts", import.meta.url));

const standIns: Plugin = {
  name: "mobile-focus-native",
  setup(builder) {
    builder.onResolve({ filter: /^(expo-router|react|react-native)$/ }, () => ({ path: standInPath }));
    builder.onResolve({ filter: /^\.\/client$/ }, () => ({ path: standInPath }));
  },
};

type Monitor = {
  pollCalls: number;
  liveLoads: number;
  opens: number;
  closes: number;
  resolveFirstPoll(value: string): void;
  failPolls(value: boolean): void;
  holdNextLiveLoad(): void;
  resolveLiveLoad(value: string): void;
  rejectLiveLoad(error: Error): void;
};
type LiveView = { data: string | null; online: boolean; loading: boolean; stale: boolean };
type View = { read(): { poll: { data: string | null; stale: boolean }; live: { data: string | null } }; unmount(): void };
type Runtime = { mount(): View; mountLive(): { read(): LiveView; unmount(): void }; monitor: Monitor; setFocused(value: boolean): void };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("covered phone screens pause polls and live topics, then refresh on focus", async () => {
  const bundle = await build({ entryPoints: [harness], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", plugins: [standIns] });
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`) as Runtime;
  const view = runtime.mount();
  const waitFor = async (predicate: () => boolean, message: string, timeout = 3000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, message);
      await wait(10);
    }
  };

  try {
    await waitFor(() => runtime.monitor.pollCalls === 1 && runtime.monitor.opens === 1, "initial poll and live subscription did not start");
    runtime.setFocused(false);
    view.read();
    runtime.monitor.resolveFirstPoll("from-before-blur");
    await wait(80);
    assert.equal(view.read().poll.data, null, "a response started before blur must not update the returning screen");
    assert.equal(runtime.monitor.closes, 1, "the blurred screen releases its live topic");
    const blurred = { ...runtime.monitor };
    await wait(120);
    assert.equal(runtime.monitor.pollCalls, blurred.pollCalls, "poll timer stays stopped while the route is covered");
    assert.equal(runtime.monitor.liveLoads, blurred.liveLoads, "fallback reads stay stopped while the route is covered");

    runtime.setFocused(true);
    view.read();
    await waitFor(() => runtime.monitor.pollCalls >= 2 && runtime.monitor.liveLoads >= 2 && runtime.monitor.opens >= 2, "focus did not refresh and resubscribe immediately");
    await waitFor(() => view.read().poll.data !== null, "return poll did not produce fresh data");
    assert.notEqual(view.read().poll.data, "from-before-blur");

    runtime.monitor.failPolls(true);
    runtime.setFocused(false);
    view.read();
    runtime.setFocused(true);
    view.read();
    await waitFor(() => runtime.monitor.pollCalls >= 3, "return poll after a route change did not start");
    await wait(100);
    assert.equal(view.read().poll.stale, false, "stale UI remains delayed after a failed return poll");
    await waitFor(() => view.read().poll.stale, "stale UI did not appear after the existing delay", 3500);
  } finally {
    view.unmount();
  }
});

test("useLive reports online when the event stream opens before the initial load settles or after it fails", async () => {
  const bundle = await build({ entryPoints: [harness], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", plugins: [standIns] });
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`) as Runtime;
  runtime.setFocused(true);
  runtime.monitor.holdNextLiveLoad();
  const initialOpens = runtime.monitor.opens;
  const view = runtime.mountLive();
  try {
    const deadline = Date.now() + 2000;
    while (runtime.monitor.opens === initialOpens) {
      assert.ok(Date.now() < deadline, "event stream did not open");
      await wait(10);
    }
    await wait(20);
    const pending = view.read();
    assert.equal(pending.online, true);
    assert.equal(pending.loading, true);
    assert.equal(pending.data, null);
    assert.equal(pending.stale, false);

    runtime.monitor.rejectLiveLoad(new Error("initial load failed"));
    await wait(20);
    const failedLoad = view.read();
    assert.equal(failedLoad.online, true);
    assert.equal(failedLoad.loading, false);
    assert.equal(failedLoad.data, null);
    assert.equal(failedLoad.stale, false);
  } finally {
    view.unmount();
  }
});
