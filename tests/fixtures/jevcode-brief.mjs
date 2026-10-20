import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const receiptPath = process.argv[2];
// Optional mode after the receipt path: fail (exit 1), skip (an unrefreshed brief), empty (no brief yet)
// or disabled (the repository is not opted in).
const mode = ["fail", "skip", "empty", "disabled"].includes(process.argv[3]) ? process.argv[3] : null;
const fail = mode === "fail";
const args = process.argv.slice(mode ? 4 : 3);
const repo = args[args.indexOf("--repo") + 1];
const baseIndex = args.indexOf("--base");
const base = baseIndex >= 0 ? args[baseIndex + 1] : null;
const input = await new Promise((resolve, reject) => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { value += chunk; });
  process.stdin.on("end", () => resolve(value));
  process.stdin.on("error", reject);
});
appendFileSync(receiptPath, `${JSON.stringify({ args, input })}\n`);
if (fail) process.exit(1);

const activity = input.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const marker = activity.findIndex(message => message.text.includes("FINAL_TRANSCRIPT_MARKER"));
const evidence = marker < 0 ? [] : [{ source: "activity:1", line: marker + 1, path: null, text: activity[marker].text }];

const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const root = execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
if (mode === "disabled") {
  process.stdout.write(JSON.stringify({ decision: { action: "disabled", reason: "this checkout is not opted in to automatic briefs (jevcode optin)", judge: null, worthwhile: null, scope: null }, repo: root, brief: null }));
  process.exit(0);
}
if (mode === "empty") {
  process.stdout.write(JSON.stringify({ decision: { action: "coalesced", reason: "another automatic brief is running for this checkout", judge: null, worthwhile: null, scope: null }, repo: root, brief: null }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  decision: mode === "skip"
    ? { action: "skip", reason: "jev judged a refresh not worthwhile (0.20 < 0.5)", judge: "jev", worthwhile: 0.2, scope: "skip" }
    : { action: "run", reason: "full brief written by muse", judge: "heuristic", worthwhile: 1, scope: "full" },
  repo: execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
  head,
  base,
  generatedAt: new Date().toISOString(),
  fingerprint: "a".repeat(40),
  brief: { summary: marker < 0 ? "Fixture repository brief." : `Fixture repository brief includes ${activity[marker].text}.`, architecture: [], review: [], changes: [], checks: [], guidance: [], unknowns: [], diagrams: [] },
  evidence,
  coverage: ["fixture repository"]
}));
