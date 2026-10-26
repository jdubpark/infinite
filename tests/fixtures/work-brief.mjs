import { appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const mode = args.includes("context") ? "context" : args.includes("brief") ? "brief" : null;
const repo = args[args.indexOf("--repo") + 1];
const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const files = {};
function walk(directory) {
  for (const name of readdirSync(directory)) {
    if (name === ".git") continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path);
    else {
      const key = relative(repo, path).split("\\").join("/");
      const source = readFileSync(path, "utf8");
      files[key] = { hash: createHash("sha1").update(source).digest("hex"), lines: source.split("\n").length - (source.endsWith("\n") ? 1 : 0) };
    }
  }
}
walk(repo);
const fingerprint = createHash("sha1").update(JSON.stringify([head, Object.entries(files).sort(([a], [b]) => a.localeCompare(b))])).digest("hex");
if (process.env.WORK_BRIEF_CALLS) appendFileSync(process.env.WORK_BRIEF_CALLS, `${JSON.stringify({ mode, args })}\n`);
if (mode === "context") {
  process.stdout.write(JSON.stringify({ version: 1, repo, generatedAt: new Date().toISOString(), head, base: null, files, components: [], edges: [], limitations: [] }));
} else if (mode === "brief") {
  if (process.env.WORK_BRIEF_FAIL === "1") process.exit(1);
  const requestedBase = args[args.indexOf("--base") + 1];
  const base = process.env.WORK_BRIEF_WRONG_BASE === "1" ? "0".repeat(40) : requestedBase;
  process.stdout.write(JSON.stringify({
    repo, head, base, generatedAt: new Date().toISOString(), fingerprint,
    brief: {
      summary: "A source grounded work summary.", architecture: [],
      changes: [{ text: "The work updates a source module.", citations: [{ source: "src/a.ts", line: 1 }] }],
      checks: [], review: [{ priority: "medium", area: "Source behavior", why: "The changed behavior has limited recorded coverage.", question: "Does the updated behavior cover the intended case?", citations: [{ source: "src/a.ts", line: 1 }] }],
      guidance: [], unknowns: [], diagrams: [{ title: "Change", kind: "change", mermaid: "flowchart LR\n  A --> B", citations: process.env.WORK_BRIEF_BAD_DIAGRAM_CITATION === "1" ? [{ source: "../outside.ts", line: 999 }] : [] }],
    },
    evidence: process.env.WORK_BRIEF_BAD_DIAGRAM_CITATION === "1" ? [{ source: "../outside.ts", line: 999, path: null, text: "outside the collected source" }] : [], coverage: [],
  }));
} else process.exit(2);
