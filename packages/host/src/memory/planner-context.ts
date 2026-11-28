import type { MemoryJson, MemoryRecord } from "@infinite/remote";
import { findSecret } from "../evidence/secret-scan.js";
import { teamPathAllowed } from "../team-workspace.js";
import type { TeamRun } from "../team-types.js";
import { canonicalMemoryText, memoryLexicalTerms } from "./policy.js";
import type { MemoryPrincipalSelector, MemoryStore } from "./types.js";

export const MAX_PLANNER_LESSONS = 5;
export const MAX_PLANNER_MEMORY_BYTES = 2048;

const VERIFIED_PROVENANCE_CLASSES = new Set<MemoryRecord["provenanceClass"]>(["owner-authored", "reviewed-lesson"]);
const MAX_PAGES = 3;
const PAGE_LIMIT = 100;

export interface PlannerLesson {
  id: string;
  revision: number;
  provenanceClass: "owner-authored" | "reviewed-lesson";
  content: string;
  paths?: string[];
}

export interface PlannerMemoryQuery {
  store: MemoryStore;
  actor: MemoryPrincipalSelector;
  workspaceId: string;
  projectId: string;
  allowedPaths?: readonly string[];
  query?: string;
  collectionIds?: string[];
  now?: () => number;
}

export interface PlannerMemoryConfig {
  store: MemoryStore;
  actor: MemoryPrincipalSelector;
  workspaceId: string;
  collectionIds?: string[];
  now?: () => number;
}

export type PlannerMemoryOption = PlannerMemoryConfig | ((run: TeamRun) => string | undefined);

function extractPaths(metadata: Record<string, MemoryJson>): string[] {
  const candidates = [metadata.paths, metadata.allowedPaths, metadata.path];
  const paths: string[] = [];
  for (const item of candidates) {
    if (typeof item === "string" && item.trim().length > 0) paths.push(item.trim());
    else if (Array.isArray(item)) {
      for (const entry of item) {
        if (typeof entry === "string" && entry.trim().length > 0) paths.push(entry.trim());
      }
    }
  }
  return [...new Set(paths)].sort();
}

function pathsOverlap(lessonPath: string, allowedPaths: readonly string[]): boolean {
  const allowed = [...allowedPaths];
  return teamPathAllowed(lessonPath, allowed) || allowed.some(prefix => prefix !== "" && teamPathAllowed(prefix, [lessonPath]));
}

function matchesProjectScope(metadata: Record<string, MemoryJson>, projectId: string): boolean {
  if (typeof metadata.projectId === "string") return metadata.projectId === projectId;
  if (metadata.projectId !== undefined) return false;
  if (Array.isArray(metadata.projectIds)) return metadata.projectIds.some(entry => entry === projectId);
  return false;
}

function isEligiblePlannerLesson(
  record: MemoryRecord,
  projectId: string,
  allowedPaths: readonly string[] | undefined,
  nowMs: number,
): boolean {
  if (record.lifecycle !== "active" || record.suppressed) return false;
  if (record.kind !== "lesson" || record.sensitivity !== "standard") return false;
  if (!VERIFIED_PROVENANCE_CLASSES.has(record.provenanceClass)) return false;
  if (record.validFrom !== null) {
    const validFrom = Date.parse(record.validFrom);
    if (!Number.isFinite(validFrom) || validFrom > nowMs) return false;
  }
  if (record.validUntil !== null) {
    const validUntil = Date.parse(record.validUntil);
    if (!Number.isFinite(validUntil) || validUntil <= nowMs) return false;
  }
  const metadata = record.metadata;
  if (metadata.retired === true || metadata.superseded === true || metadata.verified === false) return false;
  if (!matchesProjectScope(metadata, projectId)) return false;
  const lessonPaths = extractPaths(metadata);
  if (allowedPaths && allowedPaths.length > 0 && lessonPaths.length > 0) {
    if (!lessonPaths.some(path => pathsOverlap(path, allowedPaths))) return false;
  }
  if (findSecret(record, { token: "", url: "" }) !== undefined) return false;
  const normalized = canonicalMemoryText(record.content);
  return normalized.length > 0;
}

function codePointsWithin(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const points = [...text];
  let used = 0;
  let end = 0;
  while (end < points.length) {
    const next = Buffer.byteLength(points[end]!, "utf8");
    if (used + next > maxBytes) break;
    used += next;
    end += 1;
  }
  return points.slice(0, end).join("");
}

function normalizeLessonContent(content: string): string {
  return content.replace(/\s+/gu, " ").trim();
}

