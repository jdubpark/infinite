import type { TeamRun, TeamTask } from "./team-types.js";

export function diffStat(output?: string) {
  if (output === undefined) return undefined;
  const rows = output.split("\0").filter(Boolean).map(line => {
    const [added, removed, path] = line.split("\t");
    return { added: added === "-" ? 0 : Number(added), removed: removed === "-" ? 0 : Number(removed), path: path ?? "" };
  });
  return { added: rows.reduce((sum, row) => sum + row.added, 0), removed: rows.reduce((sum, row) => sum + row.removed, 0), files: rows.length,
    docs: rows.some(row => row.path.startsWith("docs/") || row.path.endsWith(".md")),
    tests: rows.some(row => /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\./i.test(row.path)) };
}

const maxRunChangeFiles = 400;
const maxTaskChangedPaths = 200;

export function changeIndex(nameStatus: string | undefined, numstat: string | undefined, headCommit: string, at: string): TeamRun["changes"] | undefined {
  if (nameStatus === undefined) return undefined;
  const counts = new Map<string, { added: number | null; removed: number | null }>();
  if (numstat !== undefined) {
    const tokens = numstat.split("\0");
    for (let i = 0; i < tokens.length; i++) {
      if (!tokens[i]) continue;
      const [added, removed, ...rest] = tokens[i].split("\t");
      let path = rest.join("\t");
      if (path === "") { path = tokens[i + 2] ?? ""; i += 2; }
      if (path) counts.set(path, { added: added === "-" ? null : Number(added), removed: removed === "-" ? null : Number(removed) });
    }
  }
  const tokens = nameStatus.split("\0");
  const entries: NonNullable<TeamRun["changes"]>["files"] = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i];
    if (!code) continue;
    const pairedPath = /^[RC]/.test(code);
    const path = pairedPath ? tokens[i + 2] : tokens[i + 1];
    if (pairedPath) i += 2; else i += 1;
    if (!path) continue;
    const letter = code[0];
    const status = letter === "A" || letter === "C" ? "added" : letter === "D" ? "removed" : letter === "R" ? "renamed" : "modified";
    entries.push({ path, status, ...(counts.get(path) ?? { added: null, removed: null }) });
  }
  return { headCommit, recordedAt: at, files: entries.slice(0, maxRunChangeFiles), truncated: entries.length > maxRunChangeFiles };
}

export function changedPathList(output: string | undefined): TeamTask["changedPaths"] | undefined {
  if (output === undefined) return undefined;
  const paths = output.split("\0").filter(Boolean);
  return { paths: paths.slice(0, maxTaskChangedPaths), truncated: paths.length > maxTaskChangedPaths };
}
