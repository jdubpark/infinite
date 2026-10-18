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
  issue?: LinearIssueView;
}
