import test from "node:test";
import assert from "node:assert/strict";
import {
  conversationActivity,
  hasExitedLifecycle,
  mergeSignalEvents,
  shouldRefreshConversation,
} from "../apps/mobile/src/features/session/liveState.js";
import { canUseLiveFallback, isLiveOnline, LIVE_STALE_DELAY_MS, shouldMarkLiveStale, shouldRetryEmptyLiveLoad } from "../apps/mobile/src/api/liveStatus.js";

test("signal delta loads preserve, deduplicate, and cap the existing timeline", () => {
  const existing = [{ seq: 1, value: "first" }, { seq: 2, value: "old" }];
  const merged = mergeSignalEvents(existing, [{ seq: 2, value: "updated" }, { seq: 3, value: "third" }]);
  assert.deepEqual(merged, [{ seq: 1, value: "first" }, { seq: 2, value: "updated" }, { seq: 3, value: "third" }]);
  assert.deepEqual(mergeSignalEvents(existing, Array.from({ length: 2001 }, (_, index) => ({ seq: index + 3 }))).map(event => event.seq).slice(0, 2), [4, 5]);
  assert.equal(mergeSignalEvents(existing, Array.from({ length: 2001 }, (_, index) => ({ seq: index + 3 }))).length, 2000);
});

test("conversation refreshes for journal or attention activity changes, not screen-only changes", () => {
  const initial = { state: { screen: "working", attention: { state: "working", lastActivityAt: "t1" } }, events: { events: [] } };
  const baseline = conversationActivity(initial);
  assert.equal(shouldRefreshConversation(null, initial), false);
  assert.equal(shouldRefreshConversation(baseline, { ...initial, state: { ...initial.state, screen: "working…" } }), false);
  assert.equal(shouldRefreshConversation(baseline, { ...initial, events: { events: [{ seq: 1 }] } }), true);
  assert.equal(shouldRefreshConversation(baseline, { ...initial, state: { ...initial.state, attention: { state: "needs-you", lastActivityAt: "t1" } } }), true);
  assert.equal(shouldRefreshConversation(baseline, { ...initial, state: { ...initial.state, attention: { state: "working", lastActivityAt: "t2" } } }), true);
});

test("an exited lifecycle event disables signal fallback polling", () => {
  assert.equal(hasExitedLifecycle([{ type: "signal" }, { type: "lifecycle", data: { status: "exited" } }]), true);
  assert.equal(hasExitedLifecycle([{ type: "lifecycle", data: { status: "running" } }]), false);
});

test("live views become stale after three offline seconds and never while online", () => {
  const offlineSince = 1000;
  assert.equal(LIVE_STALE_DELAY_MS, 3000);
  assert.equal(shouldMarkLiveStale(offlineSince, offlineSince + 2999), false);
  assert.equal(shouldMarkLiveStale(offlineSince, offlineSince + LIVE_STALE_DELAY_MS), true);
  assert.equal(shouldMarkLiveStale(null, offlineSince + LIVE_STALE_DELAY_MS), false);
});

test("a successful fallback load keeps the view online while the stream is down", () => {
  assert.equal(isLiveOnline(false, true), true);
  assert.equal(isLiveOnline(false, false), false);
  assert.equal(isLiveOnline(true, false), true);
});

test("an exited signal snapshot suppresses fallback loads and polling", () => {
  const continuePolling = (value: { exited: boolean } | null) => !value?.exited;
  assert.equal(canUseLiveFallback({ exited: false }, continuePolling), true);
  assert.equal(canUseLiveFallback({ exited: true }, continuePolling), false);
  assert.equal(canUseLiveFallback(null), true);
});

test("a discarded initial load retries only while it left live data unset", () => {
  assert.equal(shouldRetryEmptyLiveLoad(true, null), true);
  assert.equal(shouldRetryEmptyLiveLoad(true, { sessions: [] }), false);
  assert.equal(shouldRetryEmptyLiveLoad(false, null), false);
});
