import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { randomUUID } from "node:crypto";
import type { ApiError, ControlLease, Connection } from "../apps/mobile/src/api/client.ts";
import { LIVE_STALE_DELAY_MS } from "../apps/mobile/src/api/liveStatus.ts";
import { connectRemoteAccess } from "../packages/host/src/remote-access.js";
import { inProcessHost } from "./helpers.js";
import { httpRunner, wireProxy } from "./remote-fixture.js";

/** Load phone modules with Node stand-ins for React Native, Expo and React. */
function loadPhone() {
  if (typeof nodeModule.registerHooks !== "function") return undefined;
  const native = new URL("./fixtures/mobile-native.ts", import.meta.url).href;
  const hooks = new URL("./fixtures/react-hooks.ts", import.meta.url).href;
  const stubs: Record<string, string> = {
    "react-native": native,
    "expo-crypto": native,
    "expo-secure-store": native,
    react: hooks,
    "expo-router": hooks,
  };
  nodeModule.registerHooks({
    resolve: (specifier, context, next) => {
      if (Object.hasOwn(stubs, specifier)) return { url: stubs[specifier], shortCircuit: true };
      if (specifier === "./client" && context.parentURL?.endsWith("/apps/mobile/src/api/useLive.ts"))
        return { url: native, shortCircuit: true };
      return next(specifier, context);
    },
  });
  const require = nodeModule.createRequire(import.meta.url);
  const client = require("../apps/mobile/src/api/client.ts") as typeof import("../apps/mobile/src/api/client.ts");
  return {
    ...client,
    openRemoteEvents: client.openEvents,
    ...(require("../apps/mobile/src/api/useLive.ts") as typeof import("../apps/mobile/src/api/useLive.ts")),
    ...(require("../apps/mobile/src/api/usePoll.ts") as typeof import("../apps/mobile/src/api/usePoll.ts")),
    ...(require("../apps/mobile/src/features/session/useSessionControl.ts") as typeof import("../apps/mobile/src/features/session/useSessionControl.ts")),
    ...(require("./fixtures/mobile-native.ts") as typeof import("./fixtures/mobile-native.ts")),
    ...(require("./fixtures/react-hooks.ts") as typeof import("./fixtures/react-hooks.ts")),
  };
}

const phone = loadPhone();
const skip = !phone && "module.registerHooks requires Node 22.15+";
const connection: Connection = { url: "http://127.0.0.1", token: "test-token" };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function mountLive(load: () => Promise<string>, after: () => number = () => 0) {
  const { renderHook, useLive } = phone!;
  return renderHook(() => useLive(connection, {
    topics: ["sessions"],
    intervalMs: 4000,
    deps: [],
    load,
    select: () => undefined,
    after,
  }));
}

test("useLive treats inactive as foreground and keeps its stream and fresh state", { skip }, async t => {
  const { AppState, getEventOpenAttempts, resetEventStreams, setAppState } = phone!;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  resetEventStreams();
  setAppState("active");
  let loads = 0;
  const view = mountLive(async () => { loads++; return "snapshot"; });
  const status = () => { const { online, stale } = view.read(); return { online, stale }; };
  try {
    await flush();
    assert.deepEqual(status(), { online: true, stale: false });
    assert.equal(getEventOpenAttempts(), 1);

    setAppState("inactive");
    t.mock.timers.tick(LIVE_STALE_DELAY_MS + 1000);
    await flush();
    assert.equal(AppState.currentState, "inactive");
    assert.deepEqual(status(), { online: true, stale: false }, "inactive is still a foreground state");
    assert.equal(loads, 1, "the live stream keeps the view current without polling");
    assert.equal(getEventOpenAttempts(), 1, "inactive does not replace the open stream");
  } finally {
    view.unmount();
    t.mock.timers.reset();
    setAppState("active");
    resetEventStreams();
  }
});

test("useLive keeps its established stream and refreshes once after a brief background return", { skip }, async t => {
  const { getEventOpenAttempts, isEventStreamClosed, resetEventStreams, setAppState, setEventStreamsUnavailable } = phone!;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  resetEventStreams();
  setAppState("active");
  let loads = 0;
  const view = mountLive(async () => {
    loads++;
    return "snapshot";
  });
  const status = () => { const { online, stale } = view.read(); return { online, stale }; };
  try {
    await flush();
    assert.deepEqual(status(), { online: true, stale: false });
    assert.equal(loads, 1);

    setAppState("background");
    setEventStreamsUnavailable(true);
    t.mock.timers.tick(1000);
    assert.deepEqual(status(), { online: true, stale: false }, "backgrounding does not mutate the cached live status");
    setAppState("active");
    await flush();
    assert.deepEqual(status(), { online: true, stale: false }, "the established stream remains live on return");
    assert.equal(loads, 2, "returning refreshes exactly once");
    assert.equal(getEventOpenAttempts(), 1, "return does not open a replacement stream");
    assert.equal(isEventStreamClosed(0), false, "the existing stream remains open");
  } finally {
    view.unmount();
    t.mock.timers.reset();
    setEventStreamsUnavailable(false);
    setAppState("active");
    resetEventStreams();
  }
});

