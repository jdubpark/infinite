import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ANCHORED, type MainCheckAnchors } from "../packages/host/src/main-check-anchors.js";
import { bootId, hostProcesses } from "../packages/host/src/process-census.js";

export async function earlierProcesses(): Promise<Map<number, string>> {
  const earlier = new Map<number, string>();
  const look = await hostProcesses.census({ boot: bootId(), processes: [], sessions: [], groups: [] }, join(tmpdir(), `main-check-no-such-directory-${process.pid}`));
  if (!look.ok) return earlier;
  for (const finding of look.findings) {
    if (finding.reason !== "unreadable") continue;
    const start = await hostProcesses.start(finding.pid).catch(() => undefined);
    if (start !== undefined) earlier.set(finding.pid, start);
  }
  return earlier;
}

export async function anchorSeeded(anchors: MainCheckAnchors, projectId: string, directory: string): Promise<number> {
  const processes = [...await earlierProcesses()].map(([pid, start]) => ({ pid, start })).slice(0, MAX_ANCHORED);
  if (processes.length > 0) anchors.write(projectId, directory, { version: 1, boot: bootId(), processes });
  return processes.length;
}
