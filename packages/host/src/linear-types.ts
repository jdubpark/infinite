export interface LinearIssueView {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string | null;
  state: { name: string; type: string };
  updatedAt: string;
}

/** Present only for a run opted into tracking at creation or with a saved link.
 * Linear workflow state stays separate from local execution status.
 */
export interface LinearTrackingView {
  status: "pending" | "synced" | "blocked" | "error";
  reason?: string;
  checkedAt?: string;
  /** Set while a Linear rate limit pauses the host's requests and this item waits: when tracking retries. */
  retryAt?: string;
  issue?: LinearIssueView;
}

/** One Linear rate limit as its last response headers stated it. */
export interface LinearLimitView {
  limit?: number;
  remaining?: number;
  resetAt?: string;
}

/** The bridge's own request budget evidence. Holds no credential and no issue content. */
export interface LinearBridgeStatus {
  configured: boolean;
  records: { total: number; gating: number };
  /** Requests this host sent, and the complexity Linear reported for them, over the last 60 minutes. */
  sentLastHour: { requests: number; complexity: number };
  limits?: {
    observedAt: string; operation: string;
    requests?: LinearLimitView; complexity?: LinearLimitView; lastComplexity?: number;
    endpoint?: LinearLimitView & { name?: string; observedAt: string };
  };
  pausedUntil?: string;
  lastRateLimit?: { at: string; operation: string; httpStatus: number; retryAfterSeconds?: number; waitSeconds: number; shared: boolean };
}