test("useLive stays offline and starts stale grace while a brief-return catch-up is pending", { skip }, async t => {
  const { resetEventStreams, setAppState } = phone!;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  resetEventStreams();
  setAppState("active");
  let loads = 0, resolveCatchup!: (value: string) => void;
  const view = mountLive(async () => {
    if (++loads === 1) return "snapshot";
    return new Promise<string>(resolve => { resolveCatchup = resolve; });
  });
  const status = () => { const { online, stale } = view.read(); return { online, stale }; };
  try {
    await flush();
    assert.deepEqual(status(), { online: true, stale: false });

    setAppState("background");
    setAppState("active");
    await flush();
    assert.equal(loads, 2, "return starts one catch-up read");
    assert.deepEqual(status(), { online: false, stale: false }, "the retained socket is unverified until fresh evidence arrives");

    t.mock.timers.tick(LIVE_STALE_DELAY_MS);
    await flush();
    assert.deepEqual(status(), { online: false, stale: true }, "stale grace starts when the app returns, even while the read is pending");

    resolveCatchup("fresh snapshot");
    await flush();
    assert.deepEqual(status(), { online: true, stale: false }, "a successful catch-up read verifies the retained connection");
  } finally {
    resolveCatchup?.("fresh snapshot");
    view.unmount();
    t.mock.timers.reset();
    setAppState("active");
    resetEventStreams();
  }
});

test("useLive accepts a post-return event as fresh evidence while catch-up is pending", { skip }, async t => {
  const { emitEvent, resetEventStreams, setAppState } = phone!;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  resetEventStreams();
  setAppState("active");
  let loads = 0, resolveCatchup!: (value: string) => void;
  const view = mountLive(async () => {
    if (++loads === 1) return "snapshot";
    return new Promise<string>(resolve => { resolveCatchup = resolve; });
  });
  const status = () => { const { online, stale } = view.read(); return { online, stale }; };
  try {
    await flush();
    setAppState("background");
    setAppState("active");
    await flush();
    assert.deepEqual(status(), { online: false, stale: false }, "the retained socket is initially unverified");

    emitEvent(0, { topic: "sessions", data: { status: "changed" } });
    assert.deepEqual(status(), { online: true, stale: false }, "an event delivered after return verifies the retained stream");
  } finally {
    resolveCatchup?.("fresh snapshot");
    await flush();
    view.unmount();
    t.mock.timers.reset();
    setAppState("active");
    resetEventStreams();
  }
});

test("useLive reconnects from the last applied cursor if the return catch-up read fails", { skip }, async t => {
  const { emitEvent, getEventOpenAfter, getEventOpenAttempts, resetEventStreams, setAppState } = phone!;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  resetEventStreams();
  setAppState("active");
  const topic = "session/00000000-0000-4000-8000-000000000000";
  const journal = [{ cursor: 1, value: "one" }];
  let cursor = 0, loads = 0, available = true;
  let events: string[] = [];
  const view = phone!.renderHook(() => phone!.useLive(connection, {
    topics: [topic],
    intervalMs: 4000,
    deps: [],
    after: () => cursor,
    async load() {
      loads++;
      if (!available) throw new Error("catch-up read unavailable");
      const next = journal.filter(event => event.cursor > cursor);
      events = [...events, ...next.map(event => event.value)];
      cursor = Math.max(cursor, ...next.map(event => event.cursor), cursor);
      return { cursor, events: [...events] };
    },
    select(eventTopic, payload) {
      if (eventTopic !== topic) return;
      const event = payload as { cursor: number; value: string };
      cursor = Math.max(cursor, event.cursor);
      events = [...events, event.value];
      return { cursor, events: [...events] };
    },
  }));
  try {
    await flush();
    assert.equal(view.read().data?.cursor, 1);
    assert.equal(getEventOpenAttempts(), 1);

    setAppState("background");
    const missed = { topic, data: { cursor: 2, value: "two" } };
    journal.push(missed.data);
    emitEvent(0, missed);
    available = false;
    setAppState("active");
    await flush();

    assert.equal(loads, 2, "return makes one catch-up read");
    assert.equal(getEventOpenAttempts(), 2, "a failed catch-up replaces the live subscription");
    assert.equal(getEventOpenAfter(1), 1, "reconnect starts from the last applied cursor");
    assert.deepEqual(view.read().data, { cursor: 2, events: ["one", "two"] }, "the new subscription replays the event missed in background");

    emitEvent(1, { topic, data: { cursor: 3, value: "three" } });
    assert.deepEqual(view.read().data, { cursor: 3, events: ["one", "two", "three"] });
  } finally {
    view.unmount();
    t.mock.timers.reset();
    setAppState("active");
    resetEventStreams();
  }
});

