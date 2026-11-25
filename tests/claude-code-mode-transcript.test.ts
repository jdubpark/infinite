import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TranscriptTail } from "../packages/host/src/transcript.js";
import { transcriptText } from "../packages/host/src/summary.js";

test("Claude Code Mode transcript shows the program, each nested call, and the final reply", () => {
  const tail = new TranscriptTail("claude");
  const raw = readFileSync(new URL("./fixtures/claude-code-mode/transcript.jsonl", import.meta.url), "utf8");
  const messages = tail.ingest(raw);
  assert.deepEqual(messages.map(message => [message.role, message.toolName, message.text]), [
    ["user", undefined, "In one program: run the shell command 'wc -c a.txt b.txt c.md', then write only the total number into a new file named total.txt in the current folder. Reply with only the total."],
    ["tool", "REPL", "Run wc -c and write total byte count to total.txt"],
    ["tool", "Bash", "wc -c a.txt b.txt c.md"],
    ["tool", "Write", "/home/dev/projects/demo/total.txt"],
    ["assistant", undefined, "17"],
  ]);
  const summary = transcriptText(messages);
  assert.match(summary, /Agent ran REPL: Run wc -c and write total byte count to total\.txt/);
  assert.match(summary, /Agent ran Bash: wc -c a\.txt b\.txt c\.md/);
  assert.match(summary, /Agent ran Write: \/home\/dev\/projects\/demo\/total\.txt/);
  assert.equal(tail.discarded, 0, "repl-mode, tools-used, and host-row records are valid ignored rows");
});

test("the provider's own continue prompt after a deferred resume is not a chat message", () => {
  const tail = new TranscriptTail("claude");
  const row = {
    type: "user", isMeta: true, promptSource: "system", turnOrigin: "system",
    sessionId: "00000000-0000-4000-8000-000000000001", uuid: "00000000-0000-4000-8000-000000000003", parentUuid: null, isSidechain: false,
    message: { role: "user", content: "Continue from where you left off." },
  };
  assert.deepEqual(tail.ingest(JSON.stringify(row) + "\n"), []);
});
