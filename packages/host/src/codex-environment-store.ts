import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, normalize, relative, sep } from "node:path";
import { z } from "zod";
import { unseal, writeSealed } from "./vault.js";

export const CODEX_ENVIRONMENT_STATE_FILE = "codex-environments.sealed";
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const ENVIRONMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export interface PersistedCodexSelection {
  environmentId: string;
  cwd: string;
  runtimeWorkspaceRoots: string[];
}

export interface CodexPlacementRecord extends PersistedCodexSelection {
  threadId: string;
  generation: number;
  turnId?: string;
  verifiedAt: string;
}

export type PersistedCodexThreadPlacement =
  | {
      status: "selecting";
      generation: number;
      revision: number;
      target: PersistedCodexSelection;
      previous?: PersistedCodexSelection;
      usedEnvironmentIds: string[];
      turnId?: string;
      updatedAt: string;
    }
  | {
      status: "verified";
      generation: number;
      revision: number;
      placement: PersistedCodexSelection;
      usedEnvironmentIds: string[];
      turnId?: string;
      verifiedAt: string;
      updatedAt: string;
    }
  | {
      status: "uncertain";
      generation: number;
      revision: number;
      expected?: PersistedCodexSelection;
      usedEnvironmentIds: string[];
      reason: string;
      updatedAt: string;
    };

export type ThreadPlacementState =
  | {
      kind: "pending-verification";
      persisted: Extract<PersistedCodexThreadPlacement, { status: "verified" }>;
    }
  | {
      kind: "selecting";
      generation: number;
      revision: number;
      target: PersistedCodexSelection;
      previous?: PersistedCodexSelection;
      used: Set<string>;
      turnId?: string;
      updatedAt: string;
    }
  | {
      kind: "verified";
      placement: CodexPlacementRecord;
      revision: number;
      used: Set<string>;
      updatedAt: string;
    }
  | {
      kind: "uncertain";
      generation: number;
      revision: number;
      expected?: PersistedCodexSelection;
      used: Set<string>;
      reason: string;
      updatedAt: string;
    };

export interface PersistedCodexEnvironmentState {
  version: 1;
  scope: string;
  threads: Record<string, PersistedCodexThreadPlacement>;
}

export type CodexEnvironmentStoreRead =
  | { state: "missing" }
  | { state: "readable"; record: PersistedCodexEnvironmentState }
  | { state: "unreadable"; reason: string };

export interface CodexEnvironmentStore {
  readonly scope: string;
  read(): CodexEnvironmentStoreRead;
  write(record: PersistedCodexEnvironmentState): void;
}

export interface CodexEnvironmentPersistenceOptions {
  file: string;
  key: Buffer;
  scope: string;
}

const normalizedAbsolutePath = z.string().min(1).max(4096).refine(
  value => isAbsolute(value) && normalize(value) === value,
  "Path must be normalized and absolute",
);

const environmentIdSchema = z.string().regex(ENVIRONMENT_ID_RE);

const isoTimestampSchema = z.string().min(1).max(64).refine(
  value => Number.isFinite(Date.parse(value)),
  "Timestamp must be a valid date",
);

const positiveCounterSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

const pathWithinRoots = (cwd: string, roots: string[]): boolean =>
  roots.some(root => {
    const rel = relative(root, cwd);
    return !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  });

const selectionSchema: z.ZodType<PersistedCodexSelection> = z.object({
  environmentId: environmentIdSchema,
  cwd: normalizedAbsolutePath,
  runtimeWorkspaceRoots: z.array(normalizedAbsolutePath).min(1).max(32),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.runtimeWorkspaceRoots).size !== value.runtimeWorkspaceRoots.length) {
    ctx.addIssue({ code: "custom", message: "Workspace roots must be unique" });
  }
  if (!pathWithinRoots(value.cwd, value.runtimeWorkspaceRoots)) {
    ctx.addIssue({ code: "custom", message: "Execution directory must stay within workspace roots" });
  }
});

const usedIdsSchema = z.array(environmentIdSchema).max(4096).refine(
  ids => new Set(ids).size === ids.length,
  "Used environment IDs must be unique",
);