test("useLive restarts a shared stream when one consumer cannot catch up", { skip }, async t => {
  const { emitEvent, getEventOpenAfter, getEventOpenAttempts, isEventStreamClosed, resetEventStreams, setAppState } = phone!;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  resetEventStreams();
  setAppState("active");
  const topic = "session/00000000-0000-4000-8000-000000000000";
  const firstEvents = ["one"], secondEvents = ["one"];
  let firstCursor = 1, secondCursor = 1, firstLoads = 0, secondLoads = 0;
  const makeView = (which: "first" | "second") => phone!.renderHook(() => phone!.useLive(connection, {
    topics: [topic], intervalMs: 4000, deps: [],
    after: () => which === "first" ? firstCursor : secondCursor,
    async load() {
      if (which === "first") {
        firstLoads++;
        if (firstLoads === 2) throw new Error("catch-up read unavailable");
        return { cursor: firstCursor, events: [...firstEvents] };
      }
      secondLoads++;
      return { cursor: secondCursor, events: [...secondEvents] };
    },
    select(eventTopic, payload) {
      if (eventTopic !== topic) return;
      const event = payload as { cursor: number; value: string };
      if (which === "first") {
        firstCursor = Math.max(firstCursor, event.cursor);
        firstEvents.push(event.value);
        return { cursor: firstCursor, events: [...firstEvents] };
      }
      secondCursor = Math.max(secondCursor, event.cursor);
      secondEvents.push(event.value);
      return { cursor: secondCursor, events: [...secondEvents] };
    },
  }));
  const first = makeView("first"), second = makeView("second");
  try {
    await flush();
    assert.equal(getEventOpenAttempts(), 1, "both hooks share one underlying event stream");

    setAppState("background");
    assert.equal(isEventStreamClosed(0), false, "the shared stream stays open during the grace");
    emitEvent(0, { topic, data: { cursor: 2, value: "two" } });
    setAppState("active");
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(firstLoads, 2);
    assert.equal(secondLoads, 2, "the other stream consumer completes its own return read");
    assert.equal(getEventOpenAttempts(), 2, "recovery replaces the shared underlying stream");
    assert.equal(getEventOpenAfter(1), 1, "the replacement replays from the oldest active consumer cursor");
    assert.deepEqual(first.read().data, { cursor: 2, events: ["one", "two"] }, "the failed consumer receives the missed event by replay");
    assert.deepEqual(second.read().data, { cursor: 2, events: ["one", "two"] }, "all consumers stay attached to the replacement stream");
  } finally {
    first.unmount(); second.unmount();
    t.mock.timers.reset();
    setAppState("active");
    resetEventStreams();
  }
});

test("useLive coalesces overlapping shared-stream restarts", { skip }, async t => {
  const { emitEvent, getEventOpenAttempts, holdNextEventOpen, resetEventStreams, setAppState } = phone!;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  resetEventStreams();
  setAppState("active");
  const topic = "session/00000000-0000-4000-8000-000000000000";
  const firstEvents = ["one"], secondEvents = ["one"];
  let firstCursor = 1, secondCursor = 1, firstLoads = 0, secondLoads = 0;
  let resolveFirst!: (value: { cursor: number; events: string[] }) => void;
  let rejectSecond!: (error: Error) => void;
  let releaseOpen: (() => void) | undefined;
  const makeView = (which: "first" | "second") => phone!.renderHook(() => phone!.useLive(connection, {
    topics: [topic], intervalMs: 4000, deps: [],
    after: () => which === "first" ? firstCursor : secondCursor,
    load() {
      if (which === "first") {
        firstLoads++;
        if (firstLoads === 2) return new Promise(resolve => { resolveFirst = resolve; });
        return Promise.resolve({ cursor: firstCursor, events: [...firstEvents] });
      }
      secondLoads++;
      if (secondLoads === 2) return new Promise((_resolve, reject) => { rejectSecond = reject; });
      return Promise.resolve({ cursor: secondCursor, events: [...secondEvents] });
    },
    select(eventTopic, payload) {
      if (eventTopic !== topic) return;
      const event = payload as { cursor: number; value: string };
      if (which === "first") {
        firstCursor = Math.max(firstCursor, event.cursor);
        firstEvents.push(event.value);
        return { cursor: firstCursor, events: [...firstEvents] };
      }
      secondCursor = Math.max(secondCursor, event.cursor);
      secondEvents.push(event.value);
      return { cursor: secondCursor, events: [...secondEvents] };
    },
  }));
  const first = makeView("first"), second = makeView("second");
  try {
    await flush();
    setAppState("background");
    setAppState("active");
    await flush();
    assert.equal(firstLoads, 2);
    assert.equal(secondLoads, 2);
    emitEvent(0, { topic, data: { cursor: 2, value: "two" } });
    releaseOpen = holdNextEventOpen();

    resolveFirst({ cursor: firstCursor, events: [...firstEvents] });
    await flush();
    assert.equal(getEventOpenAttempts(), 2, "the first return read starts one replacement stream");
    rejectSecond(new Error("catch-up read unavailable"));
    await flush();
    assert.equal(getEventOpenAttempts(), 2, "the second consumer joins the in-flight shared restart");
    assert.equal(second.read().online, false, "a failed read cannot become online before stream recovery succeeds");

    releaseOpen();
    releaseOpen = undefined;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(getEventOpenAttempts(), 2);
    assert.deepEqual(first.read().data, { cursor: 2, events: ["one", "two"] });
    assert.deepEqual(second.read().data, { cursor: 2, events: ["one", "two"] });
    assert.equal(second.read().online, true, "the completed shared stream restores live status");
  } finally {
    releaseOpen?.();
    first.unmount(); second.unmount();
    t.mock.timers.reset();
    setAppState("active");
    resetEventStreams();
  }
});

