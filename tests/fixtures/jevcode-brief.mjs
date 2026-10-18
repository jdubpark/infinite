import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const receiptPath = process.argv[2];
const fail = process.argv[3] === "fail";
const args = process.argv.slice(4);
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
process.stdout.write(JSON.stringify({
  repo: execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
  head,
  base,
  generatedAt: new Date().toISOString(),
  fingerprint: "a".repeat(40),
  brief: { summary: marker < 0 ? "Fixture repository brief." : `Fixture repository brief includes ${activity[marker].text}.`, architecture: [], review: [], changes: [], checks: [], guidance: [], unknowns: [] },
  evidence,
  coverage: ["fixture repository"]
}));
