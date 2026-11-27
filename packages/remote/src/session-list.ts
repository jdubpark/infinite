type Held<T> =
  | { kind: "empty" }
  | { kind: "unversioned"; rows: T[] }
  | { kind: "versioned"; version: string; rows: T[] };

const VERSION = /^[A-Za-z0-9_-]{1,128}$/;

function readAnswer<T>(body: unknown, held: Held<T>): Exclude<Held<T>, { kind: "empty" }> | undefined {
  if (!body || typeof body !== "object") return undefined;
  const { sessions, version, unchanged } = body as { sessions?: unknown; version?: unknown; unchanged?: unknown };
  const named = typeof version === "string" && VERSION.test(version) ? version : undefined;
  if (Array.isArray(sessions)) {
    return named ? { kind: "versioned", version: named, rows: sessions as T[] } : { kind: "unversioned", rows: sessions as T[] };
  }
  return unchanged === true && named !== undefined && held.kind === "versioned" && named === held.version ? held : undefined;
}

export function sessionListReader<T>(): (get: (path: string) => Promise<unknown>) => Promise<T[]> {
  let held: Held<T> = { kind: "empty" };
  let started = 0;
  let kept = 0;
  return async get => {
    const read = ++started;
    const since = held.kind === "versioned" ? held.version : "";
    const answer = await get(`/sessions?since=${since}`);
    const next = readAnswer<T>(answer, held) ?? readAnswer<T>(await get("/sessions"), held);
    if (!next) throw new Error("The machine sent a session list this app cannot read.");
    if (read < kept && held.kind !== "empty") return held.rows;
    held = next;
    kept = read;
    return next.rows;
  };
}