test("useLive ignores an old ready result while a shared replacement stream is opening", { skip }, async t => {
  const { emitEvent, getEventOpenAttempts, holdNextEventOpen, isEventStreamClosed, resetEventStreams, setAppState } = phone!;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  resetEventStreams();
  setAppState("active");
  const topic = "session/00000000-0000-4000-8000-000000000000";
  const events = ["one"];
  let cursor = 1, loads = 0, rejectCatchup!: (error: Error) => void, releaseOpen: (() => void) | undefined;
  const first = phone!.renderHook(() => phone!.useLive(connection, {
    topics: [topic], intervalMs: 4000, deps: [], after: () => cursor,
    load() {
      loads++;
      if (loads === 2) return new Promise((_resolve, reject) => { rejectCatchup = reject; });
      return Promise.resolve({ cursor, events: [...events] });
    },
    select(eventTopic, payload) {
      if (eventTopic !== topic) return;
      const event = payload as { cursor: number; value: string };
      cursor = Math.max(cursor, event.cursor);
      events.push(event.value);
      return { cursor, events: [...events] };
    },
  }));
  let second: ReturnType<typeof phone.renderHook> | undefined;
  try {
    await flush();
    setAppState("background");
    setAppState("active");
    await flush();
    emitEvent(0, { topic, data: { cursor: 2, value: "two" } });
    releaseOpen = holdNextEventOpen();
    rejectCatchup(new Error("catch-up read unavailable"));
    second = phone!.renderHook(() => phone!.useLive(connection, {
      topics: [topic], intervalMs: 4000, deps: [], after: () => 0,
      load: async () => { throw new Error("snapshot unavailable"); },
      select(eventTopic, payload) {
        if (eventTopic !== topic) return;
        const event = payload as { cursor: number; value: string };
        return { cursor: event.cursor, events: [event.value] };
      },
    }));
    await flush();

    assert.equal(getEventOpenAttempts(), 2, "the original consumer started a replacement stream");
    assert.equal(second.read().online, false, "an old resolved readiness result cannot claim the replacement is open");
    assert.equal(second.read().data, null, "its failed read and pending stream provide no fresh state");
    t.mock.timers.tick(0);
    await flush();
    assert.equal(getEventOpenAttempts(), 2, "a consumer waiting on shared recovery does not schedule a duplicate attachment");

    releaseOpen();
    releaseOpen = undefined;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(second.read().online, true, "the replacement stream establishes online state when it opens");
    assert.equal(second.read().data?.cursor, 2, "replay supplies the state missed during backgrounding");
    first.unmount(); second.unmount();
    assert.equal(isEventStreamClosed(1), true, "unmounting the final consumers closes the replacement stream");
    second = undefined;
  } finally {
    releaseOpen?.();
    first.unmount(); second?.unmount();
    t.mock.timers.reset();
    setAppState("active");
    resetEventStreams();
  }
});

test("useLive clears a pending return catch-up when another background transition replaces the stream", { skip }, async t => {
  const { emitEvent, getEventOpenAttempts, resetEventStreams, markEventStreamDead, setAppState } = phone!;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  resetEventStreams();
  setAppState("active");
  const topic = "session/00000000-0000-4000-8000-000000000000";
  const events = ["one"];
  let cursor = 1, loads = 0, resolveReturn!: (value: { cursor: number; events: string[] }) => void;
  const view = phone!.renderHook(() => phone!.useLive(connection, {
    topics: [topic], intervalMs: 4000, deps: [], after: () => cursor,
    load() {
      loads++;
      if (loads === 2) return new Promise(resolve => { resolveReturn = resolve; });
      return Promise.resolve({ cursor, events: [...events] });
    },
    select(eventTopic, payload) {
      if (eventTopic !== topic) return;
      const event = payload as { cursor: number; value: string };
      cursor = Math.max(cursor, event.cursor);
      events.push(event.value);
      return { cursor, events: [...events] };
    },
  }));
  try {
    await flush();
    setAppState("background");
    setAppState("active");
    await flush();
    assert.equal(loads, 2, "the first return catch-up is still pending");

    setAppState("background");
    markEventStreamDead(0);
    emitEvent(0, { topic, data: { cursor: 2, value: "two" } });
    setAppState("active");
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(getEventOpenAttempts(), 2, "the dead stream is replaced on the next return");
    assert.deepEqual(view.read().data, { cursor: 2, events: ["one", "two"] }, "replacement replay is not held behind the abandoned catch-up");

    resolveReturn({ cursor: 1, events: ["one"] });
    await flush();
    assert.deepEqual(view.read().data, { cursor: 2, events: ["one", "two"] }, "the obsolete return read cannot overwrite replayed events");
  } finally {
    view.unmount();
    t.mock.timers.reset();
    setAppState("active");
    resetEventStreams();
  }
});

