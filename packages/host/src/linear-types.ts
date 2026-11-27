export interface LinearIssueView {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string | null;
  state: { name: string; type: string };
  updatedAt: string;
}

export type LinearTrackingView =
  | { status: "pending"; reason?: string; checkedAt?: string; retryAt?: string; issue?: LinearIssueView }
  | { status: "synced"; issue: LinearIssueView; checkedAt?: string; reason?: never; retryAt?: never }
  | { status: "blocked"; reason: string; checkedAt?: string; retryAt?: string; issue?: LinearIssueView }
  | { status: "error"; reason: string; checkedAt?: string; retryAt?: string; issue?: LinearIssueView };

export interface LinearLimitView {
  limit?: number;
  remaining?: number;
  resetAt?: string;
}

export interface LinearBridgeStatus {
  configured: boolean;
  records: { total: number; gating: number };
  sentLastHour: { requests: number; complexity: number };
  limits?: {
    observedAt: string; operation: string;
    requests?: LinearLimitView; complexity?: LinearLimitView; lastComplexity?: number;
    endpoint?: LinearLimitView & { name?: string; observedAt: string };
  };
  pausedUntil?: string;
  lastRateLimit?: { at: string; operation: string; httpStatus: number; retryAfterSeconds?: number; waitSeconds: number; basis: "retry-after" | "reset" | "fallback"; shared: boolean };
}