const selectingSchema = z.object({
  status: z.literal("selecting"),
  generation: positiveCounterSchema,
  revision: positiveCounterSchema,
  target: selectionSchema,
  previous: selectionSchema.optional(),
  usedEnvironmentIds: usedIdsSchema,
  turnId: z.string().min(1).max(200).optional(),
  updatedAt: isoTimestampSchema,
}).strict().superRefine((value, ctx) => {
  if (!value.usedEnvironmentIds.includes(value.target.environmentId)) {
    ctx.addIssue({ code: "custom", message: "Target environment ID must be recorded in usedEnvironmentIds" });
  }
  if (value.previous && !value.usedEnvironmentIds.includes(value.previous.environmentId)) {
    ctx.addIssue({ code: "custom", message: "Previous environment ID must be recorded in usedEnvironmentIds" });
  }
});

const verifiedSchema = z.object({
  status: z.literal("verified"),
  generation: positiveCounterSchema,
  revision: positiveCounterSchema,
  placement: selectionSchema,
  usedEnvironmentIds: usedIdsSchema,
  turnId: z.string().min(1).max(200).optional(),
  verifiedAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).strict().superRefine((value, ctx) => {
  if (!value.usedEnvironmentIds.includes(value.placement.environmentId)) {
    ctx.addIssue({ code: "custom", message: "Verified environment ID must be recorded in usedEnvironmentIds" });
  }
});

const uncertainSchema = z.object({
  status: z.literal("uncertain"),
  generation: positiveCounterSchema,
  revision: positiveCounterSchema,
  expected: selectionSchema.optional(),
  usedEnvironmentIds: usedIdsSchema,
  reason: z.string().min(1).max(500),
  updatedAt: isoTimestampSchema,
}).strict().superRefine((value, ctx) => {
  if (value.expected && !value.usedEnvironmentIds.includes(value.expected.environmentId)) {
    ctx.addIssue({ code: "custom", message: "Expected environment ID must be recorded in usedEnvironmentIds" });
  }
});

const threadPlacementSchema: z.ZodType<PersistedCodexThreadPlacement> = z.discriminatedUnion("status", [
  selectingSchema,
  verifiedSchema,
  uncertainSchema,
]);

export const persistedCodexEnvironmentStateSchema: z.ZodType<PersistedCodexEnvironmentState> = z.object({
  version: z.literal(1),
  scope: z.string().min(1).max(200),
  threads: z.record(z.string().min(1).max(200), threadPlacementSchema),
}).strict();

export const cloneSelection = (selection: PersistedCodexSelection): PersistedCodexSelection => ({
  environmentId: selection.environmentId,
  cwd: selection.cwd,
  runtimeWorkspaceRoots: [...selection.runtimeWorkspaceRoots],
});

export const clonePlacement = (placement: CodexPlacementRecord): CodexPlacementRecord => ({
  threadId: placement.threadId,
  environmentId: placement.environmentId,
  cwd: placement.cwd,
  runtimeWorkspaceRoots: [...placement.runtimeWorkspaceRoots],
  generation: placement.generation,
  ...(placement.turnId ? { turnId: placement.turnId } : {}),
  verifiedAt: placement.verifiedAt,
});

export const usedOf = (state: ThreadPlacementState | undefined): Set<string> => {
  if (!state) return new Set<string>();
  if (state.kind === "pending-verification") return new Set(state.persisted.usedEnvironmentIds);
  return new Set(state.used);
};

export const activeSelectionOf = (state: ThreadPlacementState | undefined): PersistedCodexSelection | undefined => {
  if (!state) return undefined;
  if (state.kind === "verified") {
    return {
      environmentId: state.placement.environmentId,
      cwd: state.placement.cwd,
      runtimeWorkspaceRoots: [...state.placement.runtimeWorkspaceRoots],
    };
  }
  if (state.kind === "pending-verification") return cloneSelection(state.persisted.placement);
  if (state.kind === "selecting") return cloneSelection(state.target);
  return state.expected ? cloneSelection(state.expected) : undefined;
};

export const generationOf = (state: ThreadPlacementState | undefined): number => {
  if (!state) return 0;
  if (state.kind === "verified") return state.placement.generation;
  if (state.kind === "pending-verification") return state.persisted.generation;
  return state.generation;
};

export const revisionOf = (state: ThreadPlacementState | undefined): number => {
  if (!state) return 0;
  if (state.kind === "pending-verification") return state.persisted.revision;
  return state.revision;
};

export function hydrateThreadPlacements(record: PersistedCodexEnvironmentState): Map<string, ThreadPlacementState> {
  const map = new Map<string, ThreadPlacementState>();
  for (const [threadId, entry] of Object.entries(record.threads)) {
    if (entry.status === "verified") {
      map.set(threadId, { kind: "pending-verification", persisted: entry });
    } else if (entry.status === "selecting") {
      map.set(threadId, {
        kind: "uncertain",
        generation: entry.generation,
        revision: entry.revision,
        expected: cloneSelection(entry.target),
        used: new Set(entry.usedEnvironmentIds),
        reason: "An earlier execution environment selection did not finish before restart; reconcile before dispatching tools",
        updatedAt: entry.updatedAt,
      });
    } else {
      map.set(threadId, {
        kind: "uncertain",
        generation: entry.generation,
        revision: entry.revision,
        ...(entry.expected ? { expected: cloneSelection(entry.expected) } : {}),
        used: new Set(entry.usedEnvironmentIds),
        reason: entry.reason,
        updatedAt: entry.updatedAt,
      });
    }
  }
  return map;
}

export function serializeThreadPlacements(
  scope: string,
  placements: Map<string, ThreadPlacementState>,
): PersistedCodexEnvironmentState {
  const threads: Record<string, PersistedCodexThreadPlacement> = {};
  for (const [threadId, state] of placements) {
    if (state.kind === "pending-verification") {
      threads[threadId] = state.persisted;
    } else if (state.kind === "selecting") {
      threads[threadId] = {
        status: "selecting",
        generation: state.generation,
        revision: state.revision,
        target: cloneSelection(state.target),
        ...(state.previous ? { previous: cloneSelection(state.previous) } : {}),
        usedEnvironmentIds: [...state.used],
        ...(state.turnId ? { turnId: state.turnId } : {}),
        updatedAt: state.updatedAt,
      };
    } else if (state.kind === "verified") {
      threads[threadId] = {
        status: "verified",
        generation: state.placement.generation,
        revision: state.revision,
        placement: {
          environmentId: state.placement.environmentId,
          cwd: state.placement.cwd,
          runtimeWorkspaceRoots: [...state.placement.runtimeWorkspaceRoots],
        },
        usedEnvironmentIds: [...state.used],
        ...(state.placement.turnId ? { turnId: state.placement.turnId } : {}),
        verifiedAt: state.placement.verifiedAt,
        updatedAt: state.updatedAt,
      };
    } else {
      threads[threadId] = {
        status: "uncertain",
        generation: state.generation,
        revision: state.revision,
        ...(state.expected ? { expected: cloneSelection(state.expected) } : {}),
        usedEnvironmentIds: [...state.used],
        reason: state.reason,
        updatedAt: state.updatedAt,
      };
    }
  }
  return { version: 1, scope, threads };
}

export function openCodexEnvironmentStore(options: CodexEnvironmentPersistenceOptions): CodexEnvironmentStore {
  if (!options.scope || options.scope.length > 200) {
    throw new Error("Codex environment persistence scope must be a non-empty bounded string");
  }
  return {
    scope: options.scope,
    read(): CodexEnvironmentStoreRead {
      let info;
      try {
        info = lstatSync(options.file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
        return { state: "unreadable", reason: "Persisted execution environment state could not be inspected" };
      }
      if (!info.isFile() || info.size > MAX_STATE_BYTES || (info.mode & 0o077) !== 0) {
        return { state: "unreadable", reason: "Persisted execution environment state failed file safety checks" };
      }
      let raw: string;
      try {
        raw = readFileSync(options.file, "utf8");
      } catch {
        return { state: "unreadable", reason: "Persisted execution environment state could not be read" };
      }
      try {
        const unsealed = unseal<unknown>(options.key, options.scope, raw);
        const parsed = persistedCodexEnvironmentStateSchema.safeParse(unsealed);
        if (!parsed.success || parsed.data.scope !== options.scope) {
          return { state: "unreadable", reason: "Persisted execution environment state is invalid or mismatched" };
        }
        return { state: "readable", record: parsed.data };
      } catch {
        return { state: "unreadable", reason: "Persisted execution environment state could not be decrypted or verified" };
      }
    },
    write(record: PersistedCodexEnvironmentState): void {
      const parsed = persistedCodexEnvironmentStateSchema.safeParse(record);
      if (!parsed.success || parsed.data.scope !== options.scope) {
        throw new Error("Refusing to persist invalid Codex execution environment state");
      }
      writeSealed(options.file, options.key, options.scope, parsed.data);
    },
  };
}
