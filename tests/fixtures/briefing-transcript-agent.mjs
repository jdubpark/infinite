import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const transcriptPath = process.argv[2];
const releaseLateTranscript = process.argv[3];
const sessionId = "briefing-transcript-fixture";
const relayPath = fileURLToPath(new URL("../../packages/host/src/hook-relay.ts", import.meta.url));
const tsxLoader = import.meta.resolve("tsx");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function relay(event) {
  const result = spawnSync(process.execPath, ["--import", tsxLoader, relayPath, "claude"], {
    env: process.env,
    input: JSON.stringify(event),
    encoding: "utf8",
    timeout: 10000,
  });
  if (result.error || result.status !== 0) throw result.error ?? new Error("Hook relay fixture failed.");
}

function userRecord(index) {
  return JSON.stringify({
    type: "user",
    uuid: `history-user-${index}`,
    timestamp: "2026-10-18T12:00:00.000Z",
    message: { role: "user", content: `Historical request ${index}` },
  });
}

function assistantRecord(index, text = `Historical result ${index}`) {
  return JSON.stringify({
    type: "assistant",
    uuid: `history-assistant-${index}`,
    timestamp: "2026-10-18T12:00:01.000Z",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

const history = [];
// Keep enough history to cross the 200-message activity window without adding needless fixture load.
for (let index = 0; index < 110; index++) history.push(userRecord(index), assistantRecord(index));
writeFileSync(transcriptPath, `${history.join("\n")}\n`);

const base = { session_id: sessionId, transcript_path: transcriptPath };
relay({ ...base, hook_event_name: "UserPromptSubmit", prompt: "Review the current change." });
relay({ ...base, hook_event_name: "Stop", last_assistant_message: "The first turn has ended." });

// Providers may flush their final transcript records just after the stop hook.
while (!existsSync(releaseLateTranscript)) await sleep(10);
await sleep(90);
appendFileSync(transcriptPath, `${userRecord("later")}\n${assistantRecord("later", "FINAL_TRANSCRIPT_MARKER: new turn result")}\n`);
relay({ ...base, hook_event_name: "SessionEnd", reason: "completed" });

// The host test stops this fixture after the automatic brief is ready.
await new Promise(() => {});
