export const LIVE_STALE_DELAY_MS = 3000;

export function shouldMarkLiveStale(offlineSince: number | null, now: number): boolean {
  return offlineSince !== null && now - offlineSince >= LIVE_STALE_DELAY_MS;
}
