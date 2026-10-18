export interface LinearIssueView {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string | null;
  state: { name: string; type: string };
  updatedAt: string;
}

/** Linear's workflow state is separate from the local execution status. */
export interface LinearTrackingView {
  status: "pending" | "synced" | "blocked" | "error";
  reason?: string;
  checkedAt?: string;
  issue?: LinearIssueView;
}