test("useLive starts its stale grace on return after an absence longer than thirty seconds", { skip }, async t => {
  const { getEventOpenAttempts, getEventOpenAfter, isEventStreamClosed, resetEventStreams, setAppState, setEventStreamsUnavailable } = phone!;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  resetEventStreams();
  setAppState("active");
  let available = true;
  let cursor = 0;
  const view = mountLive(async () => {
    if (!available) throw new Error("read unavailable");
    return "snapshot";
  }, () => cursor);
  const status = () => { const { online, stale } = view.read(); return { online, stale }; };
  try {
    await flush();
    assert.deepEqual(status(), { online: true, stale: false });
    const opened = getEventOpenAttempts();

    setAppState("background");
    available = false;
    setEventStreamsUnavailable(true);
    cursor = 42;
    // Model iOS suspending JS timers while away: advance wall time without running the grace timer.
    t.mock.timers.setTime(1_031_001);
    await flush();
    assert.deepEqual(status(), { online: true, stale: false }, "background time does not mutate live status");

    setAppState("active");
    await flush();
    assert.equal(getEventOpenAttempts(), opened + 1, "return attempts a replacement stream");
    assert.equal(isEventStreamClosed(0), true, "an expired stream closes even if its background timer was suspended");
    assert.equal(getEventOpenAfter(1), 42, "the replacement stream resumes from the current cursor");
    assert.deepEqual(status(), { online: false, stale: false }, "without a successful stream or read after return, controls stay offline during grace");

    t.mock.timers.tick(LIVE_STALE_DELAY_MS);
    await flush();
    assert.deepEqual(status(), { online: false, stale: true }, "stale grace begins on foreground return");

    available = true;
    setEventStreamsUnavailable(false);
    view.read().refresh();
    await flush();
    assert.deepEqual(status(), { online: true, stale: false }, "a successful fresh read clears stale state");
  } finally {
    view.unmount();
    t.mock.timers.reset();
    setEventStreamsUnavailable(false);
    setAppState("active");
    resetEventStreams();
  }
});

test("useLive restarts stale presentation grace on return when it was stale before background", { skip }, async t => {
  const { markEventStreamDead, resetEventStreams, setAppState, setEventStreamsUnavailable } = phone!;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  resetEventStreams();
  setAppState("active");
  let available = true;
  const view = mountLive(async () => {
    if (!available) throw new Error("read unavailable");
    return "snapshot";
  });
  const status = () => { const { online, stale } = view.read(); return { online, stale }; };
  try {
    await flush();
    assert.deepEqual(status(), { online: true, stale: false });

    available = false;
    setEventStreamsUnavailable(true);
    markEventStreamDead(0);
    await flush();
    t.mock.timers.tick(LIVE_STALE_DELAY_MS);
    await flush();
    assert.deepEqual(status(), { online: false, stale: true }, "a failed stream becomes stale before backgrounding");

    setAppState("background");
    // Model JS suspension without firing the background grace timer.
    t.mock.timers.setTime(Date.now() + 31_001);
    setAppState("active");
    await flush();
    assert.deepEqual(status(), { online: false, stale: false }, "return starts a fresh stale grace");

    t.mock.timers.tick(LIVE_STALE_DELAY_MS);
    await flush();
    assert.deepEqual(status(), { online: false, stale: true }, "offline presentation returns only after the new grace");

    available = true;
    view.read().refresh();
    await flush();
    assert.deepEqual(status(), { online: true, stale: false });
  } finally {
    view.unmount();
    t.mock.timers.reset();
    setEventStreamsUnavailable(false);
    setAppState("active");
    resetEventStreams();
  }
});

