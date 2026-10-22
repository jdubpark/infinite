import { appendFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [receipt, release] = process.argv.slice(2, 4);
const args = process.argv.slice(4);
const repo = args[args.indexOf("--repo") + 1];
appendFileSync(receipt, "started\n");
while (!existsSync(release)) await new Promise(resolve => setTimeout(resolve, 25));
const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const baseIndex = args.indexOf("--base");
process.stdout.write(JSON.stringify({
  decision: { action: "run", reason: "fixture", judge: "heuristic", worthwhile: 1, scope: "full" },
  repo: execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
  head, base: baseIndex < 0 ? null : args[baseIndex + 1], generatedAt: new Date().toISOString(), fingerprint: "c".repeat(40),
  brief: { summary: "Delayed fixture brief.", architecture: [], review: [], changes: [], checks: [], guidance: [], unknowns: [], diagrams: [] },
  evidence: [], coverage: ["fixture source"],
}));
