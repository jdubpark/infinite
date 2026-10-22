import { execFileSync } from "node:child_process";

const root = process.argv[process.argv.indexOf("--repo") + 1];
if (!root) process.exit(2);
const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
process.stdout.write(JSON.stringify({
  version: 1,
  repo: root,
  generatedAt: new Date().toISOString(),
  head,
  base: head,
  files: {
    "src/a.ts": { hash: "a".repeat(40), lines: 3 },
    "src/b.ts": { hash: "b".repeat(40), lines: 5 },
  },
  components: [
    { id: "input-a", path: "src/a.ts", name: "A", files: 1, examples: ["src/a.ts"], entryPoints: [], incoming: 0, outgoing: 1, changed: 0 },
    { id: "input-b", path: "src/b.ts", name: "B", files: 1, examples: ["src/b.ts"], entryPoints: [], incoming: 1, outgoing: 0, changed: 0 },
  ],
  edges: [{ from: "input-a", to: "input-b", count: 1, examples: ["src/a.ts → src/b.ts"] }],
  limitations: ["Static imports cover JavaScript and TypeScript only."],
}));
