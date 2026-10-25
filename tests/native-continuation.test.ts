import test from "node:test";
import assert from "node:assert/strict";
import { resumeFailed, withNativeContinuation } from "../packages/host/src/native-continuation.js";
import type { WorkerState } from "../packages/host/src/types.js";

test("native continuation uses the requested Claude session mode", () => {
  const profile = { command: "claude", args: ["--model", "sonnet"] };
  const start = { nativeSessionId: "123e4567-e89b-42d3-a456-426614174000", mode: "start" as const };
  const resume = { ...start, mode: "resume" as const };
  assert.deepEqual(withNativeContinuation(profile, start), {
    command: "claude", args: ["--model", "sonnet", "--session-id", "123e4567-e89b-42d3-a456-426614174000"],
  });
  assert.deepEqual(withNativeContinuation(profile, resume), {
    command: "claude", args: ["--model", "sonnet", "--resume", "123e4567-e89b-42d3-a456-426614174000"],
  });
  assert.deepEqual(profile.args, ["--model", "sonnet"]);
});

test("native continuation appends provider arguments after a sudo executable boundary", () => {
  const profile = { command: "sudo", args: ["-n", "-u", "USER", "--", "claude"] };
  const continuation = { nativeSessionId: "123e4567-e89b-42d3-a456-426614174000", mode: "resume" as const };
  assert.deepEqual(withNativeContinuation(profile, continuation), {
    command: profile.command,
    args: [...profile.args, "--resume", "123e4567-e89b-42d3-a456-426614174000"],
  });
});

test("resume failure only identifies an exited resume without a reported native session", () => {
  const continuation = { nativeSessionId: "123e4567-e89b-42d3-a456-426614174000", mode: "resume" as const };
  assert.equal(resumeFailed({ status: "exited", nativeSession: undefined }, continuation), true);
  assert.equal(resumeFailed({ status: "exited", nativeSession: { id: "native", source: "hook" } }, continuation), false);
  assert.equal(resumeFailed({ status: "running", nativeSession: undefined }, continuation), false);
  assert.equal(resumeFailed({ status: "starting", nativeSession: undefined }, continuation), false);
  assert.equal(resumeFailed({ status: "exited", nativeSession: undefined }, { ...continuation, mode: "start" }), false);
  assert.equal(resumeFailed({ status: "exited", nativeSession: undefined }, undefined), false);
  const nullNativeSession = { status: "exited", nativeSession: null } as unknown as Pick<WorkerState, "status" | "nativeSession">;
  assert.equal(resumeFailed(nullNativeSession, continuation), true);
});

