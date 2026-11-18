// Scripted stand-in for Codex, used by tests/codex-notify-link.test.ts. It writes one rollout under
// $HOME/.codex/sessions, then runs its turn-end `notify` program once, as Codex does at a turn end.
// The `notify=` argument carries the program as a TOML array of quoted strings, which JSON.parse reads.
// Modes, as a last argument: `later-turn` starts a second turn after the notice and exits inside it;
// `stale-notice` reports a turn that is not the newest one in the rollout.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const THREAD = "019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b";
const notifyArg = process.argv.find((arg) => arg.startsWith("notify="));
if (!notifyArg) {
  console.error("No notify override was passed");
  process.exit(2);
}
const notify = JSON.parse(notifyArg.slice("notify=".length));

const usage = { input_tokens: 1000, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 150, reasoning_output_tokens: 30, total_tokens: 1150 };
const rows = [
  { timestamp: "2026-11-18T09:00:00.000Z", type: "session_meta", payload: { id: THREAD, cli_version: "0.0.0-fixture", parent_thread_id: null } },
  { timestamp: "2026-11-18T09:00:00.050Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
  { timestamp: "2026-11-18T09:00:00.100Z", type: "turn_context", payload: { turn_id: "turn-1", model: "model-fixture-a", effort: "medium" } },
  { timestamp: "2026-11-18T09:00:01.000Z", type: "token_usage_record", payload: { response_id: "resp-1", thread_id: THREAD, turn_id: "turn-1", usage, thread_token_usage: usage } },
  { timestamp: "2026-11-18T09:00:01.100Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage } } },
  { timestamp: "2026-11-18T09:00:01.200Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
];

const day = join(process.env.HOME, ".codex", "sessions", "2026", "11", "18");
mkdirSync(day, { recursive: true });
const rollout = join(day, `rollout-2026-11-18T09-00-00-${THREAD}.jsonl`);
writeFileSync(rollout, rows.map((row) => JSON.stringify(row) + "\n").join(""));
console.log("stand-in turn started");

const reported = process.argv.includes("stale-notice") ? "turn-0" : "turn-1";
const payload = { type: "agent-turn-complete", "thread-id": THREAD, "turn-id": reported, cwd: process.cwd(), "input-messages": ["go"], "last-assistant-message": "done" };
spawnSync(notify[0], [...notify.slice(1), JSON.stringify(payload)], { stdio: "ignore" });
console.log("stand-in turn complete");
// A second turn starts after the notice and is cut before it writes its context row, as an early stop does.
if (process.argv.includes("later-turn")) {
  const later = { timestamp: "2026-11-18T09:00:05.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } };
  appendFileSync(rollout, JSON.stringify(later) + "\n");
  console.log("stand-in second turn started");
}
await new Promise((resolve) => setTimeout(resolve, 1000));
process.exit(0);
