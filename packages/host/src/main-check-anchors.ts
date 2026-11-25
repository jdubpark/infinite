import { z } from "zod";
import type { CensusResult, EarlierProcesses, ProcessIdentity } from "./process-census.js";

export const MAX_ANCHORED = 256;
export type MainCheckAnchor = { version: 1; boot: string; processes: ProcessIdentity[] };

export interface MainCheckAnchors {
  list(): string[];
  read(projectId: string, directory: string): unknown;
  write(projectId: string, directory: string, anchor: MainCheckAnchor): void;
  remove(directory: string): void;
}

export const mainCheckAnchorSchema: z.ZodType<MainCheckAnchor> = z.strictObject({
  version: z.literal(1),
  boot: z.string().min(1).max(200),
  processes: z.array(z.strictObject({ pid: z.number().int().positive(), start: z.string().min(1).max(200) })).min(1).max(MAX_ANCHORED),
});

export async function anchorOf(boot: string, census: CensusResult, start: (pid: number) => Promise<string | undefined>): Promise<MainCheckAnchor | undefined> {
  if (!census.ok) return undefined;
  const processes: ProcessIdentity[] = [];
  for (const finding of census.findings) {
    if (finding.reason !== "unreadable" || processes.length === MAX_ANCHORED) continue;
    let token: string | undefined;
    try { token = await start(finding.pid); } catch { token = undefined; }
    if (token !== undefined) processes.push({ pid: finding.pid, start: token });
  }
  return processes.length === 0 ? undefined : { version: 1, boot, processes };
}

export function readAnchor(anchors: MainCheckAnchors, projectId: string, directory: string): MainCheckAnchor | undefined {
  let value: unknown;
  try { value = anchors.read(projectId, directory); } catch { return undefined; }
  const parsed = mainCheckAnchorSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function earlierFor(entryBoot: string, currentBoot: string, platform: NodeJS.Platform, anchor: MainCheckAnchor | undefined): EarlierProcesses | undefined {
  if (entryBoot !== currentBoot) return platform === "linux" ? "all" : undefined;
  return anchor?.boot === entryBoot ? anchor.processes : undefined;
}
