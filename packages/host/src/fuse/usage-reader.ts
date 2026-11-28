import type { FuseSpendReader, FuseSpendSample } from "./types.js";

export type SpendWindowSource = {
  spendWindow(input: { scope: "host" | "project"; projectId?: string; sinceMs: number; now: number }): FuseSpendSample;
};

export function createFuseSpendReader(usage: SpendWindowSource | (() => SpendWindowSource | undefined)): FuseSpendReader {
  return ({ scope, projectId, sinceMs, now }) => {
    try {
      const source = typeof usage === "function" ? usage() : usage;
      if (!source) return { tokens: 0, listUsd: 0, spentUsd: 0, unmeasuredSessions: 0, available: false };
      return source.spendWindow({ scope, ...(projectId === undefined ? {} : { projectId }), sinceMs, now });
    } catch {
      return { tokens: 0, listUsd: 0, spentUsd: 0, unmeasuredSessions: 0, available: false };
    }
  };
}
