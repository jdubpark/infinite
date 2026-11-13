import type { ActivityStore } from "./types";

export const ACTIVITY_BUCKETS = 30;
export const ACTIVITY_BUCKET_MS = 10_000;

/** Page-observed activity. Starts empty; nothing is fetched or stored beyond this object. */
export function createActivity(): ActivityStore {
  return { record() {}, buckets: () => new Array<number>(ACTIVITY_BUCKETS).fill(0) };
}
