import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [receiptDir, bytes = "64"] = process.argv.slice(2);
const assignment = JSON.parse(process.env.INFINITE_TEAM_ASSIGNMENT ?? "null");
if (!assignment) throw new Error("The stand-in runs only as a team member");
const traceRoot = process.env.CODEX_ROLLOUT_TRACE_ROOT ?? null;
if (traceRoot) {
  const trace = join(traceRoot, "trace-fixture-0001-thread-0001");
  mkdirSync(join(trace, "payloads"), { recursive: true });
  writeFileSync(join(trace, "trace.jsonl"), "x".repeat(Number(bytes) - 2));
  writeFileSync(join(trace, "payloads", "1.json"), "{}");
}
const receipt = join(receiptDir, `${assignment.memberId}.json`);
writeFileSync(`${receipt}.tmp`, JSON.stringify({ traceRoot, argv: process.argv.slice(2) }), { mode: 0o600 });
renameSync(`${receipt}.tmp`, receipt);
