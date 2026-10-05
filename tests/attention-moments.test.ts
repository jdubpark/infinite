import test from "node:test";
import assert from "node:assert/strict";
import { deriveMoments } from "../packages/attention/src/moments.js";
import type { SignalEvent, SignalData } from "../packages/attention/src/types.js";

let seq = 0;
const ev = (data: Partial<SignalData> & { kind: SignalData["kind"] }, at = "2026-10-04T12:00:00.000Z"): SignalEvent =>
  ({ seq: ++seq, at, type: "signal", data: { source: "hook", provider: "claude", ...data } as SignalData });

test("pairs tools, collapses quiet tools and edits, shows decisions and turns", () => {
  const events: SignalEvent[] = [
    ev({ kind: "turn-start", prompt: "add retries" }),
    ev({ kind: "tool-start", tool: "Read", input: { file_path: "/w/a.ts" }, quiet: true }),
    ev({ kind: "tool-end", tool: "Read", ok: true }),
    ev({ kind: "tool-start", tool: "Grep", input: {}, quiet: true }),
    ev({ kind: "tool-start", tool: "Bash", toolUseId: "t1", input: { command: "rm -rf build" }, quiet: false, destructive: { pattern: "rm-recursive-force" } }),
    ev({ kind: "prompt-open", prompt: { id: 0, kind: "permission", title: "Do you want to proceed?", detail: "rm -rf build", options: [{ index: 0, label: "Yes", role: "accept" }], acceptsText: false, source: "hook" } }),
    ev({ kind: "answer", promptId: 6, requestId: "r", option: { index: 0, label: "Yes" }, text: false, result: "closed", source: "host" }),
    ev({ kind: "prompt-closed", promptId: 6, reason: "answered-here", label: "Yes", source: "host" }),
    ev({ kind: "tool-end", tool: "Bash", toolUseId: "t1", ok: true, durationMs: 300, summary: "exit 0" }),
    ev({ kind: "tool-start", tool: "Edit", toolUseId: "t2", input: { file_path: "/w/src/app.ts", old_string: "a", new_string: "b" }, quiet: false }),
    ev({ kind: "tool-end", tool: "Edit", toolUseId: "t2", ok: true }),
    ev({ kind: "tool-start", tool: "Edit", toolUseId: "t3", input: { file_path: "/w/src/app.ts", old_string: "c", new_string: "d" }, quiet: false }),
    ev({ kind: "tool-end", tool: "Edit", toolUseId: "t3", ok: true }),
    ev({ kind: "turn-end", message: "Added retries.", backgroundTasks: 0 }),
  ];
  const moments = deriveMoments(events);
  const kinds = moments.map((m) => `${m.kind}:${m.title}`);
  assert.deepEqual(kinds, [
    "turn:Added retries.",
    "edit:app.ts",
    "command:rm -rf build",
    "decision:Do you want to proceed?",
    "quiet:Read 1 file, searched 1 time",
    "turn:add retries",
  ]);
  const edit = moments.find((m) => m.kind === "edit")!;
  assert.equal(edit.count, 2);
  const command = moments.find((m) => m.kind === "command")!;
  assert.equal(command.status, "ok");
  assert.equal(command.destructive, "rm-recursive-force");
  assert.match(command.detail ?? "", /exit 0/);
  const decision = moments.find((m) => m.kind === "decision")!;
  assert.equal(decision.detail, "Yes · answered through Infinite");
});

test("a running command without an end is marked running", () => {
  const moments = deriveMoments([ev({ kind: "tool-start", tool: "Bash", toolUseId: "x", input: { command: "npm test" }, quiet: false })]);
  assert.equal(moments[0].status, "running");
});

test("apply_patch stays a command moment and never collapses", () => {
  const moments = deriveMoments([
    ev({ kind: "tool-start", tool: "apply_patch", toolUseId: "p1", input: { patch: "a" }, quiet: false }),
    ev({ kind: "tool-end", tool: "apply_patch", toolUseId: "p1", ok: true }),
    ev({ kind: "tool-start", tool: "apply_patch", toolUseId: "p2", input: { patch: "b" }, quiet: false }),
  ]);
  assert.deepEqual(moments.map((m) => `${m.kind}:${m.title}`), ["command:apply_patch", "command:apply_patch"]);
});

test("a command between two edits of the same file keeps them separate", () => {
  const edit = (id: string) => ev({ kind: "tool-start", tool: "Edit", toolUseId: id, input: { file_path: "/w/a.ts", old_string: "a", new_string: "b" }, quiet: false });
  const moments = deriveMoments([
    edit("e1"),
    ev({ kind: "tool-start", tool: "Bash", toolUseId: "b1", input: { command: "npm test" }, quiet: false }),
    edit("e2"),
  ]);
  const edits = moments.filter((m) => m.kind === "edit");
  assert.equal(edits.length, 2);
  assert.deepEqual(edits.map((m) => m.count), [1, 1]);
});

test("a prompt-merged notice gives the decision row the dialog's own title and detail", () => {
  const open = ev({ kind: "prompt-open", prompt: { id: 0, kind: "permission", title: "Permission needed", detail: "rm -rf build", options: [], acceptsText: false, source: "hook" } });
  const moments = deriveMoments([
    open,
    ev({ kind: "notice", type: "prompt-merged", promptId: open.seq, title: "Do you want to proceed?", detail: "Bash command\nrm -rf build\nRemove the stale build directory", source: "screen" }),
    // A merge notice for some other prompt changes nothing.
    ev({ kind: "notice", type: "prompt-merged", promptId: open.seq + 100, title: "Elsewhere", source: "screen" }),
  ]);
  assert.equal(moments.length, 1);
  assert.equal(moments[0].kind, "decision");
  assert.equal(moments[0].title, "Do you want to proceed?");
  assert.deepEqual(moments[0].expanded, [{ label: "Detail", text: "Bash command\nrm -rf build\nRemove the stale build directory" }]);
  assert.equal(moments[0].detail, "Waiting");
});
