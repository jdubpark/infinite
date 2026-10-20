type LiveOptions<T> = {
  topics: string[];
  intervalMs: number;
  deps: unknown[];
  load(): Promise<T>;
  select(topic: string, payload: unknown, previous: T | null): T | undefined;
  after?: () => number;
  continuePolling?: (data: T | null) => boolean;
};
type Page = { events: { type: string; seq?: number; data?: unknown }[]; cursor: number; more: boolean };

let activePage = -1;
let firstSequenceRead = false;
let calls = 0;
let secondAfter = "";
let captured: LiveOptions<unknown> | undefined;

const firstSignal = {
  type: "signal",
  get seq() {
    if (!firstSequenceRead) {
      firstSequenceRead = true;
      if (activePage !== 0) throw new Error("signal page was retained until after the next cursor request");
    }
    return 1;
  },
};

const pages: Page[] = [
  { events: [firstSignal], cursor: 1, more: true },
  { events: [{ type: "signal", seq: 2 }], cursor: 2, more: false },
];

export function useRef<T>(initial: T) {
  return { current: initial };
}

export function useLive<T>(_connection: unknown, options: LiveOptions<T>) {
  captured = options;
  return { data: null as T | null, loading: true };
}

export async function api<T>(_connection: unknown, path: string): Promise<T> {
  if (calls === 1) secondAfter = new URLSearchParams(path.split("?")[1]).get("after") ?? "";
  activePage = calls++;
  const page = pages[activePage];
  if (!page) throw new Error("unexpected extra page request");
  return page as T;
}

export function loadCaptured() {
  if (!captured) throw new Error("signal loader was not registered");
  return captured.load();
}

export const signalRead = () => ({ calls, firstSequenceRead, secondAfter });