test("useLive delays stale status when the stream dies while the app is away", { skip }, async t => {
  const { getEventOpenAttempts, getEventOpenAfter, markEventStreamDead, resetEventStreams, setAppState, setEventStreamsUnavailable } = phone!;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  resetEventStreams();
  setAppState("active");
  let available = true;
  let cursor = 0;
  const view = mountLive(async () => {
    if (!available) throw new Error("read unavailable");
    return "snapshot";
  }, () => cursor);
  const status = () => { const { online, stale } = view.read(); return { online, stale }; };
  try {
    await flush();
    assert.deepEqual(status(), { online: true, stale: false });
    const opened = getEventOpenAttempts();

    setAppState("background");
    markEventStreamDead(0);
    available = false;
    setEventStreamsUnavailable(true);
    cursor = 73;
    t.mock.timers.tick(1000);
    await flush();
    assert.deepEqual(status(), { online: true, stale: false }, "a stream close during background does not mutate the cached view");

    setAppState("active");
    await flush();
    assert.equal(getEventOpenAttempts(), opened + 1, "return attempts to replace the dead stream");
    assert.equal(getEventOpenAfter(1), 73, "the replacement stream resumes from the current cursor");
    assert.deepEqual(status(), { online: false, stale: false }, "no live state is reported until a read or stream succeeds after return");

    t.mock.timers.tick(LIVE_STALE_DELAY_MS);
    await flush();
    assert.deepEqual(status(), { online: false, stale: true }, "the stale delay starts from foreground return");

    available = true;
    setEventStreamsUnavailable(false);
    view.read().refresh();
    await flush();
    assert.deepEqual(status(), { online: true, stale: false }, "a successful fresh read clears stale state");
  } finally {
    view.unmount();
    t.mock.timers.reset();
    setEventStreamsUnavailable(false);
    setAppState("active");
    resetEventStreams();
  }
});

test("the phone retries a read lost with its channel once, only in the foreground, and never a mutation", { skip, timeout: 20000 }, async () => {
  const { api, closeConnection, setAppState } = phone!;
  const runner = await httpRunner(), proxy = await wireProxy(runner.url);
  const connection = { url: proxy.url, token: runner.token };
  const channels = () => proxy.frames.filter(frame => JSON.parse(frame).type === "hello").length;
  setAppState("active");
  try {
    await api(connection, "/me");
    let before = runner.requests.length;
    proxy.loseResponse();
    const reply = await api<{ count: number }>(connection, "/me");
    assert.equal(runner.requests.length, before + 2, "the lost read reached the host and ran once more");
    assert.equal(reply.count, before + 2);

    before = runner.requests.length;
    proxy.loseResponse();
    await assert.rejects(api(connection, "/projects/project/context", { method: "PUT", body: { text: "once", expectedVersion: 0 } }), (error: ApiError) => error.code === "delivery-unknown");
    assert.equal(runner.requests.length, before + 1, "a mutation whose receipt was lost is not sent again");

    await api(connection, "/me");
    before = runner.requests.length;
    const opened = channels();
    const held = runner.holdNext();
    proxy.loseResponse();
    const read = api(connection, "/me");
    const release = await held;
    setAppState("background");
    release();
    await assert.rejects(read, (error: ApiError) => error.code === "disconnected");
    assert.equal(runner.requests.length, before + 1, "a backgrounded phone does not resend the read");
    assert.equal(channels(), opened, "a backgrounded phone does not reconnect");
  } finally { setAppState("active"); closeConnection(connection); proxy.close(); runner.close(); }
});

test("a phone keeps an active event channel through its grace and closes it after thirty seconds", { skip, timeout: 20000 }, async t => {
  const { api, closeConnection, openRemoteEvents, setAppState } = phone!;
  const host = await inProcessHost();
  host.config.remote = { enabled: true };
  const closeRemote = connectRemoteAccess(host.server, host.config);
  const proxy = await wireProxy(host.origin);
  const connection = { url: proxy.url, token: host.tokens.owner };
  let streamClosed = 0;
  let stream: { close(): void } | undefined;
  setAppState("active");
  try {
    stream = await openRemoteEvents(connection, { topics: ["sessions"], onEvent: () => {}, onClose: () => { streamClosed++; } });
    const handshakes = () => proxy.frames.filter(frame => JSON.parse(frame).type === "hello").length;
    const before = handshakes();
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    setAppState("background");
    t.mock.timers.tick(20_000);
    setAppState("active");
    await api(connection, "/me");
    assert.equal(streamClosed, 0, "the existing event subscription remains open within the grace");
    assert.equal(handshakes(), before, `the API request reuses the same remote channel (${before} -> ${handshakes()})`);

    setAppState("background");
    t.mock.timers.tick(29_999);
    assert.equal(streamClosed, 0, "the channel remains open before the grace expires");
    t.mock.timers.tick(1);
    assert.equal(streamClosed, 1, "the background reset closes the channel at the grace deadline");
  } finally {
    t.mock.timers.reset();
    stream?.close();
    closeConnection(connection);
    setAppState("active");
    closeRemote();
    proxy.close();
    await host.stop();
  }
});

