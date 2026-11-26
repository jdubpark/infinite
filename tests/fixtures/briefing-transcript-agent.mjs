import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { relay } from "../../packages/host/src/hook-relay.ts";

const transcriptPath = process.argv[2];
const releaseLateTranscript = process.argv[3];
const sessionId = "briefing-transcript-fixture";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sendHook(event) {
  const url = process.env.INFINITE_HOOK_URL;
  const token = process.env.INFINITE_HOOK_TOKEN;
  if (!url || !token) throw new Error("Hook relay fixture missing hook environment.");
  await relay("claude", JSON.stringify(event), { url, token, home: process.env.HOME });
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
for (let index = 0; index < 110; index++) history.push(userRecord(index), assistantRecord(index));
writeFileSync(transcriptPath, `${history.join("\n")}\n`);

const base = { session_id: sessionId, transcript_path: transcriptPath };
await sendHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "Review the current change." });
await sendHook({ ...base, hook_event_name: "Stop", last_assistant_message: "The first turn has ended." });

while (!existsSync(releaseLateTranscript)) await sleep(10);
appendFileSync(transcriptPath, `${userRecord("later")}\n${assistantRecord("later", "FINAL_TRANSCRIPT_MARKER: new turn result")}\n`);
await sendHook({ ...base, hook_event_name: "SessionEnd", reason: "completed" });

await new Promise(() => {});
