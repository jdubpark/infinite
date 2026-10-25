import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";

// An optional receipt path after the mode records every invocation's arguments.
const receipt = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : null;
if (receipt) appendFileSync(receipt, `${JSON.stringify({ args: process.argv.slice(4) })}\n`);
const baseIndex = process.argv.indexOf("--base");
const base = baseIndex >= 0 ? process.argv[baseIndex + 1] : null;
const root = realpathSync(process.cwd());
const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const source = readFileSync("src/a.ts", "utf8");
const files = { "src/a.ts": { hash: createHash("sha1").update(source).digest("hex"), lines: source.split("\n").length - (source.endsWith("\n") ? 1 : 0) } };
const fingerprint = process.argv[2] === "bad-fingerprint" ? "f".repeat(40) : createHash("sha1").update(JSON.stringify([head, Object.entries(files).sort(([a], [b]) => a.localeCompare(b))])).digest("hex");
const citation = process.argv[2] === "bad-citation" ? { source: "outside/secrets.txt", line: 1 } : { source: "src/a.ts", line: 1 };
const boundaries = process.argv[2] === "boundaries";
process.stdout.write(JSON.stringify({
  repo: root, head, base, generatedAt: new Date().toISOString(), fingerprint,
  brief: { summary: "A source grounded component summary.", architecture: [{ text: "The component exports its public value.", citations: [citation] }], changes: base ? [{ text: `Changed since ${base.slice(0, 7)}`, citations: [citation] }] : boundaries ? Array.from({ length: 6 }, () => ({ text: "c".repeat(900), citations: [citation] })) : [{ text: "The export remains a small module boundary.", citations: [{ source: "src/a.ts", line: 1 }] }], checks: [], review: boundaries ? [{ priority: "high", area: "a".repeat(150), why: "w".repeat(900), question: "q".repeat(900), citations: [citation] }] : [], guidance: [], unknowns: [], diagrams: [{ title: "System shape", kind: "system", mermaid: "flowchart LR\n  unstable-a[Alpha] --> unstable-b[Beta]", citations: [] }] },
  evidence: [],
  coverage: process.argv.includes("--runner") && process.argv.includes("deepseek") && process.argv.includes("--model") && process.argv.includes("fixture/model") && process.argv.includes("--timeout") && process.argv.includes("10") ? ["configured writer options reached the process boundary"] : ["configured writer options were missing"],
}));