test("a phone poll stays live through a brief switch only until three seconds pass without a successful poll", { skip }, async t => {
  const { renderHook, setAppState, usePoll } = phone!;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  setAppState("active");
  const replies: ((value: number) => void)[] = [];
  const view = renderHook(() => usePoll(() => new Promise<number>(resolve => replies.push(resolve)), 4000, []));
  const status = () => { const { online, stale } = view.read(); return { online, stale }; };
  const settle = (index: number) => { replies[index](index); return new Promise(resolve => setImmediate(resolve)); };
  try {
    await settle(0);
    assert.deepEqual(status(), { online: true, stale: false });

    // iOS reports inactive for the app switcher, Control Center and Face ID; polling continues.
    t.mock.timers.tick(1000);
    setAppState("inactive");
    t.mock.timers.tick(3000);
    assert.equal(replies.length, 2, "inactive does not pause polling");
    await settle(1);
    setAppState("active");
    assert.deepEqual(status(), { online: true, stale: false });

    t.mock.timers.tick(1000);
    setAppState("background");
    t.mock.timers.tick(60_000);
    assert.equal(replies.length, 2, "nothing polls in the background");

    setAppState("active");
    assert.equal(replies.length, 3, "returning polls immediately");
    assert.deepEqual(status(), { online: false, stale: false });
    await settle(2);
    assert.deepEqual(status(), { online: true, stale: false });

    t.mock.timers.tick(1000);
    setAppState("background");
    t.mock.timers.tick(1000);
    setAppState("active");
    assert.equal(replies.length, 4);
    t.mock.timers.tick(2999);
    assert.deepEqual(status(), { online: true, stale: false });
    t.mock.timers.tick(1);
    assert.deepEqual(status(), { online: false, stale: true }, "no poll succeeded since return");
    await settle(3);
    assert.deepEqual(status(), { online: true, stale: false });
  } finally { view.unmount(); t.mock.timers.reset(); setAppState("active"); }
});

test("a held phone lease survives app switches, renews only in the foreground, and is never claimed again", { skip, timeout: 20000 }, async t => {
  const { api, closeConnection, renderHook, setAppState, useSessionControl } = phone!;
  let lease: ControlLease | null = null;
  const runner = await httpRunner(({ path, body }) => {
    if (!path.endsWith("/control")) return undefined;
    const { action, leaseId } = body as { action: string; leaseId?: string };
    const current = lease !== null && lease.id === leaseId && lease.expiresAt > Date.now();
    if (action === "claim") lease = { id: randomUUID(), label: "Phone", expiresAt: Date.now() + 30_000 };
    else if (action === "renew") lease = current ? { ...lease!, expiresAt: Date.now() + 30_000 } : null;
    else if (current) lease = null;
    return { control: lease };
  });
  const proxy = await wireProxy(runner.url);
  const connection = { url: proxy.url, token: runner.token };
  const channels = () => proxy.frames.filter(frame => JSON.parse(frame).type === "hello").length;
  const sent = (action: string) => runner.requests.filter(request => (request.body as { action?: string } | null)?.action === action).length;
  const until = async (ready: () => boolean, what: string) => {
    const deadline = performance.now() + 5000;
    while (!ready()) {
      assert.ok(performance.now() < deadline, what);
      await new Promise(resolve => setImmediate(resolve));
    }
  };
  setAppState("active");
  await api(connection, "/me");
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  const session = randomUUID();
  const view = renderHook(() => useSessionControl(connection, session));
  const held = () => view.read().lease;
  try {
    await view.read().claim();
    const id = lease!.id;
    assert.equal(held()?.id, id);

    setAppState("inactive");
    t.mock.timers.tick(10_000);
    await until(() => sent("renew") === 1 && held()?.expiresAt === lease?.expiresAt, "inactive keeps renewing");

    setAppState("background");
    t.mock.timers.tick(10_000);
    assert.equal(sent("renew"), 1, "nothing renews in the background");
    assert.equal(held()?.id, id, "a brief switch keeps the lease");

    const opened = channels();
    setAppState("active");
    await until(() => sent("renew") === 2 && held()?.expiresAt === lease?.expiresAt, "returning renews at once");
    assert.equal(held()?.id, id, "returning renews the same lease at once");
    assert.equal(channels(), opened, "a brief switch keeps the channel");

    setAppState("background");
    t.mock.timers.tick(31_000);
    assert.equal(sent("renew"), 2, "nothing renews in the background");
    setAppState("active");
    assert.equal(sent("renew"), 2, "an expired lease is discarded without a renewal");
    assert.equal(held(), null, "foreground return drops the expired lease synchronously");
    await api(connection, "/me");
    assert.equal(channels(), opened + 1, "a read after a long absence replaces the idle channel");

    setAppState("background");
    setAppState("active");
    const before = runner.requests.length;
    await api(connection, "/me");
    assert.deepEqual(runner.requests.slice(before).map(request => request.path), ["/api/me"], "only the read reached the host");
    assert.equal(sent("claim"), 1, "a lapsed lease is not claimed again");
  } finally {
    view.unmount();
    t.mock.timers.reset();
    setAppState("active"); closeConnection(connection); proxy.close(); runner.close();
  }
});

