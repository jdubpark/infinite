import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

// Stands in for the Jevcode engine: answers `context` and `brief` for the runtime tests.
// Mode "brief-fail" makes only the `brief` subcommand exit 1.
const args = process.argv.slice(2);
const mode = args[0];
const subcommand = args.find(arg => arg === "context" || arg === "brief");
const repo = args[args.indexOf("--repo") + 1];
if (!repo) process.exit(2);
if (subcommand === "brief" && (mode === "brief-fail" || process.env.UNDERSTANDING_FIXTURE_BRIEF_FAIL)) process.exit(1);
const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const files = {
  "src/a.ts": { hash: "a".repeat(40), lines: 3 },
  "src/b.ts": { hash: "b".repeat(40), lines: 5 },
};
if (subcommand === "brief") {
  const baseIndex = args.indexOf("--base");
  const base = baseIndex >= 0 ? args[baseIndex + 1] : null;
  const citation = { source: "src/a.ts", line: 1 };
  process.stdout.write(JSON.stringify({
    repo, head, base, generatedAt: new Date().toISOString(),
    fingerprint: createHash("sha1").update(JSON.stringify([head, Object.entries(files).sort(([a], [b]) => a.localeCompare(b))])).digest("hex"),
    brief: {
      summary: "Fixture repository brief.", architecture: [{ text: "Two small modules.", citations: [citation] }],
      changes: base ? [{ text: `Changed since ${base.slice(0, 7)}`, citations: [citation] }] : [], checks: [], review: [], guidance: [], unknowns: [],
      diagrams: [{ title: "System shape", kind: "system", mermaid: "flowchart LR\n  unstable-a[Alpha] --> unstable-b[Beta]", citations: [] }],
    },
    evidence: [], coverage: ["fixture repository"],
  }));
} else {
  process.stdout.write(JSON.stringify({
    version: 1, repo, generatedAt: new Date().toISOString(), head, base: head, files,
    components: [
      { id: "input-a", path: "src/a.ts", name: "A", files: 1, examples: ["src/a.ts"], entryPoints: [], incoming: 0, outgoing: 1, changed: 0 },
      { id: "input-b", path: "src/b.ts", name: "B", files: 1, examples: ["src/b.ts"], entryPoints: [], incoming: 1, outgoing: 0, changed: 0 },
    ],
    edges: [{ from: "input-a", to: "input-b", count: 1, examples: ["src/a.ts → src/b.ts"] }],
    limitations: ["Static imports cover JavaScript and TypeScript only."],
  }));
}
