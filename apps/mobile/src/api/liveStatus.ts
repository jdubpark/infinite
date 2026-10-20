export const LIVE_STALE_DELAY_MS = 3000;

export function isLiveOnline(streamUp: boolean, lastLoadOk: boolean): boolean {
  return streamUp || lastLoadOk;
}

export function canUseLiveFallback<T>(data: T | null, continuePolling?: (data: T | null) => boolean): boolean {
  return continuePolling ? continuePolling(data) : true;
}

/** Only a stream snapshot that replaces the data fences off an in-flight load; reload requests coalesce instead. */
export function invalidatesLiveLoad<T>(next: T | undefined, current: T | null): boolean {
  return next !== undefined && next !== current;
}

export function shouldRetryEmptyLiveLoad(discarded: boolean, data: unknown): boolean {
  return discarded && data === null;
}

export function shouldMarkLiveStale(offlineSince: number | null, now: number): boolean {
  return offlineSince !== null && now - offlineSince >= LIVE_STALE_DELAY_MS;
}