test("a phone discards a lease that expires while background timers are suspended", { skip, timeout: 20000 }, async t => {
  const { api, closeConnection, renderHook, setAppState, useSessionControl } = phone!;
  let lease: ControlLease | null = null;
  const runner = await httpRunner(({ path, body }) => {
    if (!path.endsWith("/control")) return undefined;
    const { action, leaseId } = body as { action: string; leaseId?: string };
    if (action === "claim") lease = { id: randomUUID(), label: "Phone", expiresAt: Date.now() + 30_000 };
    else if (action === "renew") lease = lease?.id === leaseId && lease.expiresAt > Date.now() ? { ...lease, expiresAt: Date.now() + 30_000 } : null;
    return { control: lease };
  });
  const connection = { url: runner.url, token: runner.token };
  const sent = (action: string) => runner.requests.filter(request => (request.body as { action?: string } | null)?.action === action).length;
  setAppState("active");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const session = randomUUID();
  const view = renderHook(() => useSessionControl(connection, session));
  try {
    await api(connection, "/me");
    await view.read().claim();
    const expiresAt = lease!.expiresAt;
    assert.notEqual(view.read().leaseId(), undefined);

    setAppState("background");
    t.mock.timers.setTime(expiresAt + 1);
    setAppState("active");
    const leaseIdAfterReturn = view.read().leaseId();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(
      { renewals: sent("renew"), leaseId: leaseIdAfterReturn },
      { renewals: 0, leaseId: undefined },
      "foreground return discards an expired lease without sending or exposing its id",
    );
  } finally {
    view.unmount();
    t.mock.timers.reset();
    setAppState("active");
    closeConnection(connection);
    runner.close();
  }
});

test("a send-time lease lookup refuses a lease that expired while timers were suspended", { skip, timeout: 20000 }, async t => {
  const { api, closeConnection, renderHook, setAppState, useSessionControl } = phone!;
  let lease: ControlLease | null = null;
  const runner = await httpRunner(({ path, body }) => {
    if (!path.endsWith("/control")) return undefined;
    const { action, leaseId } = body as { action: string; leaseId?: string };
    if (action === "claim") lease = { id: randomUUID(), label: "Phone", expiresAt: Date.now() + 30_000 };
    else if (action === "renew") lease = lease?.id === leaseId && lease.expiresAt > Date.now() ? { ...lease, expiresAt: Date.now() + 30_000 } : null;
    return { control: lease };
  });
  const connection = { url: runner.url, token: runner.token };
  const session = randomUUID();
  setAppState("active");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const view = renderHook(() => useSessionControl(connection, session));
  try {
    await api(connection, "/me");
    await view.read().claim();
    const expiresAt = lease!.expiresAt;

    setAppState("background");
    t.mock.timers.setTime(expiresAt + 1);
    assert.equal(view.read().leaseId(), undefined, "a send-time lookup drops an expired lease synchronously");
    assert.equal(view.read().lease, null);
  } finally {
    view.unmount();
    t.mock.timers.reset();
    setAppState("active");
    closeConnection(connection);
    runner.close();
  }
});

test("a renewal response lost across background return retries the same held lease", { skip, timeout: 20000 }, async t => {
  const { api, closeConnection, renderHook, setAppState, useSessionControl } = phone!;
  let lease: ControlLease | null = null;
  const runner = await httpRunner(({ path, body }) => {
    if (!path.endsWith("/control")) return undefined;
    const { action, leaseId } = body as { action: string; leaseId?: string };
    const current = lease !== null && lease.id === leaseId && lease.expiresAt > Date.now();
    if (action === "claim") lease = { id: randomUUID(), label: "Phone", expiresAt: Date.now() + 30_000 };
    else if (action === "renew") lease = current ? { ...lease!, expiresAt: Date.now() + 30_000 } : null;
    else if (current) lease = null;
    return { control: lease };
  });
  const proxy = await wireProxy(runner.url);
  const connection = { url: proxy.url, token: runner.token };
  const sent = (action: string) => runner.requests.filter(request => (request.body as { action?: string } | null)?.action === action).length;
  const until = async (ready: () => boolean, what: () => string) => {
    const deadline = performance.now() + 5000;
    while (!ready()) {
      assert.ok(performance.now() < deadline, what());
      await new Promise(resolve => setImmediate(resolve));
    }
  };
  setAppState("active");
  await api(connection, "/me");
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  const session = randomUUID();
  const view = renderHook(() => useSessionControl(connection, session));
  try {
    await view.read().claim();
    const id = lease!.id;
    const lostResponse = runner.holdNext();
    proxy.loseResponse();
    t.mock.timers.tick(10_000);
    const release = await lostResponse;
    assert.equal(sent("renew"), 1, "the in-flight renewal reached the host");
    assert.equal(lease?.id, id, "the host accepted the renewal before its response was lost");
    assert.ok(lease!.expiresAt > Date.now(), "the same host lease is still inside its renewal window");

    setAppState("background");
    setAppState("active");
    release();
    await until(
      () => sent("renew") === 2 && view.read().lease?.id === id && view.read().lease.expiresAt === lease?.expiresAt,
      () => `return retries the existing host lease after the first receipt is lost (renewals=${sent("renew")}, local=${JSON.stringify(view.read().lease)}, host=${JSON.stringify(lease)})`,
    );
    assert.equal(sent("claim"), 1, "recovery renews the existing lease and does not claim another");
    assert.equal(view.read().lease?.id, id);
  } finally {
    view.unmount();
    t.mock.timers.reset();
    setAppState("active"); closeConnection(connection); proxy.close(); runner.close();
  }
});