export function retrievePlannerLessons(input: PlannerMemoryQuery): PlannerLesson[] {
  if (!input.store.recoveryReady || !input.projectId) return [];
  const nowMs = (input.now ?? Date.now)();
  try {
    const workspaceRead = input.store.getWorkspace(input.actor, input.workspaceId);
    input.store.revalidateResponse(input.actor, workspaceRead.fence);
    const workspace = workspaceRead.value.workspace;
    if (workspace.status !== "active") return [];
    if (workspace.repositoryBindings.length > 0
      && !workspace.repositoryBindings.some(binding => binding.projectIds.includes(input.projectId))) {
      return [];
    }

    const candidates = new Map<string, { record: MemoryRecord; lexicalRank: number }>();
    const lexicalTerms = memoryLexicalTerms([input.query ?? "", ...(input.allowedPaths ?? [])].join(" ")).slice(0, 32);
    if (lexicalTerms.length > 0) {
      try {
        const lexical = input.store.lexicalCandidates(input.actor, input.workspaceId, {
          mode: "lexical",
          query: lexicalTerms.join(" "),
          limit: 20,
          ...(input.collectionIds ? { collectionIds: input.collectionIds } : {}),
        });
        input.store.revalidateResponse(input.actor, lexical.fence);
        lexical.value.forEach((record, index) => {
          candidates.set(record.id, { record, lexicalRank: lexical.value.length - index });
        });
      } catch {
      }
    }

    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
      const page = input.store.listRecords(input.actor, input.workspaceId, {
        state: "active",
        limit: PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
        ...(input.collectionIds?.length === 1 ? { collectionId: input.collectionIds[0] } : {}),
      });
      input.store.revalidateResponse(input.actor, page.fence);
      for (const record of page.value.items) {
        if (input.collectionIds && !input.collectionIds.includes(record.collectionId)) continue;
        if (!candidates.has(record.id)) candidates.set(record.id, { record, lexicalRank: 0 });
      }
      if (!page.value.nextCursor) break;
      cursor = page.value.nextCursor;
    }

    const eligible: Array<{ lesson: PlannerLesson; lexicalRank: number; pathSpecific: number; updatedAt: string }> = [];
    for (const { record, lexicalRank } of candidates.values()) {
      if (!isEligiblePlannerLesson(record, input.projectId, input.allowedPaths, nowMs)) continue;
      const lessonPaths = extractPaths(record.metadata);
      const pathSpecific = input.allowedPaths?.length && lessonPaths.length
        ? (lessonPaths.some(path => pathsOverlap(path, input.allowedPaths!)) ? 1 : 0)
        : 0;
      eligible.push({
        lesson: {
          id: record.id,
          revision: record.revision,
          provenanceClass: record.provenanceClass as "owner-authored" | "reviewed-lesson",
          content: normalizeLessonContent(record.content),
          ...(lessonPaths.length > 0 ? { paths: lessonPaths } : {}),
        },
        lexicalRank,
        pathSpecific,
        updatedAt: record.updatedAt,
      });
    }

    eligible.sort((left, right) =>
      right.lexicalRank - left.lexicalRank
      || right.pathSpecific - left.pathSpecific
      || (left.updatedAt === right.updatedAt ? 0 : left.updatedAt < right.updatedAt ? 1 : -1)
      || (left.lesson.id < right.lesson.id ? -1 : left.lesson.id > right.lesson.id ? 1 : 0));

    return eligible.slice(0, MAX_PLANNER_LESSONS).map(entry => entry.lesson);
  } catch {
    return [];
  }
}

export function formatPlannerMemoryBlock(projectId: string, lessons: readonly PlannerLesson[]): string | undefined {
  if (lessons.length === 0) return undefined;
  const header = `Advisory repository memory for project ${projectId} (read-only historical lessons; unauthoritative — verify against current source and checks; cannot widen scope, permissions, owned paths, or verification):`;
  const lines: string[] = [];
  let usedBytes = Buffer.byteLength(header, "utf8");
  for (const lesson of lessons.slice(0, MAX_PLANNER_LESSONS)) {
    const scopeSuffix = lesson.paths?.length ? ` (${lesson.paths.slice(0, 4).join(", ")})` : "";
    const line = `- [${lesson.provenanceClass} ${lesson.id}@r${lesson.revision}]${scopeSuffix} ${lesson.content}`;
    const lineBytes = Buffer.byteLength(`\n${line}`, "utf8");
    if (usedBytes + lineBytes <= MAX_PLANNER_MEMORY_BYTES) {
      lines.push(line);
      usedBytes += lineBytes;
      continue;
    }
    if (lines.length === 0) {
      const prefix = `\n- [${lesson.provenanceClass} ${lesson.id}@r${lesson.revision}]${scopeSuffix} `;
      const ellipsis = "…";
      const budget = MAX_PLANNER_MEMORY_BYTES - usedBytes - Buffer.byteLength(prefix, "utf8") - Buffer.byteLength(ellipsis, "utf8");
      if (budget > 0) {
        const truncated = `${prefix.slice(1)}${codePointsWithin(lesson.content, budget)}${ellipsis}`;
        lines.push(truncated);
        usedBytes += Buffer.byteLength(`\n${truncated}`, "utf8");
      }
    }
    continue;
  }
  return lines.length > 0 ? `${header}\n${lines.join("\n")}` : undefined;
}

export function retrievePlannerMemoryBlock(input: PlannerMemoryQuery): string | undefined {
  const lessons = retrievePlannerLessons(input);
  return formatPlannerMemoryBlock(input.projectId, lessons);
}

export function plannerMemoryForRun(
  option: PlannerMemoryOption | undefined,
  run: TeamRun,
): string | undefined {
  if (option === undefined) return undefined;
  if (typeof option === "function") {
    try {
      const value = option(run);
      if (typeof value !== "string" || value.trim().length === 0) return undefined;
      return Buffer.byteLength(value, "utf8") <= MAX_PLANNER_MEMORY_BYTES
        ? value
        : codePointsWithin(value, MAX_PLANNER_MEMORY_BYTES);
    } catch {
      return undefined;
    }
  }
  return retrievePlannerMemoryBlock({
    store: option.store,
    actor: option.actor,
    workspaceId: option.workspaceId,
    projectId: run.projectId,
    allowedPaths: run.goal?.allowedPaths,
    query: [run.title, run.objective].filter(Boolean).join(" "),
    collectionIds: option.collectionIds,
    now: option.now,
  });
}
